import { Hono } from "hono";
import type { HealthStatus } from "@codesearch/shared";
import { qdrant, redis } from "./clients.ts";

export const healthRouter = new Hono();

// We need the raw Qdrant URL to hit /healthz
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const VERSION = process.env.npm_package_version || "1.0.0";

healthRouter.get("/", async (c) => {
  let qdrantOk = false;
  let redisOk = false;

  // Check Qdrant
  try {
    const headers: Record<string, string> = {};
    if (process.env.QDRANT_API_KEY) {
      headers["api-key"] = process.env.QDRANT_API_KEY;
    }
    const qdrantRes = await fetch(`${QDRANT_URL}/healthz`, { headers });
    if (qdrantRes.ok) {
      qdrantOk = true;
    }
  } catch (err) {
    qdrantOk = false;
  }

  // Check Redis
  try {
    const pong = await redis.ping();
    redisOk = pong === "PONG";
  } catch (err) {
    redisOk = false;
  }

  const isHealthy = qdrantOk && redisOk;
  const isDown = !qdrantOk && !redisOk;

  const body: HealthStatus = {
    status: isHealthy ? "ok" : isDown ? "down" : "degraded",
    qdrant: qdrantOk,
    redis: redisOk,
    uptime: process.uptime(),
    version: VERSION,
  };

  // The spec requires 200 if all healthy, 503 if ANY dependency is down
  return c.json(body, isHealthy ? 200 : 503);
});
