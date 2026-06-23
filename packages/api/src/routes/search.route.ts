import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChunkPayload, SearchResponse, SearchResult } from "@codesearch/shared";

import { qdrant, QDRANT_URL, redis } from "../clients.ts";
import {
  HybridSearchService,
  type BM25Indexer,
  type BM25Result,
} from "../search/hybrid-search.service.ts";
import { VectorSearchService } from "../search/vector-search.service.ts";
import {
  isQdrantConnectionError,
  QdrantService,
} from "../services/qdrant.service.ts";
import { observability } from "../clients.ts";

const searchRequestSchema = z.object({
  query: z.string().min(2).max(500),
  repoId: z.string().length(16),
  topK: z.number().int().min(1).max(20).default(8),
  mode: z.enum(["hybrid", "vector", "keyword"]).default("hybrid"),
});

type SearchRequestBody = z.infer<typeof searchRequestSchema>;

interface ValidationErrorResponse {
  error: "VALIDATION_ERROR";
  message: string;
  traceId: string;
  fieldErrors: z.typeToFlattenedError<SearchRequestBody>["fieldErrors"];
  formErrors: string[];
}

interface RouteErrorResponse {
  error: string;
  message: string;
  traceId: string;
}

class RedisBM25Indexer implements BM25Indexer {
  async search(repoId: string, query: string, topK: number): Promise<BM25Result[]> {
    const limit = Math.max(Math.floor(topK), 0);
    if (limit === 0 || query.trim().length === 0) {
      return [];
    }

    const [serializedIndex, serializedChunks] = await Promise.all([
      redis.get(`repo:${repoId}:bm25`),
      redis.get(`repo:${repoId}:bm25:chunks`),
    ]);

    if (!serializedIndex || !serializedChunks) {
      return [];
    }

    const bm25ModuleName = "wink-bm25-text-search";
    const bm25Module = await import(bm25ModuleName) as {
      default: () => {
        importJSON(serialized: string): void;
        search(query: string, limit: number): Array<[string, number]>;
      };
    };

    const engine = bm25Module.default();
    engine.defineConfig({ fldWeights: { content: 1.0, filePath: 0.5, symbolName: 4.0 } });
    engine.definePrepTasks([
      function tokenizeCodeText(input: string): string[] {
        return input
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(
            (token) =>
              token.length >= 2 &&
              !new Set([
                "const", "let", "var", "return", "function", "import", "export", "from",
                "class", "interface", "type", "async", "await",
              ]).has(token)
          );
      },
    ]);
    engine.importJSON(serializedIndex);

    const chunkLookup = JSON.parse(serializedChunks) as Record<string, ChunkPayload>;
    const hits = engine
      .search(query, limit + 3)
      .filter(([id]) => !id.startsWith("__bm25_internal_filler__"))
      .slice(0, limit);

    if (hits.length === 0) {
      return [];
    }

    const maxScore = Math.max(...hits.map(([, score]) => score));
    return hits.flatMap(([id, rawScore]) => {
      const payload = chunkLookup[id];
      if (!payload) {
        return [];
      }

      return {
        id,
        score: maxScore > 0 ? rawScore / maxScore : 0,
        payload,
      };
    });
  }
}

export const searchRouter = new Hono();

const qdrantService = new QdrantService(qdrant);
const vectorSearchService = new VectorSearchService({
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL,
  qdrantUrl: QDRANT_URL,
  redisClient: redis,
  qdrantService,
});
const bm25Indexer = new RedisBM25Indexer();
const hybridSearchService = new HybridSearchService(
  vectorSearchService,
  bm25Indexer,
  redis,
);

searchRouter.post("/", async (c) => {
  const traceId = crypto.randomUUID();
  const startMs = performance.now();
  let trace: ReturnType<typeof observability.createTrace> | undefined;

  try {
    const parsed = searchRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      const body: ValidationErrorResponse = {
        error: "VALIDATION_ERROR",
        message: "Invalid search request",
        traceId,
        fieldErrors: flattened.fieldErrors,
        formErrors: flattened.formErrors,
      };

      return c.json(body, 422);
    }

    const request = parsed.data;

    trace = observability.createTrace({
      traceId,
      name: "search",
      tags: ["search", request.repoId, request.query.slice(0, 50)],
    });

    const exists = await qdrantService.collectionExists(request.repoId);
    if (!exists) {
      const body: RouteErrorResponse = {
        error: "REPO_NOT_FOUND",
        message: `Repository "${request.repoId}" has not been indexed`,
        traceId,
      };

      return c.json(body, 404);
    }

    const searchResults = await hybridSearchService.search({
      ...request,
      trace,
    });
    const latencyMs = Math.round(performance.now() - startMs);

    trace.end({ latencyMs, resultCount: searchResults.length });

    const response: SearchResponse = {
      results: searchResults.map(toSearchResult),
      latencyMs,
      traceId,
    };

    c.header("X-Trace-Id", traceId);
    return c.json(response, 200);
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    if (isQdrantConnectionError(err)) {
      const errorMessage = "Search service unavailable";
      trace?.end({ error: errorMessage, latencyMs: Math.round(performance.now() - startMs) });

      const body: RouteErrorResponse = {
        error: "SEARCH_SERVICE_UNAVAILABLE",
        message: errorMessage,
        traceId,
      };

      return c.json(body, 503);
    }

    let errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
    let statusCode = 500;

    if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
      errorMessage = "You have exceeded the Google Gemini API rate limit. Please wait a minute and try again.";
      statusCode = 429;
    }

    trace?.end({ error: errorMessage, latencyMs: Math.round(performance.now() - startMs) });

    const body: RouteErrorResponse = {
      error: statusCode === 429 ? "RATE_LIMIT_EXCEEDED" : "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      traceId,
    };

    return c.json(body, statusCode as any);
  }
});

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function toSearchResult(result: SearchResult): SearchResult {
  return {
    id: result.id,
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    snippet: result.snippet,
    score: result.score,
    language: result.language,
    symbolName: result.symbolName,
  };
}
