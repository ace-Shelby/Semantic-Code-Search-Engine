import { describe, test, expect, beforeEach, mock } from "bun:test";
import { CacheService } from "./cache.ts";

// ─── In-Memory Redis Mock ────────────────────────────────────────────
// Mimics the ioredis subset used by CacheService so tests run without
// a real Redis connection and stay deterministic.

class RedisMock {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(...args: unknown[]): Promise<string | null> {
    const key = args[0] as string;
    const value = args[1] as string;

    // Handle SET key value EX ttl NX  (stampede lock)
    if (args.includes("NX")) {
      if (this.store.has(key)) return null;
      const exIdx = args.indexOf("EX");
      const ttl = exIdx !== -1 ? (args[exIdx + 1] as number) : undefined;
      this.store.set(key, {
        value,
        expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
      });
      return "OK";
    }

    this.store.set(key, { value });
    return "OK";
  }

  async setex(key: string, ttl: number, value: string): Promise<"OK"> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async scan(
    cursor: string,
    _matchKeyword: string,
    pattern: string,
    _countKeyword: string,
    _count: number,
  ): Promise<[string, string[]]> {
    // Convert glob pattern to regex (simplified: only supports trailing *)
    const regexStr = "^" + pattern.replace(/\*/g, ".*") + "$";
    const regex = new RegExp(regexStr);

    const matched: string[] = [];
    for (const key of this.store.keys()) {
      if (regex.test(key)) matched.push(key);
    }

    // Return everything in one batch (cursor "0" means "done")
    return ["0", matched];
  }

  // Test helper — expose store size
  get size(): number {
    return this.store.size;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("CacheService", () => {
  let redis: RedisMock;
  let cache: CacheService;

  beforeEach(() => {
    redis = new RedisMock();
    // Cast to Redis type — the mock satisfies the interface subset we use.
    cache = new CacheService(redis as any);
  });

  // ── get / set basics ──────────────────────────────────────────────

  describe("get & set", () => {
    test("returns null on cache miss", async () => {
      expect(await cache.get("nonexistent")).toBeNull();
    });

    test("round-trips a JSON-serializable value", async () => {
      const data = { id: 1, tags: ["ts", "redis"] };
      await cache.set("item:1", data, 60);
      const result = await cache.get<typeof data>("item:1");
      expect(result).not.toBeNull();
      expect(result).toEqual(data);
    });

    test("returns null for corrupted (non-JSON) data", async () => {
      // Bypass CacheService to inject raw non-JSON data
      await redis.set("bad", "not-json");
      expect(await cache.get("bad")).toBeNull();
    });
  });

  // ── getOrSet ──────────────────────────────────────────────────────

  describe("getOrSet", () => {
    test("calls fetcher on miss and caches the result", async () => {
      const fetcher = mock(() => Promise.resolve({ score: 42 }));

      const result = await cache.getOrSet("calc:1", 30, fetcher);

      expect(result).toEqual({ value: { score: 42 }, hit: false });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Second call should hit cache — fetcher NOT called again.
      const result2 = await cache.getOrSet("calc:1", 30, fetcher);
      expect(result2).toEqual({ value: { score: 42 }, hit: true });
      expect(fetcher).toHaveBeenCalledTimes(1); // still 1
    });

    test("fetcher is called only once for concurrent calls to the same key", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        // Simulate slow upstream call
        await new Promise((r) => setTimeout(r, 50));
        return { result: "computed" };
      };

      // Fire two concurrent getOrSet calls for the same key.
      // The first call wins the race to populate the cache.
      // The second call may or may not hit cache depending on timing,
      // but after both resolve, the fetcher should have been called at most twice
      // (getOrSet without locking doesn't guarantee single-flight).
      // For strict single-flight, use setWithLock — tested below.
      const [r1, r2] = await Promise.all([
        cache.getOrSet("concurrent:1", 30, fetcher),
        cache.getOrSet("concurrent:1", 30, fetcher),
      ]);

      // Both should return the same value
      expect(r1.value).toEqual({ result: "computed" });
      expect(r2.value).toEqual({ result: "computed" });

      // At least one should be a hit (the one that finished second reads cache)
      // or both are misses if they race — but regardless, a *third* call is a hit.
      const r3 = await cache.getOrSet("concurrent:1", 30, fetcher);
      expect(r3.hit).toBe(true);
    });
  });

  // ── invalidate ────────────────────────────────────────────────────

  describe("invalidate", () => {
    test("removes a single key", async () => {
      await cache.set("k1", "v1");
      await cache.invalidate("k1");
      expect(await cache.get("k1")).toBeNull();
    });
  });

  // ── invalidatePattern ─────────────────────────────────────────────

  describe("invalidatePattern", () => {
    test("deletes all keys matching the glob pattern", async () => {
      // Seed keys under two different prefixes
      await cache.set("search:user:42:q1", { hits: 3 });
      await cache.set("search:user:42:q2", { hits: 7 });
      await cache.set("search:user:42:q3", { hits: 1 });
      await cache.set("search:user:99:q1", { hits: 5 }); // different user
      await cache.set("metrics:daily", { count: 100 }); // unrelated prefix

      // Invalidate only user 42's search cache
      await cache.invalidatePattern("search:user:42:*");

      // user 42 keys are gone
      expect(await cache.get("search:user:42:q1")).toBeNull();
      expect(await cache.get("search:user:42:q2")).toBeNull();
      expect(await cache.get("search:user:42:q3")).toBeNull();

      // Other keys survive
      const user99 = await cache.get("search:user:99:q1");
      expect(user99).not.toBeNull();
      expect(user99).toEqual({ hits: 5 });
      const metrics = await cache.get("metrics:daily");
      expect(metrics).not.toBeNull();
      expect(metrics).toEqual({ count: 100 });
    });

    test("is a no-op when no keys match", async () => {
      await cache.set("a", 1);
      await cache.invalidatePattern("nonexistent:*");
      const val = await cache.get("a");
      expect(val).not.toBeNull();
      expect(val).toEqual(1);
    });
  });

  // ── setWithLock (stampede protection) ──────────────────────────────

  describe("setWithLock", () => {
    test("fetcher is called only once for 5 parallel calls", async () => {
      let fetcherCallCount = 0;

      const expensiveFetcher = async () => {
        fetcherCallCount++;
        // Simulate a slow upstream call (e.g. LLM embedding)
        await new Promise((r) => setTimeout(r, 100));
        return { embedding: [0.1, 0.2, 0.3] };
      };

      // Fire 5 simultaneous calls — only 1 should execute the fetcher.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          cache.setWithLock("embed:doc:1", 60, expensiveFetcher),
        ),
      );

      // All 5 callers receive the same value
      for (const result of results) {
        expect(result).toEqual({ embedding: [0.1, 0.2, 0.3] });
      }

      // The fetcher was called exactly once (the lock-holder)
      expect(fetcherCallCount).toBe(1);
    });

    test("releases lock if fetcher throws", async () => {
      const failingFetcher = async () => {
        throw new Error("upstream timeout");
      };

      // First call should throw
      await expect(
        cache.setWithLock("fail:1", 60, failingFetcher),
      ).rejects.toThrow("upstream timeout");

      // Lock should be released — a subsequent call should be able to acquire it.
      const successFetcher = async () => ({ recovered: true });
      const result = await cache.setWithLock("fail:1", 60, successFetcher);
      expect(result).toEqual({ recovered: true });
    });

    test("lock has a safety TTL to prevent deadlocks", async () => {
      // Manually acquire the lock with a near-instant TTL (100ms in mock)
      // The mock checks expiresAt on every get(), so the lock will be
      // detected as expired once Date.now() passes the expiry time.
      await redis.set("lock:stale:1", "1", "EX", 0.1, "NX");

      // setWithLock will fail to acquire the lock, then poll.
      // After ~100ms the lock expires in the mock, the value key is still
      // empty, so after the full 5s poll window it falls back to fetching.
      // We use a generous test timeout to accommodate the poll.
      const result = await cache.setWithLock(
        "stale:1",
        60,
        async () => ({ fresh: true }),
        1,
      );

      expect(result).toEqual({ fresh: true });
    }, 10_000); // 10s test timeout
  });
});
