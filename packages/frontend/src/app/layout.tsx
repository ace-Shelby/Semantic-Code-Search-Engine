import type { Metadata } from "next";
import localFont from "next/font/local";
import { Code2, Github } from "lucide-react";
import Link from "next/link";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "CodeSearch AI — Semantic Code Search",
  description:
    "Search any GitHub codebase in plain English. Powered by vector embeddings and RAG.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans min-h-screen`}
      >
        {/* ── Top Navigation ──────────────────────────────────── */}
        <nav className="sticky top-0 z-50 border-b border-surface-border bg-surface/80 backdrop-blur-xl">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-white font-semibold text-lg hover:opacity-90 transition-opacity"
            >
              <Code2 className="h-5 w-5 text-accent" />
              <span>
                CodeSearch<span className="text-accent">AI</span>
              </span>
            </Link>
            <div className="flex items-center gap-6 text-sm">
              <Link
                href="/"
                className="text-gray-400 hover:text-white transition-colors"
              >
                Home
              </Link>
              <Link
                href="/history"
                className="text-gray-400 hover:text-white transition-colors"
              >
                History
              </Link>
              <a
                href="https://github.com/ace-Shelby/Semantic-Code-Search-Engine"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white transition-colors flex items-center gap-1.5 border border-white/10 px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10"
              >
                <Github className="h-4 w-4" />
                <span className="hidden sm:inline-block font-medium">GitHub</span>
              </a>
            </div>
          </div>
        </nav>

        {/* ── Page Content ────────────────────────────────────── */}
        <main className="mx-auto max-w-6xl px-4 flex-1 w-full min-h-[calc(100vh-140px)]">
          {children}
        </main>

        {/* ── Footer ──────────────────────────────────────────── */}
        <footer className="border-t border-white/10 bg-[#0A0A0A]/50 mt-12 py-8">
          <div className="mx-auto max-w-6xl px-4 flex flex-col sm:flex-row items-center justify-between text-xs text-gray-500 gap-4">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4" />
              <span>Semantic Code Search Engine</span>
            </div>
            <p>
              Built with Next.js, Bun, and Qdrant.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
