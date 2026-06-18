/**
 * Pure Reciprocal Rank Fusion utilities.
 *
 * RRF combines ranked lists by rank position instead of raw score. That makes it
 * a good fit for hybrid retrieval where vector scores and BM25 scores live on
 * different scales.
 */

export interface RankedItem {
  id: string;
  score: number;
}

export type RankedList = RankedItem[];

export interface MergedResult {
  id: string;
  rrfScore: number;
  ranks: number[];
  scores: number[];
}

const DEFAULT_RRF_K = 60;

/**
 * Merge ranked lists using Reciprocal Rank Fusion.
 *
 * The default k=60 is the rank constant used in the original RRF paper and is a
 * pragmatic middle ground: it rewards high ranks, but still lets agreement
 * across multiple lists beat a single first-place hit. With k=0, rank 1 becomes
 * extremely dominant and the fused list behaves much more like "winner takes
 * most." With k=1000, rank differences are flattened so much that weak agreement
 * can outweigh genuinely strong rank positions.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  k: number = DEFAULT_RRF_K,
): MergedResult[] {
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`RRF k must be a non-negative finite number, received ${k}`);
  }

  const merged = new Map<string, MergedResult>();

  for (const list of lists) {
    const seenInList = new Set<string>();

    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      if (seenInList.has(item.id)) {
        continue;
      }
      seenInList.add(item.id);

      const rank = index + 1;
      const current = merged.get(item.id) ?? {
        id: item.id,
        rrfScore: 0,
        ranks: [],
        scores: [],
      };

      current.rrfScore += 1 / (k + rank);
      current.ranks.push(rank);
      current.scores.push(item.score);
      merged.set(item.id, current);
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) {
      return b.rrfScore - a.rrfScore;
    }

    const aBestRank = Math.min(...a.ranks);
    const bBestRank = Math.min(...b.ranks);
    if (aBestRank !== bBestRank) {
      return aBestRank - bBestRank;
    }

    return a.id.localeCompare(b.id);
  });
}
