/**
 * @codesearch/api — routes/search.ts
 * ───────────────────────────────────────────────────────────────
 * Semantic + hybrid code search endpoint.
 *
 *   POST /  — execute a search query against a repo's vectors
 *
 * Dependencies: hono, openai, @qdrant/js-client-rest, langfuse, @codesearch/shared
 */

import { Hono } from "hono";
import OpenAI from "openai";
import { qdrant, langfuse } from "../clients.ts";
import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  ApiError,
} from "@codesearch/shared";

export const searchRouter = new Hono();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
const COLLECTION = process.env.QDRANT_COLLECTION ?? "code_chunks";

searchRouter.post("/", async (c) => {
  const start = performance.now();
  const traceId = crypto.randomUUID();

  // ── Parse & Validate ────────────────────────────────────────
  const body = await c.req.json<Partial<SearchRequest>>();

  if (!body.query || typeof body.query !== "string") {
    const error: ApiError = {
      error: "VALIDATION_ERROR",
      message: "query is required and must be a non-empty string",
      traceId,
    };
    return c.json(error, 400);
  }

  if (!body.repoId || typeof body.repoId !== "string") {
    const error: ApiError = {
      error: "VALIDATION_ERROR",
      message: "repoId is required",
      traceId,
    };
    return c.json(error, 400);
  }

  const topK = body.topK ?? 10;
  const mode = body.mode ?? "hybrid";

  // ── Create LangFuse trace ──────────────────────────────────
  const trace = langfuse.trace({
    id: traceId,
    name: "code-search",
    metadata: { repoId: body.repoId, mode, topK },
  });

  // ── Embed the query ────────────────────────────────────────
  const embeddingSpan = trace.span({ name: "embed-query" });

  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: body.query,
  });

  const queryVector = embeddingResponse.data[0].embedding;
  embeddingSpan.end();

  // ── Search Qdrant ──────────────────────────────────────────
  const searchSpan = trace.span({ name: "qdrant-search" });

  const qdrantResults = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit: topK,
    filter: {
      must: [{ key: "repoId", match: { value: body.repoId } }],
    },
    with_payload: true,
  });

  searchSpan.end();

  // ── Map results ────────────────────────────────────────────
  const results: SearchResult[] = qdrantResults.map((hit) => {
    const payload = hit.payload as Record<string, unknown>;
    return {
      id: String(hit.id),
      filePath: String(payload.filePath ?? ""),
      startLine: Number(payload.startLine ?? 0),
      endLine: Number(payload.endLine ?? 0),
      snippet: String(payload.content ?? ""),
      score: hit.score,
      language: String(payload.language ?? "typescript") as SearchResult["language"],
      symbolName: payload.symbolName ? String(payload.symbolName) : null,
    };
  });

  const latencyMs = Math.round(performance.now() - start);

  trace.update({ output: { resultCount: results.length, latencyMs } });
  await langfuse.flushAsync();

  c.header("X-Trace-Id", traceId);

  const response: SearchResponse = { results, latencyMs, traceId };
  return c.json(response);
});
