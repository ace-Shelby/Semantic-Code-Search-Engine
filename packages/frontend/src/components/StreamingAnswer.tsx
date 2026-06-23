"use client";

import { useEffect, useRef } from "react";
import { useAskStream } from "@frontend/hooks/useAskStream";
import { AlertTriangle, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Skeleton Loader ───────────────────────────────────────────

function AnswerSkeleton() {
  return (
    <div className="px-6 py-6 relative overflow-hidden">
      {/* Subtle linear scanning gradient */}
      <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-brand-500/50 to-transparent animate-[shimmer_1.5s_infinite]" />
      
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex h-6 w-6 items-center justify-center rounded-full bg-brand-500/10 border border-brand-500/20">
          <div className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse shadow-[0_0_8px_rgba(45,212,191,0.8)]"></div>
        </div>
        <span className="text-[13px] font-medium text-brand-400 tracking-wide uppercase">
          Synthesizing Context...
        </span>
      </div>

      <div className="space-y-4 pl-2">
        {/* Crisp linear skeleton lines */}
        <div className="h-2.5 bg-white/5 rounded-full w-3/4 animate-pulse"></div>
        <div className="h-2.5 bg-white/5 rounded-full w-full animate-pulse delay-75"></div>
        <div className="h-2.5 bg-white/5 rounded-full w-5/6 animate-pulse delay-150"></div>
        <div className="h-2.5 bg-white/5 rounded-full w-2/3 animate-pulse delay-200"></div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────

export function StreamingAnswer({ repoId, query }: { repoId: string; query: string }) {
  const { ask, answer, citations, isStreaming, error, reset } = useAskStream();
  const answerEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim() && repoId) {
      ask(query, repoId);
    }
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, repoId]);

  useEffect(() => {
    if (isStreaming && answerEndRef.current) {
      answerEndRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [answer, isStreaming]);

  return (
    <div className="flex flex-col bg-transparent font-sans selection:bg-brand-500/30 selection:text-white">
      
      {/* ── Error ────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-start gap-3 px-6 py-4 text-[14px] text-red-400 border-b border-white/5 bg-red-500/5 backdrop-blur-md">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="leading-relaxed font-medium">{error}</p>
        </div>
      )}

      {/* ── Answer Body ──────────────────────────────────────── */}
      <div className="relative">
        {isStreaming && !answer && !error ? (
          <AnswerSkeleton />
        ) : answer ? (
          <div className="px-6 py-6 max-h-[600px] overflow-y-auto custom-scrollbar">
            <div className="flex items-center gap-2 mb-5">
              <Sparkles className="h-4 w-4 text-brand-500" />
              <span className="text-[12px] font-semibold tracking-wider uppercase text-gray-400">Analysis</span>
            </div>
            <div className="text-[15px] text-gray-200 leading-relaxed font-sans bg-transparent p-0 m-0 border-none prose-invert max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({_node, ...props}) => <h1 className="text-xl font-bold text-white mb-4 mt-6" {...props} />,
                  h2: ({_node, ...props}) => <h2 className="text-lg font-semibold text-white mb-3 mt-5" {...props} />,
                  h3: ({_node, ...props}) => <h3 className="text-base font-medium text-white mb-3 mt-4" {...props} />,
                  p: ({_node, ...props}) => <p className="mb-4" {...props} />,
                  ul: ({_node, ...props}) => <ul className="list-disc pl-5 mb-4 space-y-1" {...props} />,
                  ol: ({_node, ...props}) => <ol className="list-decimal pl-5 mb-4 space-y-1" {...props} />,
                  li: ({_node, ...props}) => <li className="pl-1" {...props} />,
                  a: ({_node, ...props}) => <a className="text-brand-400 hover:underline" {...props} />,
                  strong: ({_node, ...props}) => <strong className="font-semibold text-white" {...props} />,
                  pre: ({_node, ...props}) => <pre className="bg-[#0A0A0A] border border-white/10 p-4 rounded-xl overflow-x-auto text-[13px] text-gray-300 mb-4 font-mono shadow-inner" {...props} />,
                  code: ({_node, className, ...props}) => {
                    const match = /language-(\w+)/.exec(className || '');
                    return match ? (
                      <code className={className} {...props} />
                    ) : (
                      <code className="bg-white/10 text-brand-300 px-1.5 py-0.5 rounded-md text-[13px] font-mono" {...props} />
                    );
                  }
                }}
              >
                {answer + (isStreaming ? " ▍" : "")}
              </ReactMarkdown>
            </div>
            <div ref={answerEndRef} className="h-2" />
          </div>
        ) : null}
      </div>

      {/* ── Citations ────────────────────────────────────────── */}
      {citations.length > 0 && !isStreaming && (
        <div className="border-t border-white/5 bg-black/20 px-6 py-5">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[11px] font-bold text-gray-500 tracking-wider uppercase">
              References
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {citations.map((citation, i) => (
              <a
                href={`#`}
                key={`${citation.filePath}:${citation.startLine}`}
                className="group flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] hover:bg-white/[0.08] hover:border-white/20 transition-all cursor-pointer shadow-sm"
              >
                <span className="flex items-center justify-center h-4 w-4 rounded-full bg-black/50 border border-white/10 text-[9px] font-bold text-brand-400 group-hover:bg-brand-500/20 group-hover:border-brand-500/30 transition-colors">
                  {i + 1}
                </span>
                <span className="text-gray-300 font-mono truncate max-w-[200px] group-hover:text-white transition-colors">
                  {citation.filePath.split('/').pop()}
                </span>
                <span className="text-gray-500 font-mono text-[11px] group-hover:text-gray-400 transition-colors">
                  :{citation.startLine}
                </span>
                <ChevronRight className="h-3 w-3 text-gray-600 opacity-0 -ml-1.5 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
