/**
 * @codesearch/frontend — components/StreamingAnswer.tsx
 * ───────────────────────────────────────────────────────────────
 * Renders the full ask experience:
 *   1. Search results appear instantly when retrieval completes
 *   2. LLM answer streams in token-by-token with a blinking cursor
 *   3. Citations render as a list after streaming completes
 *   4. Errors show a clean, non-intrusive banner
 *
 * Dependencies: hooks/useAskStream
 */

"use client";

import { useRef, useEffect } from "react";
import {
  useAskStream,
  type SearchResult,
  type Citation,
} from "@frontend/hooks/useAskStream";
import styles from "./StreamingAnswer.module.css";

// ── Main Component ────────────────────────────────────────────

export function StreamingAnswer({ repoId }: { repoId: string }) {
  const { ask, answer, citations, searchResults, isStreaming, error, reset } =
    useAskStream();

  const inputRef = useRef<HTMLInputElement>(null);
  const answerEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest streamed content.
  useEffect(() => {
    if (isStreaming && answerEndRef.current) {
      answerEndRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [answer, isStreaming]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = inputRef.current?.value.trim();
    if (!query) return;
    ask(query, repoId);
  };

  const handleReset = () => {
    reset();
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
  };

  return (
    <section className={styles.container} id="streaming-answer">
      {/* ── Query Input ──────────────────────────────────────── */}
      <form className={styles.form} onSubmit={handleSubmit} id="ask-form">
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="Ask a question about this codebase…"
          disabled={isStreaming}
          id="ask-input"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className={styles.submitButton}
          disabled={isStreaming}
          id="ask-submit"
        >
          {isStreaming ? (
            <span className={styles.spinner} aria-label="Loading" />
          ) : (
            "Ask"
          )}
        </button>
        {(answer || error) && (
          <button
            type="button"
            className={styles.resetButton}
            onClick={handleReset}
            id="ask-reset"
          >
            Clear
          </button>
        )}
      </form>

      {/* ── Error Banner ─────────────────────────────────────── */}
      {error && (
        <div className={styles.errorBanner} role="alert" id="ask-error">
          <span className={styles.errorIcon}>⚠</span>
          <p className={styles.errorText}>{error}</p>
        </div>
      )}

      {/* ── Search Results ───────────────────────────────────── */}
      {searchResults.length > 0 && (
        <div className={styles.searchResults} id="search-results">
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>🔍</span>
            Retrieved Code Snippets
            <span className={styles.resultCount}>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </span>
          </h3>
          <div className={styles.snippetGrid}>
            {searchResults.map((result) => (
              <SearchResultCard key={result.id} result={result} />
            ))}
          </div>
        </div>
      )}

      {/* ── Streaming Answer ─────────────────────────────────── */}
      {(answer || isStreaming) && (
        <div className={styles.answerSection} id="answer-section">
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>✨</span>
            Answer
            {isStreaming && (
              <span className={styles.streamingBadge}>Generating…</span>
            )}
          </h3>
          <div className={styles.answerBody}>
            <pre className={styles.answerText}>
              {answer}
              {isStreaming && <span className={styles.cursor}>▊</span>}
            </pre>
            <div ref={answerEndRef} />
          </div>
        </div>
      )}

      {/* ── Citations ────────────────────────────────────────── */}
      {citations.length > 0 && !isStreaming && (
        <div className={styles.citationsSection} id="citations-section">
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>📎</span>
            Sources
          </h3>
          <ul className={styles.citationList}>
            {citations.map((citation, i) => (
              <CitationItem key={`${citation.filePath}:${citation.startLine}`} citation={citation} index={i} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ── Sub-Components ────────────────────────────────────────────

function SearchResultCard({ result }: { result: SearchResult }) {
  return (
    <div className={styles.snippetCard}>
      <div className={styles.snippetHeader}>
        <span className={styles.filePath}>{result.filePath}</span>
        <span className={styles.lineRange}>
          L{result.startLine}–{result.endLine}
        </span>
        <span className={styles.language}>{result.language}</span>
      </div>
      {result.symbolName && (
        <span className={styles.symbolName}>{result.symbolName}</span>
      )}
      <pre className={styles.snippetCode}>{result.snippet}</pre>
      <div className={styles.snippetFooter}>
        <div className={styles.scoreBar}>
          <div
            className={styles.scoreFill}
            style={{ width: `${Math.round(result.score * 100)}%` }}
          />
        </div>
        <span className={styles.scoreLabel}>
          {Math.round(result.score * 100)}% match
        </span>
      </div>
    </div>
  );
}

function CitationItem({ citation, index }: { citation: Citation; index: number }) {
  return (
    <li className={styles.citationItem}>
      <span className={styles.citationIndex}>{index + 1}</span>
      <div className={styles.citationDetail}>
        <span className={styles.citationPath}>{citation.filePath}</span>
        <span className={styles.citationLines}>
          lines {citation.startLine}–{citation.endLine}
        </span>
      </div>
      <span className={styles.citationScore}>
        {Math.round(citation.relevanceScore * 100)}%
      </span>
    </li>
  );
}
