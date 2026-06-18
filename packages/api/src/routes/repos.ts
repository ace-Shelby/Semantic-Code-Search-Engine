/**
 * @codesearch/api — routes/repos.ts
 * ───────────────────────────────────────────────────────────────
 * Repository management endpoints.
 *
 *   POST /              — Trigger ingestion of a new repository
 *   GET  /              — List all ingested repositories
 *   GET  /:repoId       — Get status of a specific repo / ingestion job
 *   DELETE /:repoId     — Remove a repo and its vectors from Qdrant
 *
 * Dependencies: hono, @codesearch/shared
 */

import { Hono } from "hono";
import type { IngestionJob, ApiError } from "@codesearch/shared";

export const reposRouter = new Hono();

// POST / — trigger ingestion of a GitHub repo
reposRouter.post("/", async (c) => {
  const body = await c.req.json<{ repoUrl: string }>();

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    const error: ApiError = {
      error: "VALIDATION_ERROR",
      message: "repoUrl is required and must be a string",
      traceId: crypto.randomUUID(),
    };
    return c.json(error, 400);
  }

  // Derive a canonical repoId from the URL
  const repoId = body.repoUrl
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const job: IngestionJob = {
    id: crypto.randomUUID(),
    repoUrl: body.repoUrl,
    repoId,
    status: "pending",
    progress: 0,
    totalChunks: 0,
    processedChunks: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // In the full implementation this would enqueue the job
  // to a background worker via Redis pub/sub or BullMQ.
  return c.json(job, 202);
});

// GET / — list all repos
reposRouter.get("/", async (c) => {
  // In the full implementation this would query Redis or a DB
  // for all tracked repositories and their ingestion status.
  const repos: IngestionJob[] = [];
  return c.json({ repos });
});

// GET /:repoId — get repo / job status
reposRouter.get("/:repoId{.+}", async (c) => {
  const repoId = c.req.param("repoId");

  // Placeholder — look up job by repoId in Redis
  const error: ApiError = {
    error: "NOT_FOUND",
    message: `Repository "${repoId}" not found`,
    traceId: crypto.randomUUID(),
  };
  return c.json(error, 404);
});

// DELETE /:repoId — remove repo and its vectors
reposRouter.delete("/:repoId{.+}", async (c) => {
  const repoId = c.req.param("repoId");

  // Placeholder — delete vectors from Qdrant, remove metadata from Redis
  return c.json({ deleted: true, repoId });
});
