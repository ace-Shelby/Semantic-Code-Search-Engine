/**
 * @codesearch/frontend — hooks/useAskStream.ts
 * ───────────────────────────────────────────────────────────────
 * Custom React hook for streaming RAG answers via SSE.
 *
 * Uses fetch() + ReadableStream reader (not EventSource) because
 * we need to POST a JSON body — EventSource only supports GET.
 *
 * The hook handles:
 *   • SSE line parsing (named events + default data lines)
 *   • Incremental answer accumulation
 *   • Search results (from `search_complete` event)
 *   • Citations (from `citations` event)
 *   • Stream completion (`[DONE]` sentinel)
 *   • Error events from the server
 *   • Abort on unmount or manual cancellation
 */

"use client";

import { useState, useCallback, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  language: string;
  symbolName: string | null;
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  relevanceScore: number;
}

export interface UseAskStreamReturn {
  /** Initiate a streaming ask request. */
  ask: (query: string, repoId: string) => void;
  /** The LLM answer text, accumulated token-by-token. */
  answer: string;
  /** Structured citations, available after stream completes. */
  citations: Citation[];
  /** Search results, available as soon as retrieval completes. */
  searchResults: SearchResult[];
  /** True while tokens are still being received. */
  isStreaming: boolean;
  /** Error message, if any. */
  error: string | null;
  /** Clear all state and abort any in-flight stream. */
  reset: () => void;
}

// ── Hook ──────────────────────────────────────────────────────

export function useAskStream(): UseAskStreamReturn {
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AbortController ref so we can cancel from reset() or unmount.
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    // Abort any in-flight request.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    setAnswer("");
    setCitations([]);
    setSearchResults([]);
    setIsStreaming(false);
    setError(null);
  }, []);

  const ask = useCallback(
    (query: string, repoId: string) => {
      // Abort any previous in-flight stream.
      if (abortRef.current) {
        abortRef.current.abort();
      }

      // Reset state for the new request.
      setAnswer("");
      setCitations([]);
      setSearchResults([]);
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Fire and forget — errors are handled inside.
      streamAsk(query, repoId, controller.signal, {
        onSearchComplete: (results) => setSearchResults(results),
        onToken: (token) => setAnswer((prev) => prev + token),
        onCitations: (cites) => setCitations(cites),
        onDone: () => setIsStreaming(false),
        onError: (msg) => {
          setError(msg);
          setIsStreaming(false);
        },
      });
    },
    [],
  );

  return { ask, answer, citations, searchResults, isStreaming, error, reset };
}

// ── Stream Consumer ───────────────────────────────────────────

interface StreamCallbacks {
  onSearchComplete: (results: SearchResult[]) => void;
  onToken: (token: string) => void;
  onCitations: (citations: Citation[]) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Fetch the SSE stream and parse it line-by-line.
 *
 * SSE format recap:
 *   event: <name>\n      — sets the event type for the next data line
 *   data: <payload>\n    — the data payload
 *   : comment\n          — ignored (used for keep-alive pings)
 *   \n                   — blank line terminates the current event
 *
 * We read from the ReadableStream in chunks (which may contain
 * partial lines), so we buffer incomplete lines and split on `\n`.
 */
async function streamAsk(
  query: string,
  repoId: string,
  signal: AbortSignal,
  callbacks: StreamCallbacks,
): Promise<void> {
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, repoId }),
      signal,
    });

    // If the backend returned a non-SSE response, it's an error (JSON body).
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const errorBody = await response.json().catch(() => null);
      const message =
        (errorBody as { message?: string })?.message ??
        `Server error (${response.status})`;
      callbacks.onError(message);
      return;
    }

    if (!response.body) {
      callbacks.onError("Empty response body");
      return;
    }

    // Read the stream chunk-by-chunk.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Buffer for incomplete lines across chunk boundaries.
    let buffer = "";
    // The current event type (set by `event:` lines, reset after dispatch).
    let currentEventType = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on newlines — process complete lines, keep the last
        // incomplete fragment in the buffer.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // ── Comment line (keep-alive ping) ─────────────────
          if (line.startsWith(":")) {
            continue;
          }

          // ── Event type line ────────────────────────────────
          if (line.startsWith("event: ")) {
            currentEventType = line.slice(7).trim();
            continue;
          }

          // ── Data line ──────────────────────────────────────
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);

            // Check for the [DONE] sentinel (not JSON).
            if (payload === "[DONE]") {
              callbacks.onDone();
              currentEventType = "";
              continue;
            }

            try {
              const parsed = JSON.parse(payload);

              if (currentEventType === "search_complete") {
                callbacks.onSearchComplete(parsed.results ?? []);
              } else if (currentEventType === "citations") {
                callbacks.onCitations(parsed.citations ?? []);
              } else if (currentEventType === "error") {
                callbacks.onError(parsed.error ?? "Unknown server error");
              } else {
                // Default event — token delta.
                // The backend sends `data: "token_text"\n\n` where the
                // payload is a JSON string.
                if (typeof parsed === "string") {
                  callbacks.onToken(parsed);
                }
              }
            } catch {
              // Non-JSON data line — treat as raw token text.
              // This is a safety fallback; the backend should always
              // send valid JSON.
              callbacks.onToken(payload);
            }

            // Reset event type after processing the data line.
            currentEventType = "";
            continue;
          }

          // ── Blank line (event terminator) ──────────────────
          // In SSE, a blank line signals the end of an event.
          // We've already processed the data, so just reset state.
          if (line.trim() === "") {
            currentEventType = "";
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If the stream ended without a [DONE] sentinel, still mark
    // as done so the UI doesn't show a perpetual loading state.
    callbacks.onDone();
  } catch (err) {
    // AbortError is expected when the user navigates away or calls reset().
    if (err instanceof DOMException && err.name === "AbortError") {
      callbacks.onDone();
      return;
    }

    callbacks.onError(
      err instanceof Error ? err.message : "An unexpected error occurred",
    );
  }
}
