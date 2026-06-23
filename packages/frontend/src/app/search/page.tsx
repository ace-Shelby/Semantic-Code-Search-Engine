"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Search,
  Command,
  Loader2,
  Terminal,
  ChevronDown,
  CornerDownLeft,
  AlertTriangle,
  GitBranch,
  Sparkles
} from "lucide-react";
import { SearchResults, type SearchResultItem } from "@frontend/components/SearchResults";
import { StreamingAnswer } from "@frontend/components/StreamingAnswer";

// ── Types ─────────────────────────────────────────────────────

type SearchMode = "hybrid" | "vector" | "keyword";

interface SearchResponse {
  results: SearchResultItem[];
  latencyMs: number;
  traceId: string;
}

const BACKEND_URL = "/api/proxy";

// ── Inner component that uses useSearchParams ─────────────────

function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const repoId = searchParams.get("repoId") ?? "";
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ── Fetch repo info ─────────────────────────────────────────
  useEffect(() => {
    if (!repoId) return;
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/repos/${repoId}/status`);
        if (res.ok) {
          const data = await res.json();
          setRepoUrl(data.repoUrl ?? "");
        }
      } catch { /* non-critical */ }
    })();
  }, [repoId]);

  // ── Cmd+K shortcut ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Search handler ──────────────────────────────────────────
  const handleSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!query.trim() || !repoId || isSearching) return;

      setError(null);
      setIsSearching(true);
      setShowAI(false);

      try {
        const res = await fetch(`${BACKEND_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: query.trim(), repoId, topK: 10, mode }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body as { message?: string })?.message ?? `Search failed (${res.status})`
          );
        }

        const data: SearchResponse = await res.json();
        setResults(data.results);
        setLatencyMs(data.latencyMs);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    },
    [query, repoId, mode, isSearching]
  );

  if (!repoId) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center text-[#EAEAEA]">
        <p className="text-[#888] mb-4 text-[15px]">No repository selected.</p>
        <button
          onClick={() => router.push("/")}
          className="text-white hover:text-brand-400 transition-colors text-[14px] font-medium border border-white/10 px-4 py-2 rounded-lg bg-white/5"
        >
          Return to Dashboard
        </button>
      </div>
    );
  }

  const repoName = repoUrl
    ? (() => {
        try {
          const parts = new URL(repoUrl).pathname.split("/").filter(Boolean);
          return parts.slice(0, 2).join("/");
        } catch {
          return repoId;
        }
      })()
    : repoId;

  return (
    <div className="flex flex-col w-full text-[#EAEAEA] font-sans selection:bg-brand-500/30 selection:text-white items-center relative">
      
      {/* ── Background Detail ────────────────────────────────── */}
      <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[1000px] h-[300px] bg-brand-500/5 blur-[120px] rounded-[100%] pointer-events-none -z-10"></div>
      
      {/* ── Main Panel ───────────────────────────────────────── */}
      <div className="w-full max-w-[840px] flex flex-col mt-8 shadow-2xl rounded-2xl bg-[#0A0A0A]/90 backdrop-blur-2xl overflow-hidden border border-white/10">
        
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 sm:px-6 py-4 gap-4 sm:gap-0 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-3 w-full sm:w-auto overflow-hidden">
            <GitBranch className="h-4 w-4 text-brand-500 shrink-0" />
            <span className="text-[14px] font-medium text-white truncate">{repoName}</span>
            <span className="text-[12px] text-gray-500 font-mono hidden sm:inline-block bg-white/5 px-2 py-0.5 rounded-md border border-white/5 shrink-0">
              {repoId}
            </span>
          </div>

          {/* ── Mode Toggle ──────────────────────────────────── */}
          <div className="flex items-center gap-1 bg-black/50 border border-white/10 p-1 rounded-lg shadow-inner w-full sm:w-auto overflow-x-auto hide-scrollbar">
            {(["hybrid", "vector", "keyword"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-all capitalize ${
                  mode === m
                    ? "bg-white/10 text-white shadow-[0_1px_2px_rgba(0,0,0,0.5)] border border-white/10"
                    : "text-gray-500 hover:text-gray-300 border border-transparent"
                }`}
              >
                {m === "hybrid" ? "Hybrid" : m === "vector" ? "Semantic" : "Keyword"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Search Bar ───────────────────────────────────────── */}
        <form onSubmit={handleSearch} className="relative flex items-center px-6 border-b border-white/5 bg-transparent" id="search-form">
          <Search className="h-5 w-5 text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask something like 'where is error handling implemented?'"
            className="w-full bg-transparent border-none py-5 pl-4 pr-12 text-[15px] text-white placeholder:text-gray-600 focus:outline-none focus:ring-0"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="absolute right-6 flex items-center gap-2">
            {!query && !isSearching && (
              <kbd className="hidden sm:flex items-center gap-1 rounded bg-white/5 border border-white/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-500 shadow-sm">
                <Command className="h-3 w-3" /> K
              </kbd>
            )}
            {query && !isSearching && (
              <button type="submit" className="flex items-center justify-center rounded-md bg-white p-1.5 text-black hover:bg-brand-50 transition-colors shadow-sm">
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
            )}
            {isSearching && (
              <Loader2 className="h-4 w-4 animate-spin text-brand-500" />
            )}
          </div>
        </form>

        {/* ── Error ────────────────────────────────────────────── */}
        {error && (
          <div className="flex items-center gap-3 px-6 py-4 bg-red-500/5 border-b border-red-500/10 text-[14px] text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p className="font-medium">{error}</p>
          </div>
        )}

        {/* ── Body ─────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-y-auto max-h-[75vh] bg-transparent custom-scrollbar">
          
          {/* Empty State */}
          {!isSearching && results.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-32 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 border border-white/10 mb-5 shadow-inner">
                <Terminal className="h-6 w-6 text-gray-500" />
              </div>
              <p className="text-gray-400 text-[14px] max-w-sm leading-relaxed">
                Type a query to search the codebase. Use natural language or keywords to instantly retrieve precise snippets.
              </p>
            </div>
          )}

          {/* Results Area */}
          {results.length > 0 && (
            <div className="flex flex-col">
              
              {/* Results Toolbar */}
              <div className="sticky top-0 z-10 flex flex-col sm:flex-row sm:items-center justify-between px-4 sm:px-6 py-3 gap-3 sm:gap-0 border-b border-white/5 bg-[#0A0A0A]/95 backdrop-blur-xl">
                <p className="text-[12px] text-gray-500 font-medium">
                  {results.length} result{results.length !== 1 && "s"}
                  {latencyMs !== null && (
                    <span className="text-gray-600 ml-2 border-l border-gray-700 pl-2">
                      {latencyMs}ms
                    </span>
                  )}
                </p>
                <button
                  onClick={() => setShowAI(!showAI)}
                  className={`group flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all border w-full sm:w-auto ${
                    showAI 
                      ? "bg-brand-500/10 text-brand-400 border-brand-500/20" 
                      : "bg-white/5 text-white border-white/10 hover:bg-white/10"
                  }`}
                >
                  {showAI ? (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      Hide Analysis
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5 text-brand-500 group-hover:text-brand-400 transition-colors" />
                      Synthesize Answer
                    </>
                  )}
                </button>
              </div>

              {/* AI Answer Section */}
              {showAI && (
                <div className="border-b border-white/5 bg-brand-500/[0.02]">
                  <StreamingAnswer repoId={repoId} query={query} />
                </div>
              )}

              {/* Code Snippets List */}
              <div className="p-6">
                <SearchResults results={results} repoUrl={repoUrl} />
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page with Suspense boundary for useSearchParams ──────────

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className="h-5 w-5 animate-spin text-brand-500" />
        </div>
      }
    >
      <SearchPageInner />
    </Suspense>
  );
}
