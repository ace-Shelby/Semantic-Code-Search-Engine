import type { Metadata } from "next";
import localFont from "next/font/local";
import { Code2 } from "lucide-react";
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
            <div className="flex items-center gap-4 text-sm">
              <Link
                href="/"
                className="text-gray-400 hover:text-white transition-colors"
              >
                Home
              </Link>
            </div>
          </div>
        </nav>

        {/* ── Page Content ────────────────────────────────────── */}
        <main className="mx-auto max-w-6xl px-4">{children}</main>
      </body>
    </html>
  );
}
