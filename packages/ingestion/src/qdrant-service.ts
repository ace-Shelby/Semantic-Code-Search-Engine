/**
 * @codesearch/ingestion — src/qdrant-service.ts
 * ───────────────────────────────────────────────────────────────
 * Manages Qdrant collections and vector operations for CodeSearch AI.
 *
 * Responsibilities:
 *   - Collection lifecycle: create, check, delete, info
 *   - Batch upsert of embedded code chunks
 *   - Similarity search with optional payload filtering
 *   - Collection naming: SHA-256 hash of repoId, truncated to 16 chars
 *
 * Why Cosine distance instead of Dot Product for OpenAI embeddings:
 *
 *   OpenAI's text-embedding-3-small produces *normalized* vectors (unit length),
 *   which means Cosine similarity and Dot Product give *mathematically identical*
 *   rankings. However, we choose Cosine for three practical reasons:
 *
 *   1. ROBUSTNESS — If we ever mix in embeddings from a different model (e.g.
 *      local re-ranking with a fine-tuned model), those vectors may NOT be
 *      normalized. Cosine handles unnormalized vectors correctly; Dot Product
 *      would silently produce wrong rankings.
 *
 *   2. INTERPRETABILITY — Cosine scores are bounded [0, 1] for non-negative
 *      embeddings (which OpenAI's are). This makes it trivial to set meaningful
 *      score_threshold values (e.g. 0.3 = "weak match") without knowing the
 *      vector magnitudes. Dot Product scores have no fixed range.
 *
 *   3. CONVENTION — Qdrant's documentation, OpenAI's cookbook, and most RAG
 *      tutorials default to Cosine. Using the same convention reduces confusion
 *      for contributors and makes debugging easier.
 *
 * Dependencies: @qdrant/js-client-rest, @codesearch/shared
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type {
  EmbeddedChunk,
  ChunkPayload,
  VectorSearchResult,
  CollectionInfo,
} from "@codesearch/shared";

// ── Constants ─────────────────────────────────────────────────

/** Dimensionality of text-embedding-3-small vectors. */
const VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE ?? 768);

/** Maximum points per Qdrant upsert call. */
const UPSERT_BATCH_SIZE = 100;

/** Minimum cosine similarity to include in search results. */
const DEFAULT_SCORE_THRESHOLD = 0.3;

/** HNSW index parameters — higher values = better recall, slower indexing. */
const HNSW_M = 16;
const HNSW_EF_CONSTRUCT = 200;

// ── Collection Naming ─────────────────────────────────────────

/**
 * Derive a Qdrant-safe collection name from a repoId.
 *
 * Qdrant collection names must be alphanumeric + hyphens/underscores.
 * We SHA-256 hash the repoId and take the first 16 hex characters,
 * prefixed with "repo_" for readability.
 *
 * @example
 * toCollectionName("expressjs/express") → "repo_a1b2c3d4e5f6a7b8"
 */
export async function toCollectionName(repoId: string): Promise<string> {
  if (/^[A-Za-z0-9_-]{16}$/.test(repoId)) {
    return `repo_${repoId.toLowerCase()}`;
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(repoId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `repo_${hex.slice(0, 16)}`;
}

// ── Service Class ─────────────────────────────────────────────

/**
 * Manages all Qdrant operations for CodeSearch AI.
 *
 * Each GitHub repository gets its own Qdrant collection, named by a
 * deterministic hash of the repoId. This provides isolation between
 * repos and makes deletion/re-ingestion clean.
 *
 * @example
 * ```ts
 * const qdrant = new QdrantService("http://localhost:6333");
 *
 * await qdrant.ensureCollection("expressjs/express");
 * await qdrant.upsertChunks("expressjs/express", embeddedChunks);
 * const results = await qdrant.similaritySearch("expressjs/express", queryVec, 10);
 * ```
 */
export class QdrantService {
  private client: QdrantClient;
  private url: string;

  constructor(qdrantUrl: string = "http://localhost:6333") {
    this.url = qdrantUrl;
    this.client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
  }

  // ── Collection Lifecycle ──────────────────────────────────

  /**
   * Ensure a Qdrant collection exists for the given repo.
   *
   * If the collection already exists, this is a no-op.
   * If it doesn't exist, creates it with:
   *   - 1536-dimensional Cosine vectors
   *   - HNSW index: m=16, ef_construct=200
   *   - Payload indexes on filePath, language, symbolName (keyword type)
   *
   * @param repoId — Repository identifier (e.g. "expressjs/express")
   */
  async ensureCollection(repoId: string): Promise<void> {
    const collectionName = await toCollectionName(repoId);

    const exists = await this.collectionExists(repoId);
    if (exists) {
      console.log(`   Collection "${collectionName}" already exists, skipping creation`);
      return;
    }

    console.log(`   Creating Qdrant collection "${collectionName}" (${VECTOR_SIZE}d, Cosine)`);

    try {
      await this.client.createCollection(collectionName, {
        vectors: {
          size: VECTOR_SIZE,
          distance: "Cosine",
        },
        hnsw_config: {
          m: HNSW_M,
          ef_construct: HNSW_EF_CONSTRUCT,
        },
        // Start indexing immediately (no threshold wait)
        optimizers_config: {
          indexing_threshold: 0,
        },
      });
    } catch (err) {
      throw new Error(
        `Failed to create Qdrant collection "${collectionName}" at ${this.url}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Create payload indexes for efficient filtered searches
    await this.createPayloadIndexSafe(collectionName, "filePath", "keyword");
    await this.createPayloadIndexSafe(collectionName, "language", "keyword");
    await this.createPayloadIndexSafe(collectionName, "symbolName", "keyword");

    console.log(`   ✅ Collection "${collectionName}" created with payload indexes`);
  }

  /**
   * Check whether a collection exists for the given repo.
   */
  async collectionExists(repoId: string): Promise<boolean> {
    const collectionName = await toCollectionName(repoId);

    try {
      await this.client.getCollection(collectionName);
      return true;
    } catch (err) {
      if (isConnectionError(err)) {
        throw new Error(
          `Cannot connect to Qdrant at ${this.url}. ` +
          `Is Qdrant running? Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return false; // Not found means it doesn't exist
    }
  }

  /**
   * Get summary information about a repo's Qdrant collection.
   *
   * @throws {Error} If the collection doesn't exist
   */
  async getCollectionInfo(repoId: string): Promise<CollectionInfo> {
    const collectionName = await toCollectionName(repoId);

    try {
      const info = await this.client.getCollection(collectionName);
      return {
        vectorCount: info.vectors_count ?? info.points_count ?? 0,
        status: info.status,
      };
    } catch (err) {
      if (isConnectionError(err)) {
        throw new Error(
          `Cannot connect to Qdrant at ${this.url}. ` +
          `Is Qdrant running? Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw new Error(
        `Collection for repo "${repoId}" not found. ` +
        `Has the repo been ingested? Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Delete the Qdrant collection for a repo, removing all its vectors.
   *
   * No-op if the collection doesn't exist.
   */
  async deleteCollection(repoId: string): Promise<void> {
    const collectionName = await toCollectionName(repoId);

    const exists = await this.collectionExists(repoId);
    if (!exists) {
      console.log(`   Collection "${collectionName}" does not exist, nothing to delete`);
      return;
    }

    try {
      await this.client.deleteCollection(collectionName);
      console.log(`   🗑️  Deleted collection "${collectionName}"`);
    } catch (err) {
      throw new Error(
        `Failed to delete Qdrant collection "${collectionName}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Upsert ────────────────────────────────────────────────

  /**
   * Upsert embedded chunks into the repo's Qdrant collection.
   *
   * Chunks are upserted in batches of 100 for efficiency.
   * Uses Qdrant's upsert (not insert), so re-ingestion of the same
   * chunks is idempotent — existing points are overwritten by ID.
   *
   * @param repoId — Repository identifier
   * @param chunks — Embedded chunks from the EmbeddingService
   */
  async upsertChunks(repoId: string, chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) {
      console.log("   No chunks to upsert");
      return;
    }

    const collectionName = await toCollectionName(repoId);

    console.log(`   Upserting ${chunks.length} chunks to collection "${collectionName}"`);

    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);

      const points = batch.map((chunk) => ({
        id: chunk.id,
        vector: chunk.vector,
        payload: chunkToPayload(chunk),
      }));

      try {
        await this.client.upsert(collectionName, {
          wait: true,
          points,
        });
      } catch (err) {
        throw new Error(
          `Failed to upsert batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1} ` +
          `(chunks ${i + 1}–${i + batch.length}) to "${collectionName}": ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }

      const progress = Math.min(i + batch.length, chunks.length);
      console.log(`   Upserted ${progress}/${chunks.length} chunks to Qdrant`);
    }
  }

  // ── Search ────────────────────────────────────────────────

  /**
   * Perform a cosine similarity search against a repo's vector collection.
   *
   * @param repoId      — Repository to search within
   * @param queryVector — 1536-dimensional query embedding
   * @param topK        — Maximum number of results to return
   * @param filter      — Optional payload filter (e.g. narrow to a language)
   * @returns Ranked list of matching chunks with similarity scores
   */
  async similaritySearch(
    repoId: string,
    queryVector: number[],
    topK: number = 10,
    filter?: { language?: string },
  ): Promise<VectorSearchResult[]> {
    const collectionName = await toCollectionName(repoId);

    // Build Qdrant filter conditions
    const mustConditions: Array<Record<string, unknown>> = [];

    if (filter?.language) {
      mustConditions.push({
        key: "language",
        match: { value: filter.language },
      });
    }

    try {
      const results = await this.client.search(collectionName, {
        vector: queryVector,
        limit: topK,
        with_payload: true,
        score_threshold: DEFAULT_SCORE_THRESHOLD,
        ...(mustConditions.length > 0 && {
          filter: {
            must: mustConditions,
          },
        }),
      });

      return results.map((hit) => {
        const payload = hit.payload as Record<string, unknown>;

        return {
          id: String(hit.id),
          score: hit.score,
          payload: {
            repoId: String(payload.repoId ?? ""),
            filePath: String(payload.filePath ?? ""),
            startLine: Number(payload.startLine ?? 0),
            endLine: Number(payload.endLine ?? 0),
            content: String(payload.content ?? ""),
            language: String(payload.language ?? "other"),
            symbolName: payload.symbolName != null ? String(payload.symbolName) : null,
            tokenCount: Number(payload.tokenCount ?? 0),
          },
        };
      });
    } catch (err) {
      if (isConnectionError(err)) {
        throw new Error(
          `Cannot connect to Qdrant at ${this.url}. ` +
          `Is Qdrant running? Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw new Error(
        `Similarity search failed on collection "${collectionName}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Private Helpers ───────────────────────────────────────

  /**
   * Create a payload index, swallowing "already exists" errors.
   */
  private async createPayloadIndexSafe(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "text",
  ): Promise<void> {
    try {
      await this.client.createPayloadIndex(collectionName, {
        field_name: fieldName,
        field_schema: fieldSchema,
        wait: true,
      });
    } catch (err) {
      // Ignore "already exists" errors — this makes the method idempotent
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) {
        console.warn(`   ⚠️  Failed to create index on "${fieldName}": ${message}`);
      }
    }
  }
}

// ── Utility Functions ─────────────────────────────────────────

/**
 * Extract the payload fields from an EmbeddedChunk (everything except the vector).
 */
function chunkToPayload(chunk: EmbeddedChunk): ChunkPayload {
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

/**
 * Heuristic check for connection-level errors (network down, Qdrant not running).
 */
function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network error
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("Unable to connect")
  );
}
