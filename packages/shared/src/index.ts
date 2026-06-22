/**
 * @codesearch/shared — barrel export
 * ───────────────────────────────────────────────────────────────
 * Re-exports all shared types and utilities so consumers can do:
 *   import type { CodeChunk } from "@codesearch/shared";
 *   import { CacheService } from "@codesearch/shared";
 *
 * Dependencies: ioredis
 */

export { CacheService } from "./cache.ts";
export {
  ObservabilityService,
  type TraceContext,
  type SpanContext,
  type GenerationContext,
} from "./observability.ts";

export type {
  SupportedLanguage,
  Language,
  RawFile,
  CodeChunk,
  EmbeddedChunk,
  EmbeddingProgress,
  SearchMode,
  SearchRequest,
  SearchResult,
  SearchResponse,
  Citation,
  RAGAnswer,
  IngestionStatus,
  IngestionJob,
  ApiError,
  HealthStatus,
  ChunkPayload,
  VectorSearchResult,
  CollectionInfo,
} from "./types.ts";
