/**
 * @codesearch/ingestion — src/file-walker.ts
 * ───────────────────────────────────────────────────────────────
 * Downloads a GitHub repository as a tarball, extracts it in-memory
 * using Bun.Archive, walks all files, and returns a flat list of
 * RawFile objects for downstream AST chunking.
 *
 * Uses Bun-native APIs throughout: fetch, Bun.Archive, Bun.file.
 * Zero external dependencies.
 *
 * Dependencies: @codesearch/shared (types only)
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RawFile, Language } from "@codesearch/shared";

// ── Constants ─────────────────────────────────────────────────

/** Maximum zip/tarball size we'll accept (50 MB). */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** Maximum individual file size we'll process (100 KB). */
const MAX_FILE_BYTES = 100 * 1024;

/** Number of leading bytes to scan for null bytes (binary detection). */
const BINARY_CHECK_BYTES = 512;

/** Directories to skip entirely during the walk. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".next",
  ".turbo",
  "vendor",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".cache",
  ".idea",
  ".vscode",
]);

/** File basenames to always skip. */
const IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  ".DS_Store",
  "Thumbs.db",
]);

/** Glob-style suffix patterns to skip. */
const IGNORED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".map",
  ".lock",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".mp4",
  ".mp3",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".br",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
];

/** Map file extensions to Language identifiers. */
const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".pyi": "python",
  ".go": "go",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
};

// ── Public API ────────────────────────────────────────────────

/** Result envelope returned by walkRepo. */
export interface WalkRepoResult {
  /** Flat list of all discovered source files. */
  files: RawFile[];
  /** Repository name in "owner/repo" format. */
  repoName: string;
  /** Sum of all file sizes in bytes. */
  totalSizeBytes: number;
}

/** Structured info parsed from a GitHub URL. */
interface GitHubRepoInfo {
  owner: string;
  repo: string;
}

/**
 * Download a GitHub repository, extract it, and return every readable
 * source file as a flat list of {@link RawFile} objects.
 *
 * @param githubUrl  — Full GitHub URL, e.g. "https://github.com/expressjs/express"
 * @param repoId    — Unique identifier for this ingestion run (used for temp dir naming)
 * @returns A {@link WalkRepoResult} containing all discovered files
 *
 * @throws {Error} If the URL is malformed, the repo returns 404, or the archive exceeds 50 MB
 *
 * @example
 * ```ts
 * const { files, repoName, totalSizeBytes } = await walkRepo(
 *   "https://github.com/expressjs/express",
 *   "expressjs-express-abc123"
 * );
 * console.log(`Found ${files.length} files (${totalSizeBytes} bytes)`);
 * ```
 */
export async function walkRepo(githubUrl: string, repoId: string): Promise<WalkRepoResult> {
  const { owner, repo } = parseGitHubUrl(githubUrl);
  const repoName = `${owner}/${repo}`;
  const extractDir = join("/tmp", "codesearch", repoId);

  console.log(`📦 Walking repo: ${repoName}`);

  try {
    // Step 1: Download the tarball
    const tarballBytes = await downloadTarball(owner, repo);
    console.log(`   Downloaded tarball: ${(tarballBytes.byteLength / 1024).toFixed(1)} KB`);

    // Step 2: Extract to temp directory
    await mkdir(extractDir, { recursive: true });
    const archive = new Bun.Archive(new Uint8Array(tarballBytes));
    const extractedCount = await archive.extract(extractDir);
    console.log(`   Extracted ${extractedCount} entries to ${extractDir}`);

    // Step 3: Find the actual root directory (GitHub tarballs nest under owner-repo-sha/)
    const repoRoot = await findRepoRoot(extractDir);
    console.log(`   Repo root: ${repoRoot}`);

    // Step 4: Walk the extracted files
    const { files, skippedCount } = await walkDirectory(repoRoot);

    const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

    console.log(
      `✅ Found ${files.length} files, skipped ${skippedCount} ` +
      `(${(totalSizeBytes / 1024).toFixed(1)} KB total)`
    );

    return { files, repoName, totalSizeBytes };
  } finally {
    // Always clean up the temp directory
    await rm(extractDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`⚠️  Failed to clean up ${extractDir}:`, err.message);
    });
  }
}

// ── URL Parsing ───────────────────────────────────────────────

/**
 * Parse a GitHub URL into owner and repo name.
 *
 * Supports formats:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/tree/branch
 *   - github.com/owner/repo
 *
 * @throws {Error} If the URL doesn't match expected GitHub patterns
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo {
  // Normalize: add protocol if missing
  let normalized = url.trim();
  if (normalized.startsWith("github.com")) {
    normalized = `https://${normalized}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      `Invalid GitHub URL: "${url}". ` +
      `Expected format: https://github.com/owner/repo`
    );
  }

  if (parsed.hostname !== "github.com") {
    throw new Error(
      `Not a GitHub URL: "${url}". Hostname must be github.com, got "${parsed.hostname}"`
    );
  }

  // pathname is "/owner/repo" or "/owner/repo/tree/branch" etc.
  const segments = parsed.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error(
      `Cannot parse owner/repo from "${url}". ` +
      `Expected format: https://github.com/owner/repo`
    );
  }

  return { owner: segments[0], repo: segments[1] };
}

// ── Tarball Download ──────────────────────────────────────────

/**
 * Download the repository tarball from GitHub, trying "main" first, then "master".
 *
 * @throws {Error} If both branches return 404, or the archive exceeds MAX_ARCHIVE_BYTES
 */
async function downloadTarball(owner: string, repo: string): Promise<ArrayBuffer> {
  const branches = ["main", "master"];
  let lastError: Error | null = null;

  for (const branch of branches) {
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
    console.log(`   Trying: ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: buildGitHubHeaders(),
        redirect: "follow",
      });
    } catch (err) {
      lastError = new Error(
        `Network error downloading ${owner}/${repo} (branch: ${branch}): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    if (response.status === 404) {
      lastError = new Error(`Branch "${branch}" not found for ${owner}/${repo}`);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(
        `GitHub returned HTTP ${response.status} for ${owner}/${repo} (branch: ${branch}): ` +
        `${response.statusText}`
      );
      continue;
    }

    // Check Content-Length before downloading the body
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Repository ${owner}/${repo} is too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB ` +
        `(limit: ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB)`
      );
    }

    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Repository ${owner}/${repo} archive is too large: ` +
        `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (limit: ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB)`
      );
    }

    return buffer;
  }

  throw new Error(
    `Repository "${owner}/${repo}" not found on GitHub. ` +
    `Tried branches: ${branches.join(", ")}. ` +
    `Last error: ${lastError?.message ?? "unknown"}`
  );
}

/**
 * Build request headers for GitHub API calls.
 * Includes a GITHUB_TOKEN if set, which raises rate limits from 60 → 5000 req/hr.
 */
function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "CodeSearch-AI/0.1.0",
    Accept: "application/vnd.github+json",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

// ── Extraction Helpers ────────────────────────────────────────

/**
 * GitHub tarballs extract to a single top-level directory named `{repo}-{sha}/`.
 * This function finds that directory so we can treat it as the repo root.
 */
async function findRepoRoot(extractDir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(extractDir, { withFileTypes: true });

  // Look for a single top-level directory (the GitHub pattern)
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    return join(extractDir, dirs[0].name);
  }

  // If there are multiple dirs or just files, use extractDir as root
  return extractDir;
}

// ── File Walking ──────────────────────────────────────────────

interface WalkResult {
  files: RawFile[];
  skippedCount: number;
}

/**
 * Recursively walk a directory and collect all readable source files.
 * Applies all skip rules: ignored dirs, ignored files, size limits,
 * binary detection, and suffix filtering.
 */
async function walkDirectory(rootDir: string): Promise<WalkResult> {
  const { readdir } = await import("node:fs/promises");
  const files: RawFile[] = [];
  let skippedCount = 0;

  async function recurse(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`   ⚠️  Cannot read directory ${dir}: ${err instanceof Error ? err.message : err}`);
      skippedCount++;
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // ── Skip hidden files/dirs (dotfiles) ────────────────
      if (entry.name.startsWith(".")) {
        skippedCount++;
        continue;
      }

      // ── Recurse into subdirectories ──────────────────────
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          skippedCount++;
          continue;
        }
        await recurse(fullPath);
        continue;
      }

      // ── Process files ────────────────────────────────────
      if (!entry.isFile()) {
        skippedCount++;
        continue;
      }

      // Skip by exact filename
      if (IGNORED_FILES.has(entry.name)) {
        skippedCount++;
        continue;
      }

      // Skip by suffix pattern
      const nameLower = entry.name.toLowerCase();
      if (IGNORED_SUFFIXES.some((suffix) => nameLower.endsWith(suffix))) {
        skippedCount++;
        continue;
      }

      // Read file metadata using Bun.file
      const bunFile = Bun.file(fullPath);
      const sizeBytes = bunFile.size;

      // Skip files over 100 KB
      if (sizeBytes > MAX_FILE_BYTES) {
        skippedCount++;
        continue;
      }

      // Skip empty files
      if (sizeBytes === 0) {
        skippedCount++;
        continue;
      }

      // Read file content
      let content: string;
      try {
        // Read as bytes first for binary detection
        const bytes = await bunFile.bytes();

        // Binary check: look for null bytes in the first 512 bytes
        const checkLength = Math.min(bytes.length, BINARY_CHECK_BYTES);
        let isBinary = false;
        for (let i = 0; i < checkLength; i++) {
          if (bytes[i] === 0) {
            isBinary = true;
            break;
          }
        }

        if (isBinary) {
          skippedCount++;
          continue;
        }

        // Decode as UTF-8
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        // Encoding error — not valid UTF-8, skip it
        skippedCount++;
        continue;
      }

      // Detect language
      const ext = getExtension(entry.name);
      const language = EXTENSION_TO_LANGUAGE[ext] ?? "other";

      // Compute relative path from the repo root
      const filePath = fullPath.slice(rootDir.length + 1); // +1 for the leading /

      const lineCount = countLines(content);

      files.push({
        filePath,
        content,
        language,
        sizeBytes,
        lineCount,
      });
    }
  }

  await recurse(rootDir);
  return { files, skippedCount };
}

// ── Utility Functions ─────────────────────────────────────────

/**
 * Extract the file extension (lowercase, including the dot).
 * Returns empty string for files with no extension.
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return "";
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Count the number of lines in a string.
 * A file with no newlines has 1 line. An empty string has 0 lines.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++; // \n
  }
  return count;
}
