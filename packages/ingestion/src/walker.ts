/**
 * @codesearch/ingestion — src/walker.ts
 * ───────────────────────────────────────────────────────────────
 * Recursively walks a directory tree and returns all source files
 * that match a supported language, filtering out node_modules,
 * dotfiles, lock files, and other non-code artifacts.
 *
 * Dependencies: node:fs, node:path, @codesearch/shared
 *
 * Run this to verify:
 *   bun run packages/ingestion/src/walker.ts
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { SupportedLanguage } from "@codesearch/shared";

/** A file discovered by the walker. */
export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: SupportedLanguage;
}

/** Map of file extensions to their language identifier. */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
};

/** Directories to skip entirely. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
]);

/** File patterns to skip. */
const IGNORED_FILES = new Set([
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/**
 * Walk `rootDir` recursively and return all source files
 * whose extension maps to a supported language.
 */
export async function walkFiles(rootDir: string): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];

  async function recurse(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await recurse(fullPath);
        }
        continue;
      }

      if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;

        const ext = extname(entry.name).toLowerCase();
        const language = EXTENSION_MAP[ext];

        if (language) {
          const fileStat = await stat(fullPath);
          // Skip files larger than 1 MB (likely generated / bundled)
          if (fileStat.size > 1_000_000) continue;

          results.push({
            absolutePath: fullPath,
            relativePath: relative(rootDir, fullPath),
            language,
          });
        }
      }
    }
  }

  await recurse(rootDir);
  return results;
}
