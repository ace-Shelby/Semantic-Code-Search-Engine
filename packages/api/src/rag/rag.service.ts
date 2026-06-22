/**
 * @codesearch/api — src/rag/rag.service.ts
 * ───────────────────────────────────────────────────────────────
 * Retrieval-Augmented Generation service.
 *
 * Takes top-K hybrid search results, builds a token-budgeted context
 * window, and generates a cited answer via gpt-4o-mini (streaming or
 * non-streaming).
 *
 * Observability: Every call creates spans/generations under the
 * caller-provided TraceContext, recording:
 *   • context_window span — chunk count, total tokens, budget usage
 *   • llm_generation      — model, prompt/completion tokens, cost
 *   • citation_count score on the parent trace
 *
 * Dependencies: openai, tiktoken, @codesearch/shared
 */

import OpenAI from "openai";
import { encoding_for_model } from "tiktoken";
import type { RAGAnswer, Citation, TraceContext } from "@codesearch/shared";
import type { HybridSearchResult } from "../search/hybrid-search.service.ts";

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_MAX_CONTEXT_TOKENS = 12_000;
const LLM_MODEL = "gpt-4o-mini";
const LLM_TEMPERATURE = 0.2;
const LLM_MAX_COMPLETION_TOKENS = 2048;

/**
 * gpt-4o-mini pricing (USD per 1K tokens, as of 2024-07):
 * Prompt: $0.00015 / 1K,  Completion: $0.0006 / 1K
 */
const COST_PER_1K_PROMPT = 0.00015;
const COST_PER_1K_COMPLETION = 0.0006;

/**
 * Minimum number of chunks to include in the context window,
 * even if the first chunk alone exceeds the token budget.
 * Guarantees the LLM always has *some* code to reason about.
 */
const MIN_CONTEXT_CHUNKS = 2;

// ── Types ─────────────────────────────────────────────────────

export interface ContextChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  rrfScore: number;
}

interface ContextWindow {
  chunks: ContextChunk[];
  totalTokens: number;
}

export interface GenerateParams {
  query: string;
  searchResults: HybridSearchResult[];
  traceId: string;
  /** Caller-provided trace context for observability. */
  trace?: TraceContext;
}

// ── Service ───────────────────────────────────────────────────

export class RAGService {
  private readonly openai: OpenAI;
  private readonly maxContextTokens: number;

  /**
   * We lazily initialise the tiktoken encoder because the WASM
   * module it wraps is expensive to load. Once initialised we
   * reuse it for the lifetime of the process.
   */
  private encoder: ReturnType<typeof encoding_for_model> | null = null;

  constructor(config: { openaiApiKey: string; maxContextTokens?: number }) {
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Generate a complete (non-streaming) answer with citations.
   */
  async generateAnswer(params: GenerateParams): Promise<RAGAnswer> {
    const startMs = performance.now();
    const trace = params.trace;

    // ── Span: context window building ─────────────────────────
    const ctxSpan = trace?.startSpan("context_window", {
      maxContextTokens: this.maxContextTokens,
      inputResultCount: params.searchResults.length,
    });

    const { chunks, totalTokens } = this.buildContextWindow(params.searchResults);
    const messages = this.buildMessages(params.query, chunks);

    ctxSpan?.end(
      { chunkCount: chunks.length, totalTokens },
      { budgetUsage: `${Math.round((totalTokens / this.maxContextTokens) * 100)}%` },
    );

    // ── Generation: LLM call ──────────────────────────────────
    const gen = trace?.startGeneration(
      "llm_generation",
      { systemPrompt: messages[0]?.content, userPromptLength: String(messages[1]?.content).length },
      LLM_MODEL,
    );

    const response = await this.openai.chat.completions.create({
      model: LLM_MODEL,
      temperature: LLM_TEMPERATURE,
      max_tokens: LLM_MAX_COMPLETION_TOKENS,
      messages,
    });

    const answer = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const tokenCost = promptTokens + completionTokens;

    gen?.end({
      output: answer,
      usage: { promptTokens, completionTokens },
      model: LLM_MODEL,
    });

    // ── Citations ─────────────────────────────────────────────
    const citations = this.parseCitations(answer, params.searchResults);
    const latencyMs = Math.round(performance.now() - startMs);
    const estimatedCost = estimateUsdCost(promptTokens, completionTokens);

    // ── Scores & trace end ────────────────────────────────────
    trace?.score("citationCount", citations.length, `${citations.length} citations found`);
    trace?.end({
      latencyMs,
      tokenCost,
      estimatedCost,
      answerLength: answer.length,
      citationCount: citations.length,
    });

    return {
      answer,
      citations,
      tokenCost,
      latencyMs,
      traceId: params.traceId,
    };
  }

  /**
   * Stream the answer token-by-token as an async generator.
   *
   * Each yielded string is a text delta from the LLM. The consumer
   * (e.g. the SSE route) can forward each delta immediately, giving
   * the user instant feedback while the model is still generating.
   *
   * Backpressure is handled naturally by the async generator protocol:
   * the generator pauses at each `yield` until the consumer calls
   * `.next()`, so a slow consumer won't cause unbounded buffering.
   *
   * Observability: We wrap the stream in spans/generations so the
   * caller gets timing and token data even for streamed requests.
   * Note: OpenAI's streaming API returns usage in the final chunk
   * only when `stream_options.include_usage` is set, so we estimate
   * prompt tokens from the context window and track completion tokens
   * by counting yielded characters as a heuristic.
   */
  async *streamAnswer(params: GenerateParams): AsyncGenerator<string> {
    const trace = params.trace;

    // ── Span: context window building ─────────────────────────
    const ctxSpan = trace?.startSpan("context_window", {
      maxContextTokens: this.maxContextTokens,
      inputResultCount: params.searchResults.length,
    });

    const { chunks, totalTokens } = this.buildContextWindow(params.searchResults);
    const messages = this.buildMessages(params.query, chunks);

    ctxSpan?.end(
      { chunkCount: chunks.length, totalTokens },
      { budgetUsage: `${Math.round((totalTokens / this.maxContextTokens) * 100)}%` },
    );

    // ── Generation: LLM streaming call ────────────────────────
    const gen = trace?.startGeneration(
      "llm_generation",
      { systemPromptLength: String(messages[0]?.content).length, contextTokens: totalTokens },
      LLM_MODEL,
    );

    const stream = await this.openai.chat.completions.create({
      model: LLM_MODEL,
      temperature: LLM_TEMPERATURE,
      max_tokens: LLM_MAX_COMPLETION_TOKENS,
      messages,
      stream: true,
      // Request usage stats in the final streamed chunk.
      stream_options: { include_usage: true },
    });

    let completionTokens = 0;
    let promptTokens = totalTokens; // Best estimate from context
    let fullOutput = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullOutput += delta;
        yield delta;
      }

      // The final chunk with usage data (when stream_options.include_usage is set)
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
      }
    }

    // If the API didn't return usage (older API versions), estimate from output.
    if (completionTokens === 0 && fullOutput.length > 0) {
      const enc = this.getEncoder();
      completionTokens = enc.encode(fullOutput).length;
    }

    gen?.end({
      output: fullOutput,
      usage: { promptTokens, completionTokens },
      model: LLM_MODEL,
    });
  }

  // ── Context Window Builder ──────────────────────────────────

  /**
   * Select the highest-ranked search results that fit within the
   * token budget.
   *
   * Strategy:
   *   1. Sort by rrfScore descending (most relevant first).
   *   2. Count tokens for each chunk's content using tiktoken's
   *      cl100k_base encoding (the tokenizer for gpt-4o-mini).
   *   3. Greedily add chunks while under budget.
   *   4. Never truncate a chunk mid-line — it's all or nothing.
   *   5. Always include at least MIN_CONTEXT_CHUNKS so the LLM
   *      has enough context even if the first chunk is very large.
   */
  private buildContextWindow(results: HybridSearchResult[]): ContextWindow {
    const enc = this.getEncoder();

    // Sort by relevance (highest rrfScore first).
    const sorted = [...results].sort((a, b) => b.rrfScore - a.rrfScore);

    const selected: ContextChunk[] = [];
    let totalTokens = 0;

    for (const result of sorted) {
      const tokenCount = enc.encode(result.snippet).length;

      const wouldExceedBudget = totalTokens + tokenCount > this.maxContextTokens;
      const hasMinimumChunks = selected.length >= MIN_CONTEXT_CHUNKS;

      // If we've already hit the minimum chunk count and the next chunk
      // would blow the budget, stop here. But if we haven't reached
      // MIN_CONTEXT_CHUNKS yet, include it regardless of the budget.
      if (wouldExceedBudget && hasMinimumChunks) {
        break;
      }

      selected.push({
        filePath: result.filePath,
        startLine: result.startLine,
        endLine: result.endLine,
        content: result.snippet,
        tokenCount,
        rrfScore: result.rrfScore,
      });

      totalTokens += tokenCount;

      // If we're already past the budget (from the MIN_CONTEXT_CHUNKS
      // guarantee), stop adding more.
      if (totalTokens >= this.maxContextTokens && hasMinimumChunks) {
        break;
      }
    }

    return { chunks: selected, totalTokens };
  }

  // ── Prompt Construction ─────────────────────────────────────

  private buildMessages(
    query: string,
    chunks: ContextChunk[],
  ): OpenAI.ChatCompletionMessageParam[] {
    return [
      { role: "system" as const, content: this.buildSystemPrompt() },
      {
        role: "user" as const,
        content: [
          "## Retrieved Code Snippets\n",
          this.formatChunksForPrompt(chunks),
          "\n\n## Question\n",
          query,
        ].join(""),
      },
    ];
  }

  private buildSystemPrompt(): string {
    return [
      "You are an expert code search assistant. You answer questions about codebases based ONLY on the provided code snippets.",
      "",
      "Rules:",
      "1. Only reference code that appears in the provided snippets",
      "2. Always cite your sources using this exact format: [src:filepath:startLine-endLine]",
      "3. If the answer cannot be found in the provided snippets, say \"I could not find relevant code for this query in the indexed repository.\"",
      "4. Be concise and technical. Your audience is developers.",
      "5. Prefer showing code examples from the snippets over prose explanations.",
    ].join("\n");
  }

  /**
   * Format context chunks as clearly delimited blocks so the LLM
   * can easily identify file boundaries and line ranges.
   *
   * Format:
   *   === File: src/auth/middleware.ts (lines 12-45) ===
   *   [code content]
   */
  private formatChunksForPrompt(chunks: ContextChunk[]): string {
    return chunks
      .map(
        (chunk) =>
          `=== File: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine}) ===\n${chunk.content}`,
      )
      .join("\n\n");
  }

  // ── Citation Parser ─────────────────────────────────────────

  /**
   * Extract structured citations from the LLM's answer text.
   *
   * The system prompt instructs the model to cite using:
   *   [src:filepath:startLine-endLine]
   *
   * We match these patterns and look up the corresponding search
   * result to get a relevance score.
   */
  private parseCitations(
    answerText: string,
    results: HybridSearchResult[],
  ): Citation[] {
    // Match [src:some/path/file.ts:10-42]
    const citationRegex = /\[src:([^:]+):(\d+)-(\d+)\]/g;
    const seen = new Set<string>();
    const citations: Citation[] = [];

    let match: RegExpExecArray | null;
    while ((match = citationRegex.exec(answerText)) !== null) {
      const filePath = match[1];
      const startLine = parseInt(match[2], 10);
      const endLine = parseInt(match[3], 10);
      const dedupeKey = `${filePath}:${startLine}-${endLine}`;

      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Try to match back to an original search result for relevance score.
      const matchedResult = results.find(
        (r) =>
          r.filePath === filePath &&
          r.startLine === startLine &&
          r.endLine === endLine,
      );

      // If the LLM cited a range that partially overlaps a result,
      // do a fuzzy match on filePath alone as a fallback.
      const fuzzyResult =
        matchedResult ??
        results.find((r) => r.filePath === filePath);

      citations.push({
        filePath,
        startLine,
        endLine,
        relevanceScore: matchedResult?.score ?? fuzzyResult?.score ?? 0,
      });
    }

    return citations;
  }

  // ── Tiktoken Encoder ────────────────────────────────────────

  private getEncoder(): ReturnType<typeof encoding_for_model> {
    if (!this.encoder) {
      // cl100k_base is the encoding for gpt-4o-mini / gpt-4o / gpt-4-turbo.
      this.encoder = encoding_for_model(LLM_MODEL);
    }
    return this.encoder;
  }
}

// ── Helpers ───────────────────────────────────────────────────

function estimateUsdCost(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1000) * COST_PER_1K_PROMPT +
    (completionTokens / 1000) * COST_PER_1K_COMPLETION
  );
}
