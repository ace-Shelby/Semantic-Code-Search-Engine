/**
 * @codesearch/api — src/index.ts
 * ───────────────────────────────────────────────────────────────
 * Main entry point for the Hono API server.
 *
 * Provides:
 *   GET  /health         — liveness probe (checks Qdrant + Redis)
 *   ALL  /api/v1/repos   — repository management (placeholder routes)
 *   ALL  /api/v1/search  — semantic / hybrid search
 *   ALL  /api/v1/ask     — RAG question-answering
 *   ALL  /api/v1/metrics — observability metrics
 *
 * Dependencies:
 *   hono, ioredis, @qdrant/js-client-rest, openai, langfuse
 *
 * Run this to verify:
 *   bun run packages/api/src/index.ts
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import type { ApiError, HealthStatus } from "@codesearch/shared";

import {
  CORS_ORIGIN,
  HOST,
  PORT,
  qdrant,
  redis,
  observability,
} from "./clients.ts";
import { globalErrorHandler } from "./middleware/error-handler.ts";
import { reposRouter } from "./routes/repos.route.ts";
import { searchRouter } from "./routes/search.route.ts";
import { askRouteRouter } from "./routes/ask.route.ts";
import { metricsRouter } from "./routes/metrics.route.ts";
import { healthRouter } from "./health.ts";

export { qdrant, redis, observability };

// ── App ───────────────────────────────────────────────────────

const app = new Hono();

// ── Global Middleware ─────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["X-Trace-Id"],
    maxAge: 86400,
  })
);

// ── Health Check ──────────────────────────────────────────────

app.route("/health", healthRouter);

// ── API Routes ────────────────────────────────────────────────

app.route("/api/v1/repos", reposRouter);
app.route("/api/v1/search", searchRouter);
app.route("/api/v1/ask", askRouteRouter);
app.route("/api/v1/metrics", metricsRouter);

// ── Global Error Handler ──────────────────────────────────────

app.onError(globalErrorHandler);

// ── 404 Handler ───────────────────────────────────────────────

app.notFound((c) => {
  const traceId = crypto.randomUUID();
  const body: ApiError & { statusCode: number } = {
    error: "NOT_FOUND",
    message: `Route ${c.req.method} ${c.req.path} not found`,
    traceId,
    statusCode: 404,
  };
  c.header("X-Trace-Id", traceId);
  return c.json(body, 404);
});

// ── Start Server ──────────────────────────────────────────────

console.log(`🔍 CodeSearch AI API starting on http://${HOST}:${PORT}`);

// Connect Redis eagerly so the health check works immediately
redis.connect().catch((err) => {
  console.warn("⚠️  Redis connection failed (will retry on demand):", err.message);
});

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 255,
};
