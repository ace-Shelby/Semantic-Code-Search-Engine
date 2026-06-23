/**
 * @codesearch/ingestion — src/embedding-service.ts
 * ───────────────────────────────────────────────────────────────
 * Batch-embeds CodeChunk arrays via OpenAI text-embedding-3-small,
 * rate-limited by ace-throttle (distributed sliding-window over Redis).
 *
 * Handles:
 *   - Configurable batch sizes (default 16 chunks per API call)
 *   - Distributed rate limiting via ace-throttle + Redis
 *   - Exponential backoff on 429 / rate-limit errors (max 3 retries)
 *   - Progress callbacks for UI/logging
 *   - Defensive mismatch checks (embedding count vs input count)
 *   - Final summary logging (chunks, tokens, cost, duration)
 *
 * Dependencies: openai, ioredis, ace-throttle, @codesearch/shared
 */

import OpenAI from "openai";
import type { Redis } from "ioredis";
import {
  createRateLimiter,
  wrapRedisClient,
  asTierName,
  asRateLimitKey,
  type RateLimiter,
} from "ace-throttle";
import type {
  CodeChunk,
  EmbeddedChunk,
  EmbeddingProgress,
} from "@codesearch/shared";

// ── Constants ─────────────────────────────────────────────────

/** Dimensionality of the embedding vectors produced by text-embedding-3-small or Gemini. */
const VECTOR_DIMENSIONS = Number(process.env.QDRANT_VECTOR_SIZE ?? 768);

/** OpenAI pricing for text-embedding-3-small: $0.02 per 1M tokens. */
const COST_PER_MILLION_TOKENS = 0.02;

/** Maximum number of retry attempts on rate-limit (429) errors. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds. */
const BASE_BACKOFF_MS = 1000;

/** Rate limiter tier name. */
const RATE_LIMIT_TIER = asTierName("embedding");

// ── Configuration ─────────────────────────────────────────────

/** Configuration for the EmbeddingService constructor. */
export interface EmbeddingServiceConfig {
  /** OpenAI API key */
  openaiApiKey: string;
  /** Custom base URL for OpenAI-compatible endpoints like Gemini */
  openaiBaseUrl?: string;
  /** Embedding model to use */
  openaiEmbeddingModel?: string;
  /** ioredis client instance (used for distributed rate limiting) */
  redisClient: Redis;
  /** Number of chunks per OpenAI API call (default: 16) */
  batchSize?: number;
  /** Maximum embedding API requests per second (default: 20) */
  requestsPerSecond?: number;
}

// ── Service Class ─────────────────────────────────────────────

/**
 * Embeds code chunks in batches using OpenAI text-embedding-3-small.
 *
 * Rate-limited via ace-throttle (distributed sliding-window algorithm
 * backed by Redis) to stay within OpenAI API limits and prevent
 * quota exhaustion in multi-worker deployments.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 *
 * const service = new EmbeddingService({
 *   openaiApiKey: process.env.OPENAI_API_KEY!,
 *   redisClient: new Redis(),
 *   batchSize: 16,
 *   requestsPerSecond: 20,
 * });
 *
 * const embedded = await service.embedChunks(chunks, (progress) => {
 *   console.log(`${progress.processed}/${progress.total} chunks embedded`);
 * });
 * ```
 */
export class EmbeddingService {
  private openai: OpenAI;
  private limiter: RateLimiter;
  private batchSize: number;
  private embeddingModel: string;

  constructor(config: EmbeddingServiceConfig) {
    const {
      openaiApiKey,
      openaiBaseUrl,
      openaiEmbeddingModel,
      redisClient,
      batchSize = 16,
      requestsPerSecond = 20,
    } = config;

    this.openai = new OpenAI({ 
      apiKey: openaiApiKey,
      baseURL: openaiBaseUrl,
    });
    this.batchSize = batchSize;
    this.embeddingModel = openaiEmbeddingModel ?? "text-embedding-004";

    // ace-throttle uses a branded RedisClient wrapper over ioredis
    const wrappedRedis = wrapRedisClient(redisClient);

    this.limiter = createRateLimiter({
      redisClient: wrappedRedis,
      tiers: {
        embedding: {
          maxTokens: requestsPerSecond,
          windowSeconds: 1,
          algorithm: "sliding-window",
        },
      },
      defaultTier: RATE_LIMIT_TIER,
      keyPrefix: "codesearch:ratelimit:",
      // Fail open if Redis is down — we'd rather embed slowly than block entirely
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 30_000,
    });
  }

  /**
   * Embed an array of code chunks, returning them with vectors attached.
   *
   * Chunks are processed in batches of `batchSize`. Each batch is rate-limited
   * via ace-throttle and retried with exponential backoff on 429 errors.
   *
   * @param chunks      — Code chunks from the AST chunker
   * @param onProgress  — Optional callback invoked after each batch completes
   * @returns Array of {@link EmbeddedChunk}s in the same order as the input
   */
  async embedChunks(
    chunks: CodeChunk[],
    onProgress?: (progress: EmbeddingProgress) => void,
  ): Promise<EmbeddedChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    const startTime = performance.now();
    const results: EmbeddedChunk[] = [];
    let totalTokensUsed = 0;

    // Split into batches
    const batches = createBatches(chunks, this.batchSize);

    console.log(
      `🔢 Embedding ${chunks.length} chunks in ${batches.length} batches ` +
      `(batch size: ${this.batchSize})`
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // Rate-limit: wait until we're allowed to proceed
      await this.waitForRateLimit();

      // Embed the batch with retry logic
      const { embedded, tokensUsed } = await this.embedBatchWithRetry(batch, i + 1, batches.length);

      results.push(...embedded);
      totalTokensUsed += tokensUsed;

      // Report progress
      if (onProgress) {
        const progress: EmbeddingProgress = {
          total: chunks.length,
          processed: results.length,
          tokensUsed: totalTokensUsed,
          estimatedCost: computeCost(totalTokensUsed),
        };
        onProgress(progress);
      }
    }

    // Final summary
    const durationMs = Math.round(performance.now() - startTime);
    const durationSec = (durationMs / 1000).toFixed(1);
    const cost = computeCost(totalTokensUsed);

    console.log(
      `✅ Embedding complete: ${results.length} chunks, ` +
      `${totalTokensUsed.toLocaleString()} tokens, ` +
      `$${cost.toFixed(6)} estimated cost, ${durationSec}s`
    );

    return results;
  }

  /**
   * Wait for the distributed rate limiter to allow the next request.
   *
   * If the limiter says we're rate-limited, sleep for `retryAfter` seconds
   * and try again. This is a cooperative wait — no busy loop.
   */
  private async waitForRateLimit(): Promise<void> {
    const maxAttempts = 10; // Safety valve to prevent infinite loops
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.limiter.check({
        key: asRateLimitKey("openai-embedding"),
      });

      if (result.allowed) {
        return;
      }

      // Rate-limited — wait for the window to reset
      const waitMs = Math.max(result.retryAfter * 1000, 100);
      console.log(`   ⏳ Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(waitMs);
    }

    // If we exhaust all attempts, proceed anyway (fail-open philosophy)
    console.warn("   ⚠️  Rate limiter wait exhausted, proceeding anyway");
  }

  /**
   * Embed a single batch of chunks, with exponential backoff on 429 errors.
   *
   * @throws {Error} After MAX_RETRIES consecutive failures
   */
  private async embedBatchWithRetry(
    batch: CodeChunk[],
    batchIndex: number,
    totalBatches: number,
  ): Promise<{ embedded: EmbeddedChunk[]; tokensUsed: number }> {
    /*
     * Why we embed chunk.content directly rather than prepending the file path:
     *
     * Prepending metadata like "File: src/utils.ts\n\n" to every chunk's
     * embedding input sounds helpful but actually hurts retrieval quality:
     *
     * 1. QUERY MISMATCH — Users search with queries like "error handling
     *    middleware" not "src/middleware/error.ts". Prepending file paths
     *    shifts the embedding vector towards path-token semantics, making it
     *    harder for natural-language queries to find a close cosine match.
     *
     * 2. TOKEN WASTE — File paths consume tokens from the 8191-token input
     *    limit. For small chunks (our target is ≤600 tokens), a long path
     *    like "packages/api/src/routes/repos.ts" wastes 10+ tokens per chunk
     *    with no retrieval benefit.
     *
     * 3. METADATA IN PAYLOAD — We store filePath, language, and symbolName
     *    in Qdrant's payload alongside the vector. This lets us use payload
     *    filtering (exact match on repoId, language) which is far more
     *    precise than trying to encode structured metadata into a dense
     *    vector.
     *
     * 4. RE-RANKING — If file-path relevance matters, it's better handled
     *    in a re-ranking step after retrieval, where we can apply exact
     *    string matching or BM25 scoring on the metadata fields.
     */
    const inputs = batch.map((chunk) => chunk.content);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.openai.embeddings.create({
          model: this.embeddingModel,
          input: inputs,
          dimensions: VECTOR_DIMENSIONS,
        });

        // Defensive: verify OpenAI returned the right number of embeddings
        if (response.data.length !== batch.length) {
          throw new Error(
            `Embedding count mismatch: sent ${batch.length} inputs, ` +
            `received ${response.data.length} embeddings. ` +
            `This is unexpected — OpenAI should always return one embedding per input.`
          );
        }

        // Map embeddings back to chunks (OpenAI preserves input order)
        const embedded: EmbeddedChunk[] = batch.map((chunk, idx) => {
          const vector = response.data[idx].embedding;

          // Sanity check: verify vector dimensions
          if (vector.length !== VECTOR_DIMENSIONS) {
            throw new Error(
              `Unexpected vector dimensions: expected ${VECTOR_DIMENSIONS}, ` +
              `got ${vector.length} for chunk ${chunk.id}`
            );
          }

          return { ...chunk, vector };
        });

        const tokensUsed = response.usage?.total_tokens ?? 0;

        console.log(
          `   Batch ${batchIndex}/${totalBatches}: ` +
          `${batch.length} chunks, ${tokensUsed} tokens`
        );

        return { embedded, tokensUsed };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if this is a rate-limit (429) or server error (5xx) — worth retrying
        if (isRetryableError(err)) {
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          const jitter = Math.random() * 500;
          const waitMs = Math.round(backoffMs + jitter);

          console.warn(
            `   ⚠️  Batch ${batchIndex}/${totalBatches} failed ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}. ` +
            `Retrying in ${waitMs}ms...`
          );

          await sleep(waitMs);
          continue;
        }

        // Non-retryable error (auth failure, invalid input, etc.) — throw immediately
        throw lastError;
      }
    }

    // Exhausted all retries
    throw new Error(
      `Failed to embed batch ${batchIndex} after ${MAX_RETRIES} retries. ` +
      `Last error: ${lastError?.message ?? "unknown"}`
    );
  }
}

// ── Utility Functions ─────────────────────────────────────────

/**
 * Split an array into batches of at most `size` elements.
 */
function createBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Compute estimated cost in USD for text-embedding-3-small.
 * Pricing: $0.02 per 1 million tokens.
 */
function computeCost(totalTokens: number): number {
  return (totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS;
}

/**
 * Check whether an error is retryable (429, 5xx, or network error).
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.InternalServerError) return true;
  if (err instanceof OpenAI.APIConnectionError) return true;

  // Check for status code on generic API errors
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429 || (status !== undefined && status >= 500)) return true;
  }

  // Network errors
  if (err instanceof TypeError && "cause" in err) return true;

  return false;
}

/**
 * Async sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
