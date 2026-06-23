/**
 * @codesearch/api — src/search/vector-search.service.ts
 * ───────────────────────────────────────────────────────────────
 * Vector retrieval service for the query pipeline.
 *
 * Flow: query string → cached/OpenAI embedding → Qdrant similarity search →
 *       top vector candidates with retrieval metadata.
 *
 * Dependencies: openai, ioredis, @qdrant/js-client-rest, @codesearch/shared
 */

import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import type Redis from "ioredis";
import type {
  ChunkPayload,
  VectorSearchResult as SharedVectorSearchResult,
} from "@codesearch/shared";
import { toCollectionName } from "../services/qdrant.service.ts";

// ── Constants ─────────────────────────────────────────────────

const EMBEDDING_DIMENSIONS = Number(process.env.QDRANT_VECTOR_SIZE ?? 768);
const CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_TOP_K = 20;
const MIN_VECTOR_SCORE = 0.55;
const DEFAULT_COLLECTION = "code_chunks";

// ── Public Types ──────────────────────────────────────────────

export interface VectorSearchMetadata {
  source: "vector";
  originalScore: number;
}

export interface VectorSearchResult extends SharedVectorSearchResult {
  metadata: VectorSearchMetadata;
}

export interface VectorSearchServiceConfig {
  openaiApiKey: string;
  openaiBaseUrl?: string;
  openaiEmbeddingModel?: string;
  qdrantUrl: string;
  redisClient: Redis;
  /** Test hook; production callers should omit this. */
  openaiClient?: OpenAIEmbeddingClient;
  /** Test hook; production callers should omit this. */
  qdrantService?: QdrantSimilaritySearch;
}

export interface VectorSearchParams {
  query: string;
  repoId: string;
  topK?: number;
  languageFilter?: string;
}

interface OpenAIEmbeddingClient {
  embeddings: {
    create(params: { model: string; input: string }): Promise<{
      data: Array<{ embedding: number[] }>;
    }>;
  };
}

interface QdrantSimilaritySearch {
  similaritySearch(
    repoId: string,
    queryVector: number[],
    topK: number,
    filter?: { language?: string },
  ): Promise<SharedVectorSearchResult[]>;
}

// ── Service Class ─────────────────────────────────────────────

export class VectorSearchService {
  private readonly openai: OpenAIEmbeddingClient;
  private readonly qdrantService: QdrantSimilaritySearch;
  private readonly redisClient: Redis;
  private readonly embeddingModel: string;

  constructor(config: VectorSearchServiceConfig) {
    this.openai = config.openaiClient ?? new OpenAI({ 
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      maxRetries: 5,
    });
    this.qdrantService = config.qdrantService ?? new QdrantService(config.qdrantUrl);
    this.redisClient = config.redisClient;
    this.embeddingModel = config.openaiEmbeddingModel ?? "text-embedding-004";
  }

  async search(params: VectorSearchParams): Promise<VectorSearchResult[]> {
    if (!params.query.trim()) {
      return [];
    }

    const topK = normalizeTopK(params.topK);
    const queryVector = await this.embedQuery(params.query);
    const filter = params.languageFilter ? { language: params.languageFilter } : undefined;

    const results = await this.qdrantService.similaritySearch(
      params.repoId,
      queryVector,
      topK,
      filter,
    );

    return results
      .filter((result) => result.score >= MIN_VECTOR_SCORE)
      .sort((a, b) => b.score - a.score)
      .map((result) => ({
        ...result,
        metadata: {
          source: "vector",
          originalScore: result.score,
        },
      }));
  }

  private async embedQuery(query: string): Promise<number[]> {
    const cacheKey = await toEmbeddingCacheKey(query);
    const cachedVector = await this.getCachedEmbedding(cacheKey);

    if (cachedVector) {
      return cachedVector;
    }

    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input: query,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const vector = response.data[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("OpenAI embedding response did not include an embedding vector");
    }

    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dimensional query embedding, received ${vector.length}`,
      );
    }

    await this.setCachedEmbedding(cacheKey, vector);
    return vector;
  }

  private async getCachedEmbedding(cacheKey: string): Promise<number[] | null> {
    let cached: string | null;

    try {
      cached = await this.redisClient.get(cacheKey);
    } catch (err) {
      console.warn(`Failed to read query embedding cache key "${cacheKey}": ${formatError(err)}`);
      return null;
    }

    if (!cached) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached);
      return isEmbeddingVector(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async setCachedEmbedding(cacheKey: string, vector: number[]): Promise<void> {
    try {
      await this.redisClient.set(cacheKey, JSON.stringify(vector), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn(`Failed to write query embedding cache key "${cacheKey}": ${formatError(err)}`);
    }
  }
}

// ── Qdrant Adapter ────────────────────────────────────────────

class QdrantService implements QdrantSimilaritySearch {
  private readonly client: QdrantClient;
  private readonly collectionName: string;

  constructor(qdrantUrl: string, collectionName = process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION) {
    this.client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
    this.collectionName = collectionName;
  }

  async similaritySearch(
    repoId: string,
    queryVector: number[],
    topK: number,
    filter?: { language?: string },
  ): Promise<SharedVectorSearchResult[]> {
    const mustConditions: Array<Record<string, unknown>> = [
      { key: "repoId", match: { value: repoId } },
    ];

    if (filter?.language) {
      mustConditions.push({
        key: "language",
        match: { value: filter.language },
      });
    }

    const hits = await this.client.search(toCollectionName(repoId), {
      vector: queryVector,
      limit: topK,
      with_payload: true,
      filter: {
        must: mustConditions,
      },
    });

    return hits.map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      payload: toChunkPayload(hit.payload),
    }));
  }
}

// ── Helpers ───────────────────────────────────────────────────

async function toEmbeddingCacheKey(query: string): Promise<string> {
  const encoded = new TextEncoder().encode(query);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `embed:${hash}`;
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  return Math.max(1, Math.floor(topK));
}

function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function toChunkPayload(payload: unknown): ChunkPayload {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};

  return {
    repoId: String(record.repoId ?? ""),
    filePath: String(record.filePath ?? ""),
    startLine: Number(record.startLine ?? 0),
    endLine: Number(record.endLine ?? 0),
    content: String(record.content ?? ""),
    language: String(record.language ?? "other"),
    symbolName: record.symbolName != null ? String(record.symbolName) : null,
    tokenCount: Number(record.tokenCount ?? 0),
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? ` (${String(err.code)})` : "";
    return `${err.message}${code}`;
  }

  return String(err);
}
