/**
 * @codesearch/ingestion — src/bm25-indexer.test.ts
 * ───────────────────────────────────────────────────────────────
 * Unit tests for the BM25Indexer module.
 *
 * Run this to verify:
 *   bun test packages/ingestion/src/bm25-indexer.test.ts
 */

import { describe, expect, test } from "bun:test";
import type Redis from "ioredis";
import type { CodeChunk, Language } from "@codesearch/shared";
import { BM25Indexer } from "./bm25-indexer.ts";

// ── Test Helpers ──────────────────────────────────────────────

class MockRedis {
  private readonly values = new Map<string, string>();
  private readonly ttls = new Map<string, number>();

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<"OK"> {
    this.values.set(key, value);

    if (mode === "EX" && ttlSeconds !== undefined) {
      this.ttls.set(key, ttlSeconds);
    }

    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  getTTL(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

function asRedis(redis: MockRedis): Redis {
  return redis as unknown as Redis;
}

function makeChunk(
  id: string,
  symbolName: string,
  filePath: string,
  content: string,
  language: Language = "typescript",
): CodeChunk {
  return {
    id,
    repoId: "owner/repo",
    filePath,
    startLine: 1,
    endLine: content.split("\n").length,
    content,
    language,
    symbolName,
    tokenCount: Math.ceil(content.length / 4),
  };
}

function makeFakeChunks(): CodeChunk[] {
  return [
    makeChunk(
      "chunk-auth",
      "validateSessionToken",
      "src/auth/session.ts",
      `export async function validateSessionToken(token: string) {
  const session = await authenticationProvider.verify(token);
  if (!session) throw new Error("authentication failed");
  return session;
}`,
    ),
    makeChunk(
      "chunk-billing",
      "calculateInvoiceTotal",
      "src/billing/invoices.ts",
      `export function calculateInvoiceTotal(items: LineItem[]) {
  return items.reduce((sum, item) => sum + item.priceCents, 0);
}`,
    ),
    makeChunk(
      "chunk-cache",
      "readThroughCache",
      "src/cache/read-through.ts",
      `export async function readThroughCache(key: string) {
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}`,
    ),
    makeChunk(
      "chunk-router",
      "registerHealthRoutes",
      "src/http/routes.ts",
      `export function registerHealthRoutes(app: App) {
  app.get("/health", () => ({ status: "ok" }));
}`,
    ),
    makeChunk(
      "chunk-logger",
      "createStructuredLogger",
      "src/observability/logger.ts",
      `export function createStructuredLogger(serviceName: string) {
  return logger.child({ serviceName });
}`,
    ),
  ];
}

// ── Tests ─────────────────────────────────────────────────────

describe("BM25Indexer", () => {
  test("searches for authentication and ranks the auth chunk first", async () => {
    const indexer = new BM25Indexer(asRedis(new MockRedis()));

    await indexer.buildIndex("owner/repo", makeFakeChunks());
    const results = await indexer.search("owner/repo", "authentication", 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("chunk-auth");
    expect(results[0].payload.filePath).toBe("src/auth/session.ts");
    expect(results[0].score).toBe(1);
  });

  test("searches for an exact camelCase function name", async () => {
    const indexer = new BM25Indexer(asRedis(new MockRedis()));

    await indexer.buildIndex("owner/repo", makeFakeChunks());
    const results = await indexer.search("owner/repo", "calculateInvoiceTotal", 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("chunk-billing");
    expect(results[0].payload.symbolName).toBe("calculateInvoiceTotal");
  });

  test("returns an empty result set when the repo has not been indexed", async () => {
    const indexer = new BM25Indexer(asRedis(new MockRedis()));

    const results = await indexer.search("owner/missing-repo", "authentication", 5);

    expect(results).toEqual([]);
  });
});
