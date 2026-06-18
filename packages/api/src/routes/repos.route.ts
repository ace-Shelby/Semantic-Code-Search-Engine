import { Hono, type Context } from "hono";
import { z } from "zod";
import type { IngestionJob } from "@codesearch/shared";

import { qdrant, redis } from "../clients.ts";
import { requireBearerToken } from "../middleware/auth.ts";
import {
  isQdrantConnectionError,
  QdrantService,
} from "../services/qdrant.service.ts";

const ingestRequestSchema = z.object({
  githubUrl: z.string().min(1).superRefine((value, ctx) => {
    try {
      parseGitHubRepoUrl(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Invalid GitHub repository URL",
      });
    }
  }),
});

const repoIdParamSchema = z.string().length(16);

type IngestRequestBody = z.infer<typeof ingestRequestSchema>;

interface ValidationErrorResponse {
  error: "VALIDATION_ERROR";
  message: string;
  traceId: string;
  fieldErrors: z.typeToFlattenedError<IngestRequestBody>["fieldErrors"];
  formErrors: string[];
}

interface RouteErrorResponse {
  error: string;
  message: string;
  traceId: string;
}

interface RepoSummary {
  repoId: string;
  repoUrl: string;
  status: IngestionJob["status"];
  totalChunks: number;
  createdAt: string;
}

export const reposRouter = new Hono();

const qdrantService = new QdrantService(qdrant);

reposRouter.get("/", async (c) => {
  const keys = await scanKeys("repo:*:status");
  const values = keys.length > 0 ? await redis.mget(...keys) : [];

  const repos = values
    .flatMap((value) => {
      if (!value) {
        return [];
      }

      try {
        return toRepoSummary(JSON.parse(value) as Partial<IngestionJob>);
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return c.json({ repos }, 200);
});

reposRouter.post("/ingest", requireBearerToken(), async (c) => {
  const traceId = crypto.randomUUID();

  try {
    const parsed = ingestRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(toValidationError(parsed.error, traceId), 422);
    }

    const { canonicalUrl } = parseGitHubRepoUrl(parsed.data.githubUrl);
    const repoId = await createRepoId(canonicalUrl);
    const now = new Date().toISOString();
    const job: IngestionJob = {
      id: crypto.randomUUID(),
      repoUrl: canonicalUrl,
      repoId,
      status: "pending",
      progress: 0,
      totalChunks: 0,
      processedChunks: 0,
      createdAt: now,
      updatedAt: now,
    };

    await saveRepoStatus(job);
    await redis.lpush("ingestion:queue", JSON.stringify({
      jobId: job.id,
      repoId,
      githubUrl: canonicalUrl,
      queuedAt: now,
    }));

    runIngestionInBackground(job);

    return c.json(
      {
        jobId: job.id,
        repoId,
        status: job.status,
        traceId,
      },
      202,
    );
  } catch (err) {
    const body: RouteErrorResponse = {
      error: "INTERNAL_SERVER_ERROR",
      message: err instanceof Error ? err.message : "Failed to queue ingestion job",
      traceId,
    };

    return c.json(body, 500);
  }
});

reposRouter.get("/:repoId/status", async (c) => {
  const traceId = crypto.randomUUID();
  const repoId = c.req.param("repoId");
  const parsed = repoIdParamSchema.safeParse(repoId);

  if (!parsed.success) {
    const body: RouteErrorResponse = {
      error: "VALIDATION_ERROR",
      message: "repoId must be exactly 16 characters",
      traceId,
    };
    return c.json(body, 422);
  }

  const value = await redis.get(repoStatusKey(repoId));
  if (!value) {
    const body: RouteErrorResponse = {
      error: "REPO_NOT_FOUND",
      message: `Repository "${repoId}" was not found`,
      traceId,
    };
    return c.json(body, 404);
  }

  return c.json(JSON.parse(value) as IngestionJob, 200);
});

reposRouter.delete("/:repoId", requireBearerToken(), async (c) => {
  const traceId = crypto.randomUUID();
  const repoId = c.req.param("repoId");
  const parsed = repoIdParamSchema.safeParse(repoId);

  if (!parsed.success) {
    const body: RouteErrorResponse = {
      error: "VALIDATION_ERROR",
      message: "repoId must be exactly 16 characters",
      traceId,
    };
    return c.json(body, 422);
  }

  try {
    await qdrantService.deleteCollection(repoId);

    const keys = await scanKeys(`repo:${repoId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    return c.json({ deleted: true }, 200);
  } catch (err) {
    if (isQdrantConnectionError(err)) {
      const body: RouteErrorResponse = {
        error: "SEARCH_SERVICE_UNAVAILABLE",
        message: "Search service unavailable",
        traceId,
      };
      return c.json(body, 503);
    }

    const body: RouteErrorResponse = {
      error: "INTERNAL_SERVER_ERROR",
      message: err instanceof Error ? err.message : "Failed to delete repository",
      traceId,
    };
    return c.json(body, 500);
  }
});

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function toValidationError(
  error: z.ZodError<IngestRequestBody>,
  traceId: string,
): ValidationErrorResponse {
  const flattened = error.flatten();
  return {
    error: "VALIDATION_ERROR",
    message: "Invalid ingestion request",
    traceId,
    fieldErrors: flattened.fieldErrors,
    formErrors: flattened.formErrors,
  };
}

function parseGitHubRepoUrl(input: string): {
  owner: string;
  repo: string;
  canonicalUrl: string;
} {
  const normalized = input.trim().startsWith("github.com/")
    ? `https://${input.trim()}`
    : input.trim();

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("githubUrl must be a valid GitHub repository URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("githubUrl must use http or https");
  }

  if (url.hostname !== "github.com") {
    throw new Error("githubUrl must point to github.com");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("githubUrl must include an owner and repository name");
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new Error("githubUrl must include an owner and repository name");
  }

  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

async function createRepoId(githubUrl: string): Promise<string> {
  const encoded = new TextEncoder().encode(githubUrl.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}

async function saveRepoStatus(job: IngestionJob): Promise<void> {
  await redis.set(repoStatusKey(job.repoId), JSON.stringify(job));
}

function repoStatusKey(repoId: string): string {
  return `repo:${repoId}:status`;
}

function toRepoSummary(job: Partial<IngestionJob>): RepoSummary[] {
  if (
    !job.repoId ||
    !job.repoUrl ||
    !job.status ||
    typeof job.totalChunks !== "number" ||
    !job.createdAt
  ) {
    return [];
  }

  return [{
    repoId: job.repoId,
    repoUrl: job.repoUrl,
    status: job.status,
    totalChunks: job.totalChunks,
    createdAt: job.createdAt,
  }];
}

function runIngestionInBackground(job: IngestionJob): void {
  void (async () => {
    try {
      const ingestionPackageName = "@codesearch/ingestion";
      const { runGitHubIngestion } = await import(ingestionPackageName) as {
        runGitHubIngestion(
          githubUrl: string,
          repoId: string,
          options: {
            jobId: string;
            redisClient: typeof redis;
            onProgress: (job: IngestionJob) => Promise<void>;
          },
        ): Promise<IngestionJob>;
      };
      const result = await runGitHubIngestion(job.repoUrl, job.repoId, {
        jobId: job.id,
        redisClient: redis,
        onProgress: saveRepoStatus,
      });

      await saveRepoStatus({
        ...result,
        id: job.id,
        repoUrl: job.repoUrl,
      });
    } catch (err) {
      await saveRepoStatus({
        ...job,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });

      console.error(`Background ingestion failed for repo "${job.repoId}":`, err);
    }
  })();
}
