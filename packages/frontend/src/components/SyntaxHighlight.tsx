import { getHighlighter } from "shiki";

// ── Types ─────────────────────────────────────────────────────

interface SyntaxHighlightProps {
  code: string;
  language: string;
  startLine?: number;
}

// ── Language map for Shiki ─────────────────────────────────────

const SHIKI_LANG_MAP: Record<string, string> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "jsx",
  python: "python",
  go: "go",
  rust: "rust",
  markdown: "markdown",
  json: "json",
  other: "text",
};

// ── Lazy singleton highlighter ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let highlighterPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initHighlighter(): Promise<any> {
  if (!highlighterPromise) {
    highlighterPromise = getHighlighter({
      themes: ["github-dark-dimmed"],
      langs: [
        "typescript",
        "tsx",
        "javascript",
        "jsx",
        "python",
        "go",
        "rust",
        "markdown",
        "json",
      ],
    });
  }
  return highlighterPromise;
}

// ── Component ─────────────────────────────────────────────────

export async function SyntaxHighlight({
  code,
  language,
  startLine = 1,
}: SyntaxHighlightProps) {
  let html: string | null = null;

  try {
    const highlighter = await initHighlighter();
    const lang = SHIKI_LANG_MAP[language] ?? "text";

    html = highlighter.codeToHtml(code, {
      lang,
      theme: "github-dark-dimmed",
    });
  } catch {
    // Shiki failed — fall back to plain code
    html = null;
  }

  // ── Line numbers ────────────────────────────────────────────
  const lineCount = code.split("\n").length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => startLine + i);

  if (html) {
    return (
      <div className="relative flex text-xs overflow-x-auto bg-[#0d1117]">
        {/* Line numbers */}
        <div className="flex flex-col items-end py-4 pl-3 pr-2 select-none shrink-0 border-r border-surface-border/30">
          {lineNumbers.map((n) => (
            <span
              key={n}
              className="leading-relaxed text-[11px] text-gray-600 font-mono"
            >
              {n}
            </span>
          ))}
        </div>
        {/* Highlighted code */}
        <div
          className="flex-1 overflow-x-auto [&_.shiki]:!bg-transparent [&_pre]:!bg-transparent [&_code]:!text-xs [&_code]:!leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  // ── Fallback: plain text ────────────────────────────────────
  return (
    <div className="relative flex text-xs overflow-x-auto bg-[#0d1117]">
      <div className="flex flex-col items-end py-4 pl-3 pr-2 select-none shrink-0 border-r border-surface-border/30">
        {lineNumbers.map((n) => (
          <span
            key={n}
            className="leading-relaxed text-[11px] text-gray-600 font-mono"
          >
            {n}
          </span>
        ))}
      </div>
      <pre className="flex-1 p-4 overflow-x-auto">
        <code className="text-gray-300 leading-relaxed font-mono">{code}</code>
      </pre>
    </div>
  );
}
