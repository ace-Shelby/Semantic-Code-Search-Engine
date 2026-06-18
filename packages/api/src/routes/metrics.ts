/**
 * @codesearch/api — routes/metrics.ts
 * ───────────────────────────────────────────────────────────────
 * Observability and metrics endpoint.
 *
 *   GET /  — return runtime metrics (uptime, memory, request counts)
 *
 * Dependencies: hono
 */

import { Hono } from "hono";

export const metricsRouter = new Hono();

const startedAt = Date.now();

/** In-memory request counters — reset on restart.
 *  In production, replace with Prometheus client or similar. */
const counters = {
  searchRequests: 0,
  askRequests: 0,
  ingestionJobs: 0,
  errors: 0,
};

/** Increment a counter. Exported so other routes can call it. */
export function incrementCounter(key: keyof typeof counters): void {
  counters[key]++;
}

metricsRouter.get("/", (c) => {
  const memUsage = process.memoryUsage();

  return c.json({
    uptime: {
      seconds: Math.floor((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
    },
    memory: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
    },
    counters,
  });
});
