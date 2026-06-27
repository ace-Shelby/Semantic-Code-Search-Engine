"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle, ArrowRight, Terminal, Info } from "lucide-react";

interface IngestResponse {
  jobId: string;
  repoId: string;
  status: string;
}

interface IngestionJob {
  id: string;
  repoId: string;
  repoUrl: string;
  status: "pending" | "running" | "complete" | "failed";
  progress: number;
  totalChunks: number;
  processedChunks: number;
  error?: string;
}

const BACKEND_URL = "/api/proxy";

// ── Page Component ────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  
  const [githubUrl, setGithubUrl] = useState("");
  const [isIngesting, setIsIngesting] = useState(false);
  const [activeJob, setActiveJob] = useState<IngestionJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Poll ingestion status ───────────────────────────────────
  useEffect(() => {
    if (!activeJob || activeJob.status === "complete" || activeJob.status === "failed") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/repos/${activeJob.repoId}/status`);
        if (!res.ok) return;
        const job: IngestionJob = await res.json();
        setActiveJob(job);

        if (job.status === "complete") {
          setIsIngesting(false);
          setTimeout(() => {
            router.push(`/search?repoId=${job.repoId}`);
          }, 500);
        }

        if (job.status === "failed") {
          setIsIngesting(false);
          setError(job.error ?? "Ingestion failed");
        }
      } catch {
        // Retry next interval
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeJob, router]);

  // ── Submit handler ──────────────────────────────────────────
  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim() || isIngesting) return;

    setError(null);
    setIsIngesting(true);
    setActiveJob(null);

    try {
      const res = await fetch(`${BACKEND_URL}/repos/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: githubUrl.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as { message?: string })?.message ?? `Server error (${res.status})`
        );
      }

      const data: IngestResponse = await res.json();
      setActiveJob({
        id: data.jobId,
        repoId: data.repoId,
        repoUrl: githubUrl.trim(),
        status: data.status as IngestionJob["status"],
        progress: 0,
        totalChunks: 0,
        processedChunks: 0,
      });
    } catch (err) {
      setIsIngesting(false);
      setError(err instanceof Error ? err.message : "Failed to start ingestion");
    }
  };

  const repoName = (url: string) => {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      return parts.slice(0, 2).join("/");
    } catch {
      return url;
    }
  };

  return (
    <div className="relative flex flex-col items-center w-full text-[#EAEAEA] font-sans selection:bg-brand-500/30 selection:text-white pt-20 pb-24">
      
      {/* ── Linear-Style Dot Grid & Glow ──────────────────────── */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        {/* Subtle radial gradient for center focus */}
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-brand-500/10 blur-[120px] rounded-[100%]"></div>
        {/* Dot grid */}
        <div className="absolute inset-0 bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:24px_24px] opacity-30 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      </div>

      <div className="relative z-10 flex flex-col w-full max-w-5xl px-4 sm:px-6">
        
        {/* ── Hero Section ──────────────────────────────────────── */}
        <div className="flex flex-col items-center text-center mb-16 mt-8 animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 mb-8 shadow-[0_2px_10px_rgba(0,0,0,0.2)] backdrop-blur-md">
            <span className="flex h-2 w-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(45,212,191,0.8)]"></span>
            <span className="text-[12px] font-medium text-gray-300 tracking-wide uppercase">Semantic Code Search Engine</span>
          </div>
          
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-semibold tracking-[-0.04em] text-white mb-4 sm:mb-6 leading-[1.1] sm:leading-[1.1]">
            Search your codebase.<br className="hidden sm:block" />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-100 via-brand-400 to-brand-600">
              Instantly.
            </span>
          </h1>
          
          <p className="text-[#888] text-base sm:text-lg md:text-xl max-w-[600px] font-light leading-relaxed mb-8 sm:mb-10 px-2 sm:px-0">
            Index massive repositories in seconds. Use natural language to explore code, understand context, and find exactly what you need with pinpoint accuracy.
          </p>

          {/* ── Premium Ingest Bar ────────────────────────────── */}
          <div className="w-full max-w-[680px] relative group">
            {/* Hover Glow Effect */}
            <div className="absolute -inset-[1px] bg-gradient-to-r from-brand-500/0 via-brand-500/50 to-brand-500/0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-sm "></div>
            
            <form 
              onSubmit={handleIngest} 
              className="relative flex flex-col sm:flex-row items-center p-1.5 bg-[#0A0A0A]/80 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-all"
            >
              <div className="relative flex-1 flex items-center w-full">
                <Terminal className="absolute left-4 h-5 w-5 text-gray-500" />
                <input
                  type="text"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  disabled={isIngesting}
                  className="w-full bg-transparent border-none py-3.5 pl-12 pr-4 text-[15px] text-[#EAEAEA] placeholder:text-[#555] focus:outline-none focus:ring-0 disabled:opacity-50"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                disabled={isIngesting || !githubUrl.trim()}
                className="w-full sm:w-auto mt-2 sm:mt-0 flex items-center justify-center gap-2 rounded-xl bg-white text-black px-6 py-3 text-[14px] font-semibold hover:bg-brand-50 disabled:bg-white/10 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors shadow-[0_2px_10px_rgba(255,255,255,0.1)] shrink-0"
              >
                {isIngesting ? (
                  <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                {isIngesting ? "Indexing..." : "Index Codebase"}
              </button>
            </form>
          </div>

          {/* ── Free Resources Notice ─────────────────────────── */}
          <div className="mt-6 flex items-start gap-2 text-left text-[13px] text-gray-400 max-w-[680px] w-full px-2">
            <Info className="h-4 w-4 shrink-0 text-brand-400 mt-0.5" />
            <p>
              Please try indexing smaller repositories. We are currently running entirely on free-tier infrastructure, so large codebases might time out!
            </p>
          </div>

          {/* ── Error Banner ────────────────────────────────────── */}
          {error && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-5 py-4 text-sm text-red-200 backdrop-blur-md max-w-[680px] w-full text-left animate-slide-up">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
              <p className="font-medium">{error}</p>
            </div>
          )}

          {/* ── Active Job Progress ────────────────────────────── */}
          {activeJob && (
            <div className="mt-6 rounded-xl border border-white/10 bg-[#0A0A0A]/80 backdrop-blur-xl p-5 max-w-[680px] w-full text-left animate-slide-up shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-brand-500/50 to-transparent"></div>
              <div className="flex items-center justify-between text-[14px] mb-3">
                <span className="text-white font-medium truncate max-w-[70%]">
                  {repoName(activeJob.repoUrl)}
                </span>
                <span className="text-gray-400 font-mono text-[12px]">
                  {Math.round(activeJob.progress * 100)}%
                </span>
              </div>
              <div className="relative h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-full bg-brand-500 transition-all duration-500 shadow-[0_0_10px_rgba(20,184,166,0.8)]"
                  style={{
                    width: `${Math.max(
                      activeJob.status === "complete" ? 100 : activeJob.progress * 100,
                      activeJob.status === "running" ? 5 : 0
                    )}%`,
                  }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-[12px] text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${activeJob.status === 'failed' ? 'bg-red-500' : 'bg-brand-500 animate-pulse'}`}></span>
                  <span className="capitalize">{activeJob.status}</span>
                </span>
                <span>{activeJob.processedChunks} / {activeJob.totalChunks || "..."} chunks</span>
              </div>
            </div>
          )}
        </div>


      </div>
    </div>
  );
}
