"use client";

import { useState } from "react";
import {
  FileCode2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { SyntaxHighlight } from "./SyntaxHighlight";

// ── Types ─────────────────────────────────────────────────────

export interface SearchResultItem {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  language: string;
  symbolName: string | null;
  source?: "vector" | "keyword" | "both";
  rrfScore?: number;
}

interface SearchResultsProps {
  results: SearchResultItem[];
  repoUrl: string;
}

// ── Language badge colors ─────────────────────────────────────

const LANG_COLORS: Record<string, string> = {
  typescript: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  tsx: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  javascript: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  jsx: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  python: "bg-green-500/10 text-green-400 border-green-500/20",
  go: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  rust: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  other: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const SOURCE_COLORS: Record<string, string> = {
  vector: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  keyword: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  both: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
};

// ── Helpers ───────────────────────────────────────────────────

function truncateLeft(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return "…/" + path.slice(path.length - maxLen + 2);
}

function githubFileUrl(repoUrl: string, filePath: string, startLine: number, endLine: number): string {
  if (!repoUrl) return "#";
  return `${repoUrl}/blob/main/${filePath}#L${startLine}-L${endLine}`;
}

// ── Component ─────────────────────────────────────────────────

export function SearchResults({ results, repoUrl }: SearchResultsProps) {
  return (
    <div className="flex flex-col gap-3">
      {results.map((result) => (
        <ResultCard key={result.id} result={result} repoUrl={repoUrl} />
      ))}
    </div>
  );
}

function ResultCard({
  result,
  repoUrl,
}: {
  result: SearchResultItem;
  repoUrl: string;
}) {
  const lineCount = result.snippet.split("\n").length;
  const isLong = lineCount > 15;
  const [expanded, setExpanded] = useState(!isLong);

  const langColor = LANG_COLORS[result.language] ?? LANG_COLORS.other;
  const sourceColor = result.source ? SOURCE_COLORS[result.source] ?? "" : "";

  const displaySnippet = expanded
    ? result.snippet
    : result.snippet.split("\n").slice(0, 15).join("\n");

  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised overflow-hidden transition-colors hover:border-surface-border/80">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-surface-border/50">
        <FileCode2 className="h-3.5 w-3.5 text-gray-500 shrink-0" />
        <span className="font-mono text-xs text-gray-300 truncate" title={result.filePath}>
          {truncateLeft(result.filePath)}
        </span>

        <span className="text-xs text-gray-600">
          Lines {result.startLine}–{result.endLine}
        </span>

        {/* ── Badges ─────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 ml-auto">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${langColor}`}
          >
            {result.language}
          </span>

          {result.source && (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${sourceColor}`}
            >
              {result.source}
            </span>
          )}

          {result.symbolName && (
            <span className="rounded-md border border-surface-border bg-surface px-1.5 py-0.5 text-[10px] text-gray-400 font-mono">
              {result.symbolName}
            </span>
          )}
        </div>
      </div>

      {/* ── Code Snippet ─────────────────────────────────────── */}
      <div className="relative">
        <SyntaxHighlight
          code={displaySnippet}
          language={result.language}
          startLine={result.startLine}
        />

        {/* Fade overlay when collapsed */}
        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-surface-border/50">
        <div className="flex items-center gap-3">
          {/* Score bar */}
          <div className="flex items-center gap-2">
            <div className="h-1 w-16 rounded-full bg-surface-border overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all"
                style={{ width: `${Math.round(result.score * 100)}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-500">
              {Math.round(result.score * 100)}%
            </span>
          </div>

          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronDown className="h-3 w-3" />
                  Collapse
                </>
              ) : (
                <>
                  <ChevronRight className="h-3 w-3" />
                  Show all {lineCount} lines
                </>
              )}
            </button>
          )}
        </div>

        {repoUrl && (
          <a
            href={githubFileUrl(repoUrl, result.filePath, result.startLine, result.endLine)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-accent transition-colors"
          >
            View on GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}
