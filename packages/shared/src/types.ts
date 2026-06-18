/**
 * @codesearch/shared — types.ts
 * ───────────────────────────────────────────────────────────────
 * Canonical TypeScript interfaces shared across the entire
 * CodeSearch AI monorepo (API, ingestion worker, frontend).
 *
 * Dependencies: none (pure type definitions)
 */

// ── Supported Languages ───────────────────────────────────────

/** Languages for which we ship tree-sitter grammars. */
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "tsx"
  | "jsx";

/** All languages the file walker can detect (superset of SupportedLanguage). */
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "markdown"
  | "json"
  | "other";

// ── File Walker Output ────────────────────────────────────────

/** A raw file discovered by the file walker, before AST chunking. */
export interface RawFile {
  /** Path relative to the repository root (e.g. "src/index.ts") */
  filePath: string;
  /** Full file content as a UTF-8 string */
  content: string;
  /** Detected programming language */
  language: Language;
  /** File size in bytes */
  sizeBytes: number;
  /** Total number of lines in the file */
  lineCount: number;
}

// ── Ingestion / Chunking ──────────────────────────────────────

/** A single chunk of source code produced by the ingestion pipeline. */
export interface CodeChunk {
  /** Deterministic ID — typically `${repoId}:${filePath}:${startLine}` */
  id: string;
  /** Unique identifier for the repository (e.g. "owner/repo@branch") */
  repoId: string;
  /** Path relative to the repository root */
  filePath: string;
  /** 1-based start line in the original file */
  startLine: number;
  /** 1-based end line (inclusive) in the original file */
  endLine: number;
  /** Raw source code text of the chunk */
  content: string;
  /** Programming language of the chunk */
  language: Language;
  /** Closest enclosing symbol name (function, class, etc.) — may be null */
  symbolName: string | null;
  /** Number of tokens (as counted by the embedding model's tokenizer) */
  tokenCount: number;
}

// ── Embedding ─────────────────────────────────────────────────

/** A code chunk with its vector embedding attached, ready for storage in Qdrant. */
export interface EmbeddedChunk extends CodeChunk {
  /** 1536-dimensional vector from text-embedding-3-small */
  vector: number[];
}

/** Progress snapshot emitted during batch embedding. */
export interface EmbeddingProgress {
  /** Total number of chunks to embed */
  total: number;
  /** Number of chunks processed so far */
  processed: number;
  /** Cumulative tokens consumed by the embedding API */
  tokensUsed: number;
  /** Estimated cost in USD (at $0.02 per 1M tokens for text-embedding-3-small) */
  estimatedCost: number;
}

// ── Search ────────────────────────────────────────────────────

export type SearchMode = "hybrid" | "vector" | "keyword";

/** Payload sent by the frontend to initiate a search. */
export interface SearchRequest {
  /** Natural-language or keyword query */
  query: string;
  /** Scope the search to a specific repository */
  repoId: string;
  /** Maximum number of results to return (default 10) */
  topK: number;
  /** Search strategy */
  mode: SearchMode;
}

/** A single search hit returned to the frontend. */
export interface SearchResult {
  /** Chunk ID that matched */
  id: string;
  /** File path relative to the repo root */
  filePath: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line (inclusive) */
  endLine: number;
  /** The matching source code snippet */
  snippet: string;
  /** Relevance score (0–1, higher is better) */
  score: number;
  /** Language of the matched chunk */
  language: SupportedLanguage;
  /** Enclosing symbol name, if any */
  symbolName: string | null;
}

/** Envelope returned by GET /api/v1/search. */
export interface SearchResponse {
  /** Ordered list of matching code chunks */
  results: SearchResult[];
  /** Server-side latency in milliseconds */
  latencyMs: number;
  /** LangFuse trace ID for this request */
  traceId: string;
}

// ── RAG (Retrieval-Augmented Generation) ──────────────────────

/** A citation pointing back to the source code that informed the answer. */
export interface Citation {
  /** File path relative to the repo root */
  filePath: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line (inclusive) */
  endLine: number;
  /** How relevant this citation is to the answer (0–1) */
  relevanceScore: number;
}

/** Envelope returned by POST /api/v1/ask. */
export interface RAGAnswer {
  /** LLM-generated answer in markdown */
  answer: string;
  /** Source code citations backing the answer */
  citations: Citation[];
  /** Estimated token cost of the LLM call */
  tokenCost: number;
  /** Server-side latency in milliseconds */
  latencyMs: number;
  /** LangFuse trace ID for this request */
  traceId: string;
}

// ── Ingestion Jobs ────────────────────────────────────────────

export type IngestionStatus = "pending" | "running" | "complete" | "failed";

/** Tracks the progress of a repository ingestion job. */
export interface IngestionJob {
  /** Unique job ID (UUID) */
  id: string;
  /** Full clone URL of the repository */
  repoUrl: string;
  /** Canonical repo identifier (e.g. "owner/repo@main") */
  repoId: string;
  /** Current status of the job */
  status: IngestionStatus;
  /** Completion progress as a fraction (0–1) */
  progress: number;
  /** Total number of code chunks discovered */
  totalChunks: number;
  /** Number of chunks that have been embedded and stored */
  processedChunks: number;
  /** Error message if status is "failed" */
  error?: string;
  /** ISO-8601 timestamp of job creation */
  createdAt: string;
  /** ISO-8601 timestamp of the last status update */
  updatedAt: string;
}

// ── API Error Envelope ────────────────────────────────────────

/** Standard error response returned by the API on any failure. */
export interface ApiError {
  /** Machine-readable error code (e.g. "RATE_LIMITED", "NOT_FOUND") */
  error: string;
  /** Human-readable description */
  message: string;
  /** LangFuse trace ID for debugging */
  traceId: string;
}

// ── Health Check ──────────────────────────────────────────────

/** Response shape for GET /health. */
export interface HealthStatus {
  status: "ok" | "degraded";
  qdrant: boolean;
  redis: boolean;
}

// ── Qdrant / Vector Storage ───────────────────────────────────

/** Payload stored alongside each vector in Qdrant (mirrors CodeChunk minus the vector). */
export interface ChunkPayload {
  repoId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  symbolName: string | null;
  tokenCount: number;
}

/** A single result from a Qdrant similarity search. */
export interface VectorSearchResult {
  /** Point ID (matches the original CodeChunk.id) */
  id: string;
  /** Cosine similarity score (0–1, higher is better) */
  score: number;
  /** The stored chunk metadata */
  payload: ChunkPayload;
}

/** Summary info about a Qdrant collection. */
export interface CollectionInfo {
  /** Total number of indexed vectors */
  vectorCount: number;
  /** Collection status (e.g. "green", "yellow", "grey") */
  status: string;
}
