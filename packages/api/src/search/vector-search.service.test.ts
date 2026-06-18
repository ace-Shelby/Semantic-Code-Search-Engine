/**
 * @codesearch/api — src/search/vector-search.service.test.ts
 * ───────────────────────────────────────────────────────────────
 * Unit tests for the VectorSearchService query pipeline.
 *
 * Run this to verify:
 *   bun test packages/api/src/search/vector-search.service.test.ts
 */

import { describe, expect, test } from "bun:test";
import type Redis from "ioredis";
import type { ChunkPayload, VectorSearchResult as SharedVectorSearchResult } from "@codesearch/shared";
import { VectorSearchService } from "./vector-search.service.ts";

// ── Test Helpers ──────────────────────────────────────────────

class MockRedis {
  private readonly values = new Map<string, string>();
  private readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<"OK"> {
    this.values.set(key, value);

    if (mode === "EX" && ttlSeconds !== undefined) {
      this.ttls.set(key, ttlSeconds);
    }

    return "OK";
  }

  getTTL(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

function asRedis(redis: MockRedis): Redis {
  return redis as unknown as Redis;
}

function makeVector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => seed + i / 100_000);
}

function makePayload(overrides: Partial<ChunkPayload> = {}): ChunkPayload {
  return {
    repoId: "owner/repo",
    filePath: "src/auth.ts",
    startLine: 1,
    endLine: 20,
    content: "export function authenticateUser() {}",
    language: "typescript",
    symbolName: "authenticateUser",
    tokenCount: 42,
    ...overrides,
  };
}

function createMockOpenAI(vector = makeVector(1)) {
  const calls: Array<{ model: string; input: string }> = [];

  return {
    embeddings: {
      create: async (params: { model: string; input: string }) => {
        calls.push(params);
        return {
          data: [{ embedding: vector }],
        };
      },
    },
    calls,
  };
}

function createMockQdrant(results: SharedVectorSearchResult[] = []) {
  const calls: Array<{
    repoId: string;
    queryVector: number[];
    topK: number;
    filter?: { language?: string };
  }> = [];

  return {
    similaritySearch: async (
      repoId: string,
      queryVector: number[],
      topK: number,
      filter?: { language?: string },
    ) => {
      calls.push({ repoId, queryVector, topK, filter });
      return results;
    },
    calls,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("VectorSearchService", () => {
  test("uses Redis cache on repeated identical query embeddings", async () => {
    const redis = new MockRedis();
    const openai = createMockOpenAI(makeVector(7));
    const qdrant = createMockQdrant([
      {
        id: "chunk-auth",
        score: 0.92,
        payload: makePayload(),
      },
    ]);

    const service = new VectorSearchService({
      openaiApiKey: "test-key",
      qdrantUrl: "http://localhost:6333",
      redisClient: asRedis(redis),
      openaiClient: openai,
      qdrantService: qdrant,
    });

    await service.search({ query: "how is auth handled", repoId: "owner/repo" });
    await service.search({ query: "how is auth handled", repoId: "owner/repo" });

    expect(openai.calls.length).toBe(1);
    expect(openai.calls[0].model).toBe("text-embedding-3-small");
    expect(qdrant.calls.length).toBe(2);
    expect(qdrant.calls[0].queryVector).toEqual(makeVector(7));
    expect(qdrant.calls[1].queryVector).toEqual(makeVector(7));
  });

  test("passes language filter through to Qdrant similarity search", async () => {
    const openai = createMockOpenAI(makeVector(3));
    const qdrant = createMockQdrant([
      {
        id: "chunk-python",
        score: 0.88,
        payload: makePayload({ language: "python", filePath: "auth.py" }),
      },
    ]);

    const service = new VectorSearchService({
      openaiApiKey: "test-key",
      qdrantUrl: "http://localhost:6333",
      redisClient: asRedis(new MockRedis()),
      openaiClient: openai,
      qdrantService: qdrant,
    });

    const results = await service.search({
      query: "authentication middleware",
      repoId: "owner/repo",
      topK: 5,
      languageFilter: "python",
    });

    expect(qdrant.calls.length).toBe(1);
    expect(qdrant.calls[0].repoId).toBe("owner/repo");
    expect(qdrant.calls[0].topK).toBe(5);
    expect(qdrant.calls[0].filter).toEqual({ language: "python" });
    expect(results[0].metadata).toEqual({ source: "vector", originalScore: 0.88 });
  });

  test("filters low-score results and sorts remaining results descending", async () => {
    const service = new VectorSearchService({
      openaiApiKey: "test-key",
      qdrantUrl: "http://localhost:6333",
      redisClient: asRedis(new MockRedis()),
      openaiClient: createMockOpenAI(),
      qdrantService: createMockQdrant([
        { id: "low", score: 0.29, payload: makePayload({ filePath: "low.ts" }) },
        { id: "mid", score: 0.62, payload: makePayload({ filePath: "mid.ts" }) },
        { id: "high", score: 0.91, payload: makePayload({ filePath: "high.ts" }) },
      ]),
    });

    const results = await service.search({ query: "cache invalidation", repoId: "owner/repo" });

    expect(results.map((result) => result.id)).toEqual(["high", "mid"]);
  });
});
