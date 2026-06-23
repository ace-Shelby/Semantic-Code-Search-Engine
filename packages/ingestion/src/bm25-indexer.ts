/**
 * @codesearch/ingestion — src/bm25-indexer.ts
 * ───────────────────────────────────────────────────────────────
 * Builds and queries a BM25 keyword index for code chunks.
 *
 * The index is produced after AST chunking and before embeddings. It provides
 * lexical recall for exact symbols, rare identifiers, file paths, and code terms
 * that dense vectors can blur away.
 *
 * Dependencies: ioredis, wink-bm25-text-search, @codesearch/shared
 */

import bm25Factory, { type BM25Engine } from "wink-bm25-text-search";
import type Redis from "ioredis";
import type { CodeChunk, ChunkPayload } from "@codesearch/shared";

// ── Constants ─────────────────────────────────────────────────

const BM25_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_WINK_DOCUMENTS = 3;
const FILLER_DOC_PREFIX = "__bm25_internal_filler__";

const FIELD_WEIGHTS = {
  content: 1.0,
  filePath: 0.5,
  symbolName: 4.0,
} as const;

const CODE_STOP_WORDS = new Set([
  "const",
  "let",
  "var",
  "return",
  "function",
  "import",
  "export",
  "from",
  "class",
  "interface",
  "type",
  "async",
  "await",
]);

// ── Public Types ──────────────────────────────────────────────

export interface BM25Result {
  id: string;
  /** BM25 relevance score normalized to the 0-1 range within this result set. */
  score: number;
  payload: ChunkPayload;
}

// ── Service Class ─────────────────────────────────────────────

export class BM25Indexer {
  constructor(private readonly redisClient: Redis) {}

  /**
   * Build a BM25 index for a repo and persist both the serialized index and
   * the chunk lookup map in Redis.
   */
  async buildIndex(repoId: string, chunks: CodeChunk[]): Promise<void> {
    const engine = createEngine();
    const chunkLookup: Record<string, ChunkPayload> = Object.create(null);
    const seenIds = new Set<string>();

    for (const chunk of chunks) {
      if (seenIds.has(chunk.id)) {
        throw new Error(`Duplicate chunk id while building BM25 index: "${chunk.id}"`);
      }
      seenIds.add(chunk.id);

      chunkLookup[chunk.id] = chunkToPayload(chunk);
      engine.addDoc(
        {
          content: chunk.content,
          filePath: chunk.filePath,
          symbolName: chunk.symbolName || "",
        },
        chunk.id,
      );
    }

    addFillerDocsIfNeeded(engine, chunks.length);
    engine.consolidate();

    const indexKey = getIndexKey(repoId);
    const chunksKey = getChunksKey(repoId);
    const serializedIndex = engine.exportJSON();
    const serializedChunks = JSON.stringify(chunkLookup);

    await this.setWithTTL(indexKey, serializedIndex);
    await this.setWithTTL(chunksKey, serializedChunks);
  }

  /**
   * Search a repo's persisted BM25 index and hydrate hits with chunk payloads.
   *
   * Returns an empty array when the repo has not been indexed yet.
   */
  async search(repoId: string, query: string, topK: number): Promise<BM25Result[]> {
    const limit = Math.max(Math.floor(topK), 0);
    if (limit === 0 || query.trim().length === 0) {
      return [];
    }

    const indexKey = getIndexKey(repoId);
    const chunksKey = getChunksKey(repoId);

    const [serializedIndex, serializedChunks] = await Promise.all([
      this.getString(indexKey),
      this.getString(chunksKey),
    ]);

    if (!serializedIndex || !serializedChunks) {
      return [];
    }

    parseJson(serializedIndex, `BM25 index at Redis key "${indexKey}"`);
    const chunkLookup = parseChunkLookup(serializedChunks, chunksKey);

    const engine = createEngine();
    engine.importJSON(serializedIndex);

    const hits = engine
      .search(query, limit + MIN_WINK_DOCUMENTS)
      .filter(([id]) => !id.startsWith(FILLER_DOC_PREFIX))
      .slice(0, limit);

    if (hits.length === 0) {
      return [];
    }

    const maxScore = Math.max(...hits.map(([, score]) => score));

    return hits.flatMap(([id, rawScore]) => {
      const payload = chunkLookup[id];
      if (!payload) {
        console.warn(`BM25 hit "${id}" was missing from Redis chunk lookup for repo "${repoId}"`);
        return [];
      }

      return {
        id,
        score: normalizeScore(rawScore, maxScore),
        payload,
      };
    });
  }

  private async setWithTTL(key: string, value: string): Promise<void> {
    try {
      await this.redisClient.set(key, value, "EX", BM25_TTL_SECONDS);
    } catch (err) {
      throw new Error(
        `Failed to write BM25 data to Redis key "${key}": ${formatRedisError(err)}`,
      );
    }
  }

  private async getString(key: string): Promise<string | null> {
    try {
      return await this.redisClient.get(key);
    } catch (err) {
      throw new Error(
        `Failed to read BM25 data from Redis key "${key}": ${formatRedisError(err)}`,
      );
    }
  }
}

// ── Engine Setup ──────────────────────────────────────────────

function createEngine(): BM25Engine {
  const engine = bm25Factory();
  engine.defineConfig({ fldWeights: FIELD_WEIGHTS });
  engine.definePrepTasks([tokenizeCodeText]);
  return engine;
}

/**
 * Tokenize code-ish text for BM25.
 *
 * Camel-case boundaries are inserted before lowercasing so identifiers like
 * `getUserById` keep their internal words. The emitted tokens are lowercase.
 */
function tokenizeCodeText(input: string): string[] {
  return input
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !CODE_STOP_WORDS.has(token));
}

/**
 * wink-bm25-text-search requires at least 3 docs to consolidate. Small repos or
 * very narrow ingestions can produce fewer chunks, so add unhydrated filler docs
 * that are filtered from results.
 */
function addFillerDocsIfNeeded(engine: BM25Engine, realDocCount: number): void {
  for (let i = realDocCount; i < MIN_WINK_DOCUMENTS; i++) {
    engine.addDoc(
      {
        content: `zzzzzzzzbm25filler${i}`,
        filePath: `zzzzzzzzbm25filler${i}`,
        symbolName: `zzzzzzzzbm25filler${i}`,
      },
      `${FILLER_DOC_PREFIX}${i}`,
    );
  }
}

// ── Serialization Helpers ────────────────────────────────────

function parseChunkLookup(serializedChunks: string, key: string): Record<string, ChunkPayload> {
  const parsed = parseJson(serializedChunks, `BM25 chunk lookup at Redis key "${key}"`);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid BM25 chunk lookup at Redis key "${key}": expected an object`);
  }

  return parsed as Record<string, ChunkPayload>;
}

function parseJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function chunkToPayload(chunk: CodeChunk): ChunkPayload {
  return {
    repoId: chunk.repoId,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    language: chunk.language,
    symbolName: chunk.symbolName,
    tokenCount: chunk.tokenCount,
  };
}

function normalizeScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, score / maxScore));
}

function getIndexKey(repoId: string): string {
  return `repo:${repoId}:bm25`;
}

function getChunksKey(repoId: string): string {
  return `repo:${repoId}:bm25:chunks`;
}

function formatRedisError(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? ` (${String(err.code)})` : "";
    return `${err.message}${code}`;
  }

  return String(err);
}
