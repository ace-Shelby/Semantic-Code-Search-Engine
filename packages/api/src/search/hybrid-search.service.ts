/**
 * @codesearch/api — src/search/hybrid-search.service.ts
 * ───────────────────────────────────────────────────────────────
 * Main search orchestrator for vector, keyword, and hybrid retrieval.
 *
 * Hybrid mode runs vector and BM25 retrieval in parallel, then merges ranked
 * candidate lists with Reciprocal Rank Fusion.
 *
 * Dependencies: ioredis, @codesearch/shared, ./vector-search.service, ./rrf
 */

import type Redis from "ioredis";
import type {
  SearchMode,
  SearchRequest as SharedSearchRequest,
  SearchResult,
  ChunkPayload,
} from "@codesearch/shared";
import type {
  VectorSearchService,
  VectorSearchResult,
} from "./vector-search.service.ts";
import {
  reciprocalRankFusion,
  type RankedList,
} from "./rrf.ts";

// ── Constants ─────────────────────────────────────────────────

const RESULT_CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_TOP_K = 8;
const CANDIDATE_LIMIT = 20;

// ── Public Types ──────────────────────────────────────────────

export type SearchRequest =
  Pick<SharedSearchRequest, "query" | "repoId"> &
  Partial<Pick<SharedSearchRequest, "topK" | "mode">>;

export interface HybridSearchResult extends SearchResult {
  source: "vector" | "keyword" | "both";
  rrfScore: number;
  vectorScore?: number;
  bm25Score?: number;
}

export interface BM25Result {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface BM25Indexer {
  search(repoId: string, query: string, topK: number): Promise<BM25Result[]>;
}

interface ResultState {
  id: string;
  payload: ChunkPayload;
  vectorScore?: number;
  bm25Score?: number;
}

// ── Service Class ─────────────────────────────────────────────

export class HybridSearchService {
  constructor(
    private readonly vectorSearch: VectorSearchService,
    private readonly bm25Indexer: BM25Indexer,
    private readonly redisClient: Redis,
  ) {}

  async search(request: SearchRequest): Promise<HybridSearchResult[]> {
    if (!request.query.trim()) {
      return [];
    }

    const topK = normalizeTopK(request.topK);
    const mode = request.mode ?? "hybrid";
    const cacheKey = await toSearchCacheKey(request.query, request.repoId, mode);
    const cachedResults = await this.getCachedResults(cacheKey);

    if (cachedResults) {
      return cachedResults.slice(0, topK);
    }

    const fullResults = await this.executeSearch(request.query, request.repoId, mode);

    await this.setCachedResults(cacheKey, fullResults);
    return fullResults.slice(0, topK);
  }

  private async executeSearch(
    query: string,
    repoId: string,
    mode: SearchMode,
  ): Promise<HybridSearchResult[]> {
    if (mode === "vector") {
      const vectorResults = await this.vectorSearch.search({
        query,
        repoId,
        topK: CANDIDATE_LIMIT,
      });
      return mergeSearchResults(vectorResults, []);
    }

    if (mode === "keyword") {
      const bm25Results = await this.bm25Indexer.search(repoId, query, CANDIDATE_LIMIT);
      return mergeSearchResults([], bm25Results);
    }

    const [vectorResults, bm25Results] = await Promise.all([
      this.vectorSearch.search({
        query,
        repoId,
        topK: CANDIDATE_LIMIT,
      }),
      this.bm25Indexer.search(repoId, query, CANDIDATE_LIMIT),
    ]);

    return mergeSearchResults(vectorResults, bm25Results);
  }

  private async getCachedResults(cacheKey: string): Promise<HybridSearchResult[] | null> {
    let cached: string | null;

    try {
      cached = await this.redisClient.get(cacheKey);
    } catch (err) {
      console.warn(`Failed to read search cache key "${cacheKey}": ${formatError(err)}`);
      return null;
    }

    if (!cached) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached);
      return Array.isArray(parsed) ? parsed as HybridSearchResult[] : null;
    } catch {
      return null;
    }
  }

  private async setCachedResults(
    cacheKey: string,
    results: HybridSearchResult[],
  ): Promise<void> {
    try {
      await this.redisClient.set(
        cacheKey,
        JSON.stringify(results),
        "EX",
        RESULT_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      console.warn(`Failed to write search cache key "${cacheKey}": ${formatError(err)}`);
    }
  }
}

// ── Fusion ────────────────────────────────────────────────────

function mergeSearchResults(
  vectorResults: VectorSearchResult[],
  bm25Results: BM25Result[],
): HybridSearchResult[] {
  const states = new Map<string, ResultState>();
  const rankedLists: RankedList[] = [];

  if (vectorResults.length > 0) {
    rankedLists.push(vectorResults.map((result) => ({
      id: result.id,
      score: result.score,
    })));
  }

  if (bm25Results.length > 0) {
    rankedLists.push(bm25Results.map((result) => ({
      id: result.id,
      score: result.score,
    })));
  }

  for (const result of vectorResults) {
    states.set(result.id, {
      ...(states.get(result.id) ?? { id: result.id, payload: result.payload }),
      vectorScore: result.score,
    });
  }

  for (const result of bm25Results) {
    states.set(result.id, {
      ...(states.get(result.id) ?? { id: result.id, payload: result.payload }),
      bm25Score: result.score,
    });
  }

  const fused = reciprocalRankFusion(rankedLists);
  const maxRrfScore = fused[0]?.rrfScore ?? 0;

  return fused.flatMap((result) => {
    const state = states.get(result.id);
    if (!state) {
      return [];
    }

    return toHybridSearchResult(state, result.rrfScore, maxRrfScore);
  });
}

function toHybridSearchResult(
  state: ResultState,
  rrfScore: number,
  maxRrfScore: number,
): HybridSearchResult {
  return {
    id: state.id,
    filePath: state.payload.filePath,
    startLine: state.payload.startLine,
    endLine: state.payload.endLine,
    snippet: state.payload.content,
    score: normalizeScore(rrfScore, maxRrfScore),
    language: state.payload.language as SearchResult["language"],
    symbolName: state.payload.symbolName,
    source: getSourceTag(state),
    rrfScore,
    ...(state.vectorScore !== undefined && { vectorScore: state.vectorScore }),
    ...(state.bm25Score !== undefined && { bm25Score: state.bm25Score }),
  };
}

function getSourceTag(state: ResultState): HybridSearchResult["source"] {
  if (state.vectorScore !== undefined && state.bm25Score !== undefined) {
    return "both";
  }

  return state.vectorScore !== undefined ? "vector" : "keyword";
}

// ── Helpers ───────────────────────────────────────────────────

async function toSearchCacheKey(
  query: string,
  repoId: string,
  mode: SearchMode,
): Promise<string> {
  const encoded = new TextEncoder().encode(query + repoId + mode);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `search:${hash}`;
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  return Math.max(1, Math.floor(topK));
}

function normalizeScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, score / maxScore));
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? ` (${String(err.code)})` : "";
    return `${err.message}${code}`;
  }

  return String(err);
}
