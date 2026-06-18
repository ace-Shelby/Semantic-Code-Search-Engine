import type Redis from "ioredis";

/**
 * CacheService — a generic, JSON-serializing Redis cache layer.
 *
 * Design decisions:
 *   • JSON.stringify/parse for serialization — simple, debuggable via redis-cli.
 *   • SCAN for pattern invalidation — KEYS blocks the event loop on large keyspaces.
 *   • SETNX-based distributed lock for stampede protection — lightweight,
 *     no Redlock dependency needed for a single-node Redis deployment.
 *
 * Usage:
 *   const cache = new CacheService(redisClient);
 *   const { value, hit } = await cache.getOrSet("user:42", 60, () => fetchUser(42));
 */
export class CacheService {
  constructor(private readonly redis: Redis) {}

  // ─── Basic Get / Set ───────────────────────────────────────────────

  /**
   * Retrieve a cached value, deserializing from JSON.
   * Returns null on cache miss or if the stored value is not valid JSON.
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted or non-JSON data — treat as a miss rather than crashing the caller.
      return null;
    }
  }

  /**
   * Store a value as JSON. Optionally set a TTL (in seconds).
   * If no TTL is provided the key lives until explicitly deleted or evicted.
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  // ─── Cache-Aside (getOrSet) ────────────────────────────────────────

  /**
   * Cache-aside helper: returns the cached value if present, otherwise
   * calls `fetcher`, caches the result, and returns it.
   *
   * The `hit` flag lets callers track cache hit rate without extra lookups.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return { value: cached, hit: true };
    }

    const value = await fetcher();
    await this.set(key, value, ttlSeconds);
    return { value, hit: false };
  }

  // ─── Invalidation ─────────────────────────────────────────────────

  /** Delete a single cache entry. */
  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Delete all keys matching a glob pattern (e.g. "search:user:42:*").
   *
   * ⚠️  WHY SCAN INSTEAD OF KEYS?
   * ─────────────────────────────
   * The KEYS command iterates the *entire* keyspace in a single blocking call.
   * On a production Redis instance with millions of keys this:
   *   1. Blocks the Redis event loop for the duration of the scan — no other
   *      commands can be processed, effectively causing a full server freeze.
   *   2. Spikes memory because Redis builds the entire result set in memory
   *      before sending it to the client.
   *   3. Can trigger client-side timeouts if the keyspace is large enough.
   *
   * SCAN is cursor-based and processes keys in small batches (COUNT hint),
   * so it cooperatively yields between iterations, keeping Redis responsive.
   * The trade-off is slightly more round-trips, but that is negligible
   * compared to the catastrophic impact of a blocking KEYS call.
   */
  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = "0";

    do {
      // SCAN returns [nextCursor, matchedKeys[]].
      // COUNT 100 is a hint — Redis may return more or fewer keys per batch.
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        // Pipeline the DEL commands for the batch to minimise round-trips.
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  // ─── Stampede-Protected Write ──────────────────────────────────────

  /**
   * Fetch-and-cache with a distributed lock to prevent cache stampede.
   *
   * When N concurrent requests hit an expired key simultaneously, without
   * a lock all N would call the (potentially expensive) fetcher in parallel.
   * This method ensures only the lock-holder fetches; everyone else waits
   * for the result to appear in cache.
   *
   * Lock mechanism: SETNX on a `lock:{key}` key with a short TTL.
   * Waiters poll every 50ms for up to 5 seconds.
   *
   * @param lockTtlSeconds  Safety TTL on the lock itself (default 10s).
   *                         Prevents deadlocks if the lock-holder crashes.
   */
  async setWithLock<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
    lockTtlSeconds: number = 10,
  ): Promise<T> {
    const lockKey = `lock:${key}`;
    const maxWaitMs = 5_000;
    const pollIntervalMs = 50;

    // Try to acquire the lock.
    // SET key value EX ttl NX — atomic set-if-not-exists with expiry.
    const acquired = await this.redis.set(lockKey, "1", "EX", lockTtlSeconds, "NX");

    if (acquired === "OK") {
      // ── We are the lock-holder — fetch, cache, and release. ──
      try {
        const value = await fetcher();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        // Always release the lock, even if fetcher throws.
        await this.redis.del(lockKey);
      }
    }

    // ── Lock held by someone else — poll for the cached result. ──
    // On each iteration we also attempt to re-acquire the lock. If the
    // original holder crashed and its lock TTL expired, a waiter can step
    // in as the new fetcher instead of spinning for the full poll window.
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const cached = await this.get<T>(key);
      if (cached !== null) {
        return cached;
      }

      // Try to become the new lock-holder (handles expired-lock scenario).
      const retryAcquired = await this.redis.set(lockKey, "1", "EX", lockTtlSeconds, "NX");
      if (retryAcquired === "OK") {
        try {
          const value = await fetcher();
          await this.set(key, value, ttlSeconds);
          return value;
        } finally {
          await this.redis.del(lockKey);
        }
      }

      await this.sleep(pollIntervalMs);
    }

    // If we've waited 5s and still no result, the lock-holder likely failed.
    // Fall back to fetching ourselves rather than returning an error.
    const value = await fetcher();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
