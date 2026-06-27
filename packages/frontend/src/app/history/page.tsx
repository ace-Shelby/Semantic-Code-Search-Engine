"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, AlertTriangle, Terminal } from "lucide-react";

interface RepoSummary {
  repoId: string;
  repoUrl: string;
  status: "pending" | "running" | "complete" | "failed";
  totalChunks: number;
  createdAt: string;
}

const BACKEND_URL = "/api/proxy";

export default function HistoryPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRepos = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/repos`);
      if (res.ok) {
        const data = await res.json();
        setRepos(data.repos ?? []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  const repoName = (url: string) => {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      return parts.slice(0, 2).join("/");
    } catch {
      return url;
    }
  };

  return (
    <div className="flex flex-col w-full text-[#EAEAEA] font-sans pt-12 pb-24 max-w-5xl mx-auto px-4 sm:px-6">
      
      {/* ── Background Grid ──────────────────────────────────────── */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden opacity-50">
        <div className="absolute inset-0 bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      </div>

      <div className="relative z-10 w-full mt-8">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-white tracking-tight mb-1">
              Indexed Repositories
            </h1>
            <p className="text-sm text-gray-500">
              History of all repositories submitted for semantic indexing.
            </p>
          </div>
          {!loading && (
            <span className="text-[12px] font-medium text-gray-500 bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
              {repos.length} Total
            </span>
          )}
        </div>
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-brand-500 mb-4" />
            <p className="text-gray-500 text-sm">Loading repository history...</p>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 border border-white/10 mb-5 shadow-inner">
              <Terminal className="h-6 w-6 text-gray-500" />
            </div>
            <p className="text-gray-400 text-sm max-w-xs mb-4 leading-relaxed">
              You haven&apos;t indexed any repositories yet.
            </p>
            <button
              onClick={() => router.push("/")}
              className="text-[13px] font-medium text-brand-400 hover:text-brand-300 transition-colors bg-brand-500/10 hover:bg-brand-500/20 px-4 py-2 rounded-lg"
            >
              Go to Dashboard
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {repos.map((repo) => (
              <div
                key={repo.repoId}
                className="group relative flex flex-col rounded-xl border border-white/10 bg-[#0A0A0A]/80 backdrop-blur-md p-5 hover:bg-[#111] hover:border-white/20 transition-all duration-300 cursor-default shadow-lg"
              >
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[15px] font-medium text-white truncate group-hover:text-brand-50 transition-colors">
                      {repoName(repo.repoUrl)}
                    </h3>
                    <p className="text-[12px] text-gray-500 mt-1 font-mono truncate">
                      {repo.repoId}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-auto pt-4 border-t border-white/5">
                  <span className="text-[12px] font-medium text-gray-500">
                    {repo.totalChunks.toLocaleString()} chunks
                  </span>
                  {repo.status === "complete" ? (
                    <button
                      onClick={() => router.push(`/search?repoId=${repo.repoId}`)}
                      className="flex items-center gap-1.5 rounded-md bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/10 transition-colors border border-white/5"
                    >
                      <Search className="h-3 w-3 text-gray-400" />
                      Explore
                    </button>
                  ) : repo.status === "failed" ? (
                     <span className="flex items-center gap-1.5 text-[12px] text-red-400">
                      <AlertTriangle className="h-3 w-3" /> Failed
                     </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[12px] text-brand-400">
                      <Loader2 className="h-3 w-3 animate-spin" /> Indexing
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
