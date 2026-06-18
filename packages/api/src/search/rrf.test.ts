/**
 * @codesearch/api — src/search/rrf.test.ts
 * ───────────────────────────────────────────────────────────────
 * Unit tests for pure Reciprocal Rank Fusion.
 *
 * Run this to verify:
 *   bun test packages/api/src/search/rrf.test.ts
 */

import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "./rrf.ts";

describe("reciprocalRankFusion", () => {
  test("item appearing in both lists at ranks 1 and 3 beats single-list rank 1", () => {
    const merged = reciprocalRankFusion([
      [
        { id: "shared", score: 0.95 },
        { id: "vector-only", score: 0.9 },
      ],
      [
        { id: "keyword-only", score: 1 },
        { id: "other", score: 0.8 },
        { id: "shared", score: 0.7 },
      ],
    ]);

    expect(merged[0].id).toBe("shared");
    expect(merged[0].rrfScore).toBeGreaterThan(
      merged.find((item) => item.id === "keyword-only")!.rrfScore,
    );
  });

  test("handles empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);

    const merged = reciprocalRankFusion([
      [],
      [{ id: "only-hit", score: 0.8 }],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("only-hit");
  });

  test("k parameter changes score sharpness", () => {
    const lowK = reciprocalRankFusion([[{ id: "a", score: 1 }]], 0)[0];
    const defaultK = reciprocalRankFusion([[{ id: "a", score: 1 }]])[0];
    const highK = reciprocalRankFusion([[{ id: "a", score: 1 }]], 1000)[0];

    expect(lowK.rrfScore).toBe(1);
    expect(lowK.rrfScore).toBeGreaterThan(defaultK.rrfScore);
    expect(defaultK.rrfScore).toBeGreaterThan(highK.rrfScore);
  });
});
