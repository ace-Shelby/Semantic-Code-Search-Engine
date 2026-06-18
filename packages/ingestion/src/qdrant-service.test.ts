/**
 * @codesearch/ingestion — src/qdrant-service.test.ts
 * ───────────────────────────────────────────────────────────────
 * Integration tests for the QdrantService module.
 *
 * REQUIRES: Qdrant running on localhost:6333.
 * If Qdrant is not available, tests are skipped with a warning.
 *
 * Start Qdrant before running:
 *   docker compose up -d qdrant
 *
 * Run this to verify:
 *   bun test packages/ingestion/src/qdrant-service.test.ts
 *
 * Dependencies: bun:test, @codesearch/shared, ./qdrant-service
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { QdrantService, toCollectionName } from "./qdrant-service.ts";
import type { EmbeddedChunk } from "@codesearch/shared";

// ── Test Helpers ──────────────────────────────────────────────

const QDRANT_URL = "http://localhost:6333";
const TEST_REPO_ID = `__test__/qdrant-integration-${Date.now()}`;

/**
 * Generate a deterministic 1536-dimensional vector.
 *
 * The vector is dominated by a "signal" dimension at index `signalIndex`
 * (set to 1.0) with all other values being small noise.
 * This makes similarity search predictable — a query with signal at index N
 * will match the point with signal at index N most closely.
 */
function makeVector(signalIndex: number): number[] {
  const vec = new Array<number>(1536).fill(0);
  // Set a strong signal at the chosen dimension
  vec[signalIndex] = 1.0;
  // Add small deterministic noise so the vector isn't sparse
  for (let i = 0; i < 1536; i++) {
    if (i !== signalIndex) {
      vec[i] = 0.001 * ((signalIndex * 7 + i * 3) % 100) / 100;
    }
  }
  return vec;
}

/** Build a fake EmbeddedChunk with a specific signal dimension. */
function makeFakeChunk(index: number): EmbeddedChunk {
  return {
    id: `chunk-${index}`,
    repoId: TEST_REPO_ID,
    filePath: `src/module-${index}.ts`,
    startLine: 1,
    endLine: 20,
    content: `function module${index}() {\n  return ${index};\n}`,
    language: "typescript",
    symbolName: `module${index}`,
    tokenCount: 15,
    vector: makeVector(index * 10), // Signal at dimensions 0, 10, 20, ...
  };
}

/** Check if Qdrant is reachable. */
async function isQdrantAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${QDRANT_URL}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Collection Naming Tests (no Qdrant needed) ────────────────

describe("toCollectionName", () => {
  test("produces a deterministic name from repoId", async () => {
    const name1 = await toCollectionName("expressjs/express");
    const name2 = await toCollectionName("expressjs/express");
    expect(name1).toBe(name2);
  });

  test("starts with 'repo_' prefix", async () => {
    const name = await toCollectionName("some/repo");
    expect(name.startsWith("repo_")).toBe(true);
  });

  test("is exactly 21 characters (repo_ + 16 hex chars)", async () => {
    const name = await toCollectionName("any/repo");
    expect(name.length).toBe(21);
  });

  test("different repos produce different names", async () => {
    const name1 = await toCollectionName("owner/repo-a");
    const name2 = await toCollectionName("owner/repo-b");
    expect(name1).not.toBe(name2);
  });

  test("contains only alphanumeric + underscore", async () => {
    const name = await toCollectionName("user/my-repo.with" + "special@chars");
    expect(name).toMatch(/^repo_[0-9a-f]{16}$/);
  });
});

// ── Integration Tests (require Qdrant) ────────────────────────

describe("QdrantService — integration", () => {
  let service: QdrantService;
  let qdrantAvailable: boolean;

  beforeAll(async () => {
    qdrantAvailable = await isQdrantAvailable();
    if (!qdrantAvailable) {
      console.warn(
        "\n⚠️  Qdrant is not running at localhost:6333. " +
        "Integration tests will be skipped.\n" +
        "Start Qdrant with: docker compose up -d qdrant\n"
      );
      return;
    }
    service = new QdrantService(QDRANT_URL);
  });

  afterAll(async () => {
    if (!qdrantAvailable) return;
    // Clean up the test collection
    try {
      await service.deleteCollection(TEST_REPO_ID);
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── Collection Lifecycle ──────────────────────────────────

  test("collectionExists returns false for non-existent collection", async () => {
    if (!qdrantAvailable) return;
    const exists = await service.collectionExists(TEST_REPO_ID);
    expect(exists).toBe(false);
  });

  test("ensureCollection creates a new collection", async () => {
    if (!qdrantAvailable) return;
    await service.ensureCollection(TEST_REPO_ID);

    const exists = await service.collectionExists(TEST_REPO_ID);
    expect(exists).toBe(true);
  });

  test("ensureCollection is idempotent (second call is a no-op)", async () => {
    if (!qdrantAvailable) return;
    // Should not throw
    await service.ensureCollection(TEST_REPO_ID);

    const exists = await service.collectionExists(TEST_REPO_ID);
    expect(exists).toBe(true);
  });

  test("getCollectionInfo returns vector count and status", async () => {
    if (!qdrantAvailable) return;
    const info = await service.getCollectionInfo(TEST_REPO_ID);
    expect(info.vectorCount).toBe(0); // Empty collection
    expect(typeof info.status).toBe("string");
  });

  // ── Upsert ────────────────────────────────────────────────

  test("upsertChunks inserts 10 vectors", async () => {
    if (!qdrantAvailable) return;

    const chunks = Array.from({ length: 10 }, (_, i) => makeFakeChunk(i));
    await service.upsertChunks(TEST_REPO_ID, chunks);

    // Wait briefly for Qdrant to index
    await new Promise((r) => setTimeout(r, 500));

    const info = await service.getCollectionInfo(TEST_REPO_ID);
    expect(info.vectorCount).toBe(10);
  });

  test("upsertChunks is idempotent (re-upsert doesn't duplicate)", async () => {
    if (!qdrantAvailable) return;

    // Re-upsert the same chunks
    const chunks = Array.from({ length: 10 }, (_, i) => makeFakeChunk(i));
    await service.upsertChunks(TEST_REPO_ID, chunks);

    await new Promise((r) => setTimeout(r, 500));

    const info = await service.getCollectionInfo(TEST_REPO_ID);
    expect(info.vectorCount).toBe(10); // Still 10, not 20
  });

  test("upsertChunks handles empty array gracefully", async () => {
    if (!qdrantAvailable) return;
    await service.upsertChunks(TEST_REPO_ID, []);
    // Should not throw
  });

  // ── Similarity Search ─────────────────────────────────────

  test("similaritySearch returns the nearest vector", async () => {
    if (!qdrantAvailable) return;

    // Query with a vector that has signal at dimension 30
    // (should match chunk-3 which has signal at 3*10=30)
    const queryVector = makeVector(30);
    const results = await service.similaritySearch(TEST_REPO_ID, queryVector, 5);

    expect(results.length).toBeGreaterThan(0);

    // The top result should be chunk-3 (signal at dim 30)
    const topResult = results[0];
    expect(topResult.id).toBe("chunk-3");
    expect(topResult.score).toBeGreaterThan(0.5); // Strong match
    expect(topResult.payload.filePath).toBe("src/module-3.ts");
    expect(topResult.payload.symbolName).toBe("module3");
    expect(topResult.payload.language).toBe("typescript");
  });

  test("similaritySearch returns results in descending score order", async () => {
    if (!qdrantAvailable) return;

    const queryVector = makeVector(50); // Signal at dim 50 → matches chunk-5
    const results = await service.similaritySearch(TEST_REPO_ID, queryVector, 10);

    // Verify descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("similaritySearch respects topK limit", async () => {
    if (!qdrantAvailable) return;

    const queryVector = makeVector(0);
    const results = await service.similaritySearch(TEST_REPO_ID, queryVector, 3);

    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("similaritySearch filters by language", async () => {
    if (!qdrantAvailable) return;

    const queryVector = makeVector(0);
    const results = await service.similaritySearch(
      TEST_REPO_ID,
      queryVector,
      10,
      { language: "typescript" }
    );

    // All our test chunks are TypeScript, so results should be non-empty
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.payload.language).toBe("typescript");
    }
  });

  test("similaritySearch returns empty for non-matching language filter", async () => {
    if (!qdrantAvailable) return;

    const queryVector = makeVector(0);
    const results = await service.similaritySearch(
      TEST_REPO_ID,
      queryVector,
      10,
      { language: "python" } // No Python chunks in our test data
    );

    expect(results.length).toBe(0);
  });

  test("all search results have complete payload fields", async () => {
    if (!qdrantAvailable) return;

    const queryVector = makeVector(0);
    const results = await service.similaritySearch(TEST_REPO_ID, queryVector, 5);

    for (const result of results) {
      expect(typeof result.id).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);

      const p = result.payload;
      expect(typeof p.repoId).toBe("string");
      expect(typeof p.filePath).toBe("string");
      expect(typeof p.startLine).toBe("number");
      expect(typeof p.endLine).toBe("number");
      expect(typeof p.content).toBe("string");
      expect(typeof p.language).toBe("string");
      expect(typeof p.tokenCount).toBe("number");
      // symbolName can be string or null
      expect(p.symbolName === null || typeof p.symbolName === "string").toBe(true);
    }
  });

  // ── Deletion ──────────────────────────────────────────────

  test("deleteCollection removes the collection", async () => {
    if (!qdrantAvailable) return;

    await service.deleteCollection(TEST_REPO_ID);

    const exists = await service.collectionExists(TEST_REPO_ID);
    expect(exists).toBe(false);
  });

  test("deleteCollection is idempotent (second call is a no-op)", async () => {
    if (!qdrantAvailable) return;

    // Should not throw
    await service.deleteCollection(TEST_REPO_ID);
  });
});

// ── Error Handling Tests (no Qdrant needed) ───────────────────

describe("QdrantService — error handling", () => {
  test("collectionExists throws clear error for unreachable Qdrant", async () => {
    const badService = new QdrantService("http://localhost:59999"); // Nothing running here

    await expect(
      badService.collectionExists("some/repo")
    ).rejects.toThrow(/Cannot connect to Qdrant|fetch failed/i);
  });

  test("getCollectionInfo throws clear error for unreachable Qdrant", async () => {
    const badService = new QdrantService("http://localhost:59999");

    await expect(
      badService.getCollectionInfo("some/repo")
    ).rejects.toThrow(/Cannot connect to Qdrant|fetch failed|not found/i);
  });
});
