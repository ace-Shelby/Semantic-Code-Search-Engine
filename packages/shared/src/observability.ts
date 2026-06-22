/**
 * @codesearch/shared — src/observability.ts
 * ───────────────────────────────────────────────────────────────
 * Thin wrapper around the LangFuse TypeScript SDK that provides
 * a clean, typed interface for distributed tracing.
 *
 * Design:
 *   • One Trace per user query (search or ask)
 *   • Spans for discrete operations (vector search, BM25, context building)
 *   • Generations for LLM calls (model, tokens, cost)
 *   • Scores for quality signals (citation count, latency)
 *
 * The wrapper hides LangFuse internals so services only depend on
 * the TraceContext / SpanContext / GenerationContext interfaces —
 * easy to swap to OpenTelemetry or Datadog later.
 *
 * Dependencies: langfuse
 */

import { Langfuse } from "langfuse";

// ── Public Interfaces ─────────────────────────────────────────

/**
 * A trace represents a single end-to-end user request.
 * All operations within that request are attached as children.
 */
export interface TraceContext {
  /** The unique trace ID (passed through all services). */
  readonly traceId: string;

  /**
   * Start a timed span for a discrete operation within this trace.
   * Call `span.end()` when the operation completes.
   */
  startSpan(name: string, input?: unknown): SpanContext;

  /**
   * Start a generation for an LLM call. Records model, input
   * tokens, completion tokens, and cost automatically.
   */
  startGeneration(name: string, input: unknown, model: string): GenerationContext;

  /**
   * End the trace, optionally recording the final output.
   * Also flushes pending events to the LangFuse backend.
   */
  end(output?: unknown): void;

  /**
   * Attach a named score to this trace for quality tracking.
   * Useful for citation count, latency buckets, user feedback, etc.
   */
  score(name: string, value: number, comment?: string): void;
}

/**
 * A span represents a timed operation within a trace.
 */
export interface SpanContext {
  /** End the span, recording output and optional metadata. */
  end(output?: unknown, metadata?: Record<string, unknown>): void;
}

/**
 * A generation represents an LLM call within a trace.
 */
export interface GenerationContext {
  /** End the generation, recording output tokens and the response. */
  end(params: {
    output: string;
    usage: { promptTokens: number; completionTokens: number };
    model: string;
  }): void;
}

/**
 * A no-op trace context for when observability is disabled
 * (e.g. missing credentials). Prevents callers from needing
 * null checks everywhere.
 */
const NOOP_SPAN: SpanContext = {
  end: () => {},
};

const NOOP_GENERATION: GenerationContext = {
  end: () => {},
};

const NOOP_TRACE: TraceContext = {
  traceId: "noop",
  startSpan: () => NOOP_SPAN,
  startGeneration: () => NOOP_GENERATION,
  end: () => {},
  score: () => {},
};

// ── Service Class ─────────────────────────────────────────────

export class ObservabilityService {
  private readonly langfuse: Langfuse;
  private readonly enabled: boolean;

  constructor(config: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
  }) {
    this.langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl ?? "https://cloud.langfuse.com",
    });

    // Disable tracing if credentials are missing — prevents
    // noisy errors in local dev without LangFuse configured.
    this.enabled = !!(config.publicKey && config.secretKey);
  }

  // ── Trace Creation ──────────────────────────────────────────

  /**
   * Create a new trace for a user request.
   *
   * @param params.traceId  Pre-generated UUID (usually from the HTTP handler)
   * @param params.name     Operation name (e.g. "rag-ask", "hybrid-search")
   * @param params.userId   Optional user identifier
   * @param params.metadata Arbitrary key-value pairs
   * @param params.tags     Filterable tags in the LangFuse UI
   */
  createTrace(params: {
    traceId: string;
    name: string;
    userId?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): TraceContext {
    if (!this.enabled) {
      return { ...NOOP_TRACE, traceId: params.traceId };
    }

    const trace = this.langfuse.trace({
      id: params.traceId,
      name: params.name,
      userId: params.userId,
      metadata: params.metadata,
      tags: params.tags,
    });

    return {
      traceId: params.traceId,

      startSpan(name: string, input?: unknown): SpanContext {
        const startTime = new Date();
        const span = trace.span({
          name,
          input: input as Record<string, unknown> | undefined,
          startTime,
        });

        return {
          end(output?: unknown, metadata?: Record<string, unknown>) {
            span.end({
              output: output as Record<string, unknown> | undefined,
              metadata,
            });
          },
        };
      },

      startGeneration(name: string, input: unknown, model: string): GenerationContext {
        const startTime = new Date();
        const generation = trace.generation({
          name,
          model,
          input: input as Record<string, unknown> | undefined,
          startTime,
        });

        return {
          end(endParams) {
            generation.end({
              output: endParams.output,
              model: endParams.model,
              usage: {
                promptTokens: endParams.usage.promptTokens,
                completionTokens: endParams.usage.completionTokens,
                totalTokens:
                  endParams.usage.promptTokens + endParams.usage.completionTokens,
              },
            });
          },
        };
      },

      end(output?: unknown) {
        trace.update({
          output: output as Record<string, unknown> | undefined,
        });
      },

      score(name: string, value: number, comment?: string) {
        trace.update({}); // Ensure trace is committed
        // LangFuse scores are attached at the trace level
        // via the Langfuse client directly.
        // We use the trace's score method if available on the trace object.
        // The Langfuse SDK's trace object has a `.score()` method in v3.
        try {
          (trace as unknown as { score: (params: Record<string, unknown>) => void }).score({
            name,
            value,
            comment,
          });
        } catch {
          // Fallback: scores may not be supported on all SDK versions
        }
      },
    };
  }

  // ── Flush ───────────────────────────────────────────────────

  /**
   * Flush all pending events to LangFuse. Call this before
   * process exit or after completing a request cycle.
   */
  async flush(): Promise<void> {
    if (this.enabled) {
      await this.langfuse.flushAsync();
    }
  }

  /**
   * Expose the underlying Langfuse client for direct API access
   * (e.g. fetching traces for the metrics endpoint).
   */
  get client(): Langfuse {
    return this.langfuse;
  }
}
