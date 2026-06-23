/**
 * @codesearch/api — routes/metrics.route.ts
 * ───────────────────────────────────────────────────────────────
 * Observability and metrics endpoint.
 *
 *   GET /api/v1/metrics  — return aggregated metrics from Langfuse
 *
 * Fetches the last 100 traces from Langfuse, aggregates key metrics
 * (latency, cost, cache hit rate, query count), and caches the
 * result in Redis for 5 minutes to avoid hammering the Langfuse API.
 *
 * Dependencies: hono, redis
 */

import { Hono } from "hono";
import { redis } from "../clients.ts";

export const metricsRouter = new Hono();

// ── Constants ─────────────────────────────────────────────────

const METRICS_CACHE_KEY = "api:metrics:dashboard";
const METRICS_CACHE_TTL = 5 * 60; // 5 minutes

const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? "";
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

// ── Types ─────────────────────────────────────────────────────

interface MetricsAggregated {
  avgLatencyMs: number;
  avgCostUsd: number;
  queriesToday: number;
  cacheHitRate: number;
  sampledTraces: number;
  lastUpdated: string;
}

// Minimal shape of a Langfuse Trace from their REST API
interface LangfuseTrace {
  id: string;
  name: string;
  timestamp: string;
  latency?: number;
  totalCost?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface LangfuseSpan {
  name: string;
  metadata?: {
    cacheHit?: boolean;
    [key: string]: unknown;
  };
}

// ── Route ─────────────────────────────────────────────────────

metricsRouter.get("/", async (c) => {
  try {
    // 1. Try to serve from Redis cache
    const cached = await redis.get(METRICS_CACHE_KEY);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    // 2. Not in cache, compute it. If no credentials, return empty.
    if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
      const empty: MetricsAggregated = {
        avgLatencyMs: 0,
        avgCostUsd: 0,
        queriesToday: 0,
        cacheHitRate: 0,
        sampledTraces: 0,
        lastUpdated: new Date().toISOString(),
      };
      return c.json(empty);
    }

    // 3. Fetch last 100 traces from Langfuse REST API
    // The API uses HTTP Basic auth with PublicKey:SecretKey
    const authHeader = `Basic ${Buffer.from(
      `${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`
    ).toString("base64")}`;

    // Get today's date at midnight UTC for filtering "queries today"
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const tracesUrl = new URL(`${LANGFUSE_BASE_URL}/api/public/traces`);
    tracesUrl.searchParams.set("limit", "100");

    const tracesRes = await fetch(tracesUrl.toString(), {
      headers: { Authorization: authHeader },
    });

    if (!tracesRes.ok) {
      console.error(`Langfuse traces fetch failed: ${tracesRes.statusText}`);
      throw new Error("Failed to fetch traces from Langfuse");
    }

    const tracesData = (await tracesRes.json()) as { data: LangfuseTrace[] };
    const traces = tracesData.data || [];

    // 4. Fetch spans for these traces to calculate cache hit rate.
    // To avoid fetching spans for all 100 traces individually, we query
    // recent spans named "search_cache" or just fetch recent spans.
    // Since fetching all spans per trace is N+1, we'll use the
    // GET /api/public/observations endpoint to fetch recent "search_cache" spans.
    const obsUrl = new URL(`${LANGFUSE_BASE_URL}/api/public/observations`);
    obsUrl.searchParams.set("limit", "100");
    obsUrl.searchParams.set("name", "search_cache");
    obsUrl.searchParams.set("type", "SPAN");

    let cacheHits = 0;
    let cacheMisses = 0;

    const obsRes = await fetch(obsUrl.toString(), {
      headers: { Authorization: authHeader },
    });

    if (obsRes.ok) {
      const obsData = (await obsRes.json()) as { data: LangfuseSpan[] };
      const cacheSpans = obsData.data || [];

      for (const span of cacheSpans) {
        const hit = span.metadata?.cacheHit;
        if (hit === true) cacheHits++;
        if (hit === false) cacheMisses++;
      }
    }

    // 5. Aggregate metrics
    let totalLatency = 0;
    let totalCost = 0;
    let queriesToday = 0;
    let validLatencyCount = 0;
    let validCostCount = 0;

    for (const trace of traces) {
      // Latency
      if (typeof trace.latency === "number" && trace.latency > 0) {
        // Langfuse returns latency in seconds
        totalLatency += trace.latency * 1000;
        validLatencyCount++;
      }

      // Cost
      if (typeof trace.totalCost === "number") {
        totalCost += trace.totalCost;
        validCostCount++;
      }

      // Queries Today
      const traceDate = new Date(trace.timestamp);
      if (traceDate >= today) {
        queriesToday++;
      }
    }

    const totalCacheChecks = cacheHits + cacheMisses;

    const metrics: MetricsAggregated = {
      avgLatencyMs: validLatencyCount > 0 ? Math.round(totalLatency / validLatencyCount) : 0,
      avgCostUsd: validCostCount > 0 ? Number((totalCost / validCostCount).toFixed(6)) : 0,
      queriesToday,
      cacheHitRate: totalCacheChecks > 0 ? Number((cacheHits / totalCacheChecks).toFixed(4)) : 0,
      sampledTraces: traces.length,
      lastUpdated: new Date().toISOString(),
    };

    // 6. Cache and return
    await redis.set(METRICS_CACHE_KEY, JSON.stringify(metrics), "EX", METRICS_CACHE_TTL);

    return c.json(metrics);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return c.json({ error: message }, 500);
  }
});
