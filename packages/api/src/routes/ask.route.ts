/**
 * @codesearch/api — routes/ask.route.ts
 * ───────────────────────────────────────────────────────────────
 * RAG endpoint with Server-Sent Events (SSE) streaming.
 *
 *   POST /  — answer a natural-language question about a repo's code
 *
 * Flow:
 *   1. Validate request with Zod (same schema as search route)
 *   2. Run HybridSearchService.search() to get top results
 *   3. Stream the LLM answer via SSE using RAGService.streamAnswer()
 *   4. After stream completes, send a final event with citations
 *
 * SSE Protocol:
 *   event: search_complete  data: {results: [...]}  — retrieval done
 *   data: {token}                                    — each text chunk
 *   : ping                                           — keep-alive (every 15s)
 *   data: [DONE]                                     — generation finished
 *   event: citations        data: {citations: [...]} — structured citations
 *   event: error            data: {error: "..."}     — error during generation
 *
 * Dependencies: hono, zod, @codesearch/shared,
 *               ../search/hybrid-search.service, ../rag/rag.service
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ApiError, ChunkPayload, SearchResult } from "@codesearch/shared";

import { qdrant, QDRANT_URL, redis } from "../clients.ts";
import {
  HybridSearchService,
  type HybridSearchResult,
  type BM25Indexer,
  type BM25Result,
} from "../search/hybrid-search.service.ts";
import { VectorSearchService } from "../search/vector-search.service.ts";
import {
  isQdrantConnectionError,
  QdrantService,
} from "../services/qdrant.service.ts";
import { RAGService } from "../rag/rag.service.ts";
import { observability } from "../clients.ts";
import { config } from "../config.ts";
import bm25Module from "wink-bm25-text-search";

// ── Validation ────────────────────────────────────────────────

const askRequestSchema = z.object({
  query: z.string().min(2).max(500),
  repoId: z.string().length(16),
  topK: z.number().int().min(1).max(20).default(8),
  mode: z.enum(["hybrid", "vector", "keyword"]).default("hybrid"),
});

type AskRequestBody = z.infer<typeof askRequestSchema>;

interface ValidationErrorResponse {
  error: "VALIDATION_ERROR";
  message: string;
  traceId: string;
  fieldErrors: z.typeToFlattenedError<AskRequestBody>["fieldErrors"];
  formErrors: string[];
}

interface RouteErrorResponse {
  error: string;
  message: string;
  traceId: string;
}

// ── BM25 Indexer (same implementation as search route) ────────

class RedisBM25Indexer implements BM25Indexer {
  async search(repoId: string, query: string, topK: number): Promise<BM25Result[]> {
    const limit = Math.max(Math.floor(topK), 0);
    if (limit === 0 || query.trim().length === 0) {
      return [];
    }

    const [serializedIndex, serializedChunks] = await Promise.all([
      redis.get(`repo:${repoId}:bm25`),
      redis.get(`repo:${repoId}:bm25:chunks`),
    ]);

    if (!serializedIndex || !serializedChunks) {
      return [];
    }

    const engine = bm25Module() as any;
    engine.defineConfig({ fldWeights: { content: 1.0, filePath: 0.5, symbolName: 4.0 } });
    engine.definePrepTasks([
      function tokenizeCodeText(input: string): string[] {
        return input
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(
            (token) =>
              token.length >= 2 &&
              !new Set([
                "const", "let", "var", "return", "function", "import", "export", "from",
                "class", "interface", "type", "async", "await",
              ]).has(token)
          );
      },
    ]);
    engine.importJSON(serializedIndex);

    const chunkLookup = JSON.parse(serializedChunks) as Record<string, ChunkPayload>;
    const hits = engine
      .search(query, limit + 3)
      .filter(([id]) => !id.startsWith("__bm25_internal_filler__"))
      .slice(0, limit);

    if (hits.length === 0) {
      return [];
    }

    const maxScore = Math.max(...hits.map(([, score]) => score));
    return hits.flatMap(([id, rawScore]) => {
      const payload = chunkLookup[id];
      if (!payload) {
        return [];
      }

      return {
        id,
        score: maxScore > 0 ? rawScore / maxScore : 0,
        payload,
      };
    });
  }
}

// ── Service Instances ─────────────────────────────────────────

const qdrantService = new QdrantService(qdrant);
const vectorSearchService = new VectorSearchService({
  openaiApiKey: config.openaiApiKey,
  openaiBaseUrl: config.openaiBaseUrl,
  openaiEmbeddingModel: config.openaiEmbeddingModel,
  qdrantUrl: config.qdrantUrl,
  redisClient: redis,
  qdrantService,
});
const bm25Indexer = new RedisBM25Indexer();
const hybridSearchService = new HybridSearchService(
  vectorSearchService,
  bm25Indexer,
  redis,
);
const ragService = new RAGService({
  openaiApiKey: config.openaiApiKey,
  openaiBaseUrl: config.openaiBaseUrl,
  openaiLlmModel: config.openaiLlmModel,
  maxContextTokens: 12_000,
});

// ── Keep-alive interval (15 seconds) ─────────────────────────

const PING_INTERVAL_MS = 15_000;

// ── Router ────────────────────────────────────────────────────

export const askRouteRouter = new Hono();

askRouteRouter.post("/", async (c) => {
  const traceId = crypto.randomUUID();
  const startMs = performance.now();
  let trace: ReturnType<typeof observability.createTrace> | undefined;

  try {
    // ── 1. Validate Request ─────────────────────────────────
    const parsed = askRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      const body: ValidationErrorResponse = {
        error: "VALIDATION_ERROR",
        message: "Invalid ask request",
        traceId,
        fieldErrors: flattened.fieldErrors,
        formErrors: flattened.formErrors,
      };

      return c.json(body, 422);
    }

    const request = parsed.data;

    trace = observability.createTrace({
      traceId,
      name: "rag-ask",
      tags: ["rag", request.repoId, request.query.slice(0, 50)],
    });

    // ── 2. Check Repository Exists ──────────────────────────
    const exists = await qdrantService.collectionExists(request.repoId);
    if (!exists) {
      const body: RouteErrorResponse = {
        error: "REPO_NOT_FOUND",
        message: `Repository "${request.repoId}" has not been indexed`,
        traceId,
      };

      return c.json(body, 404);
    }

    // ── 3. Retrieve Search Results ──────────────────────────
    const searchResults = await hybridSearchService.search({
      query: request.query,
      repoId: request.repoId,
      topK: request.topK,
      mode: request.mode,
      trace,
    });

    if (searchResults.length === 0) {
      const body: RouteErrorResponse = {
        error: "NO_RESULTS",
        message: "No relevant code found for this query in the indexed repository",
        traceId,
      };

      return c.json(body, 404);
    }

    // ── 4. Stream LLM Answer via SSE ────────────────────────
    //
    // We construct a ReadableStream manually rather than using
    // Hono's streamSSE helper because we need fine-grained control
    // over the ping timer lifecycle and abort signal propagation.
    //
    // Backpressure: The ReadableStream controller only enqueues
    // when the downstream consumer (HTTP response) is ready.
    // The async generator pauses at each `yield` until we call
    // `.next()`, so a slow client won't cause unbounded buffering.

    const encoder = new TextEncoder();
    let fullAnswer = "";
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let streamClosed = false;

    const body = new ReadableStream({
      async start(controller) {
        // Helper: enqueue only if the stream is still open.
        const enqueue = (chunk: string) => {
          if (!streamClosed) {
            controller.enqueue(encoder.encode(chunk));
          }
        };

        // Start the keep-alive ping timer.
        // SSE spec comment lines (starting with `:`) are ignored by
        // EventSource clients but keep proxies / load balancers from
        // closing the connection due to inactivity.
        pingTimer = setInterval(() => {
          enqueue(": ping\n\n");
        }, PING_INTERVAL_MS);

        try {
          // ── Send search results immediately ─────────────────
          // The frontend can render code snippets while the LLM
          // is still generating the answer.
          const clientResults = searchResults.map(toSearchResult);
          enqueue(formatSSE("search_complete", { results: clientResults }));

          // ── Stream LLM tokens ───────────────────────────────
          const generator = ragService.streamAnswer({
            query: request.query,
            searchResults,
            traceId,
            trace,
          });

          for await (const token of generator) {
            fullAnswer += token;

            // Default SSE event (no `event:` field) — the client
            // receives these on the `onmessage` handler or as
            // "message" events via fetch ReadableStream parsing.
            enqueue(`data: ${JSON.stringify(token)}\n\n`);
          }

          // ── Signal stream complete ──────────────────────────
          enqueue("data: [DONE]\n\n");

          // ── Send citations after full answer is available ───
          const citations = parseCitationsFromAnswer(fullAnswer, searchResults);
          enqueue(formatSSE("citations", { citations }));

          trace?.score("citationCount", citations.length, `${citations.length} citations found`);
          trace?.end({
            latencyMs: Math.round(performance.now() - startMs),
            answerLength: fullAnswer.length,
            citationCount: citations.length,
          });

          cleanup(controller);
        } catch (err) {
          let errorMessage =
            err instanceof Error ? err.message : "An unexpected error occurred";
          
          if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
            errorMessage = "You have exceeded the Google Gemini API rate limit. Please wait a minute and try again.";
          }

          try {
            enqueue(formatSSE("error", { error: errorMessage, traceId }));
          } catch {
            // Controller may already be errored — nothing we can do.
          }

          trace?.end({ error: errorMessage, latencyMs: Math.round(performance.now() - startMs) });
          cleanup(controller);
        }
      },

      cancel() {
        // Called when the client disconnects mid-stream (e.g. user
        // navigates away). Clean up the ping timer so it doesn't
        // leak.
        streamClosed = true;
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      },
    });

    function cleanup(controller: ReadableStreamDefaultController) {
      streamClosed = true;
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    }

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Trace-Id": traceId,
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    if (isQdrantConnectionError(err)) {
      const errorMessage = "Search service unavailable";
      trace?.end({ error: errorMessage, latencyMs: Math.round(performance.now() - startMs) });
      
      const body: RouteErrorResponse = {
        error: "SEARCH_SERVICE_UNAVAILABLE",
        message: errorMessage,
        traceId,
      };

      return c.json(body, 503);
    }

    const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
    trace?.end({ error: errorMessage, latencyMs: Math.round(performance.now() - startMs) });

    const body: RouteErrorResponse = {
      error: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      traceId,
    };

    return c.json(body, 500);
  }
});

// ── SSE Helpers ───────────────────────────────────────────────

/**
 * Format a named Server-Sent Event message.
 *
 * SSE spec:
 *   event: <eventName>\n
 *   data: <json>\n
 *   \n
 *
 * The trailing blank line terminates the event.
 */
function formatSSE(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Result Mapping ────────────────────────────────────────────

/**
 * Strip internal scoring fields before sending to the client.
 */
function toSearchResult(result: HybridSearchResult): SearchResult {
  return {
    id: result.id,
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    snippet: result.snippet,
    score: result.score,
    language: result.language,
    symbolName: result.symbolName,
  };
}

// ── Citation Parsing ──────────────────────────────────────────

/**
 * Extract [src:filepath:startLine-endLine] citation markers from
 * the LLM answer and match them to original search results.
 */
function parseCitationsFromAnswer(
  answerText: string,
  results: { filePath: string; startLine: number; endLine: number; score: number }[],
) {
  const citationRegex = /\[src:([^:]+):(\d+)-(\d+)\]/g;
  const seen = new Set<string>();
  const citations: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    relevanceScore: number;
  }> = [];

  let match: RegExpExecArray | null;
  while ((match = citationRegex.exec(answerText)) !== null) {
    const filePath = match[1];
    const startLine = parseInt(match[2], 10);
    const endLine = parseInt(match[3], 10);
    const dedupeKey = `${filePath}:${startLine}-${endLine}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const exactMatch = results.find(
      (r) =>
        r.filePath === filePath &&
        r.startLine === startLine &&
        r.endLine === endLine,
    );

    const fuzzyMatch =
      exactMatch ?? results.find((r) => r.filePath === filePath);

    citations.push({
      filePath,
      startLine,
      endLine,
      relevanceScore: exactMatch?.score ?? fuzzyMatch?.score ?? 0,
    });
  }

  return citations;
}

// ── Request Parsing ───────────────────────────────────────────

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
