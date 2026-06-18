/**
 * @codesearch/ingestion — src/file-walker.test.ts
 * ───────────────────────────────────────────────────────────────
 * Integration tests for the FileWalker module.
 *
 * Tests against the real Express.js repository on GitHub to validate:
 *   - Correct file discovery and filtering
 *   - Language detection
 *   - Binary/large file exclusion
 *   - node_modules / ignored directory exclusion
 *   - URL parsing edge cases
 *
 * Run this to verify:
 *   bun test packages/ingestion/src/file-walker.test.ts
 *
 * Dependencies: bun:test, @codesearch/shared, ./file-walker
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { walkRepo, parseGitHubUrl } from "./file-walker.ts";
import type { RawFile, Language } from "@codesearch/shared";

// ── URL Parsing Tests ─────────────────────────────────────────

describe("parseGitHubUrl", () => {
  test("parses standard GitHub URL", () => {
    const result = parseGitHubUrl("https://github.com/expressjs/express");
    expect(result).toEqual({ owner: "expressjs", repo: "express" });
  });

  test("parses URL with .git suffix", () => {
    const result = parseGitHubUrl("https://github.com/expressjs/express.git");
    expect(result).toEqual({ owner: "expressjs", repo: "express" });
  });

  test("parses URL with trailing slash", () => {
    const result = parseGitHubUrl("https://github.com/expressjs/express/");
    expect(result).toEqual({ owner: "expressjs", repo: "express" });
  });

  test("parses URL with branch path", () => {
    const result = parseGitHubUrl("https://github.com/expressjs/express/tree/master");
    expect(result).toEqual({ owner: "expressjs", repo: "express" });
  });

  test("parses bare domain without protocol", () => {
    const result = parseGitHubUrl("github.com/expressjs/express");
    expect(result).toEqual({ owner: "expressjs", repo: "express" });
  });

  test("throws on malformed URL", () => {
    expect(() => parseGitHubUrl("not-a-url")).toThrow("Invalid GitHub URL");
  });

  test("throws on non-GitHub URL", () => {
    expect(() => parseGitHubUrl("https://gitlab.com/owner/repo")).toThrow("Not a GitHub URL");
  });

  test("throws on URL without owner/repo", () => {
    expect(() => parseGitHubUrl("https://github.com/")).toThrow("Cannot parse owner/repo");
  });

  test("throws on URL with only owner", () => {
    expect(() => parseGitHubUrl("https://github.com/expressjs")).toThrow("Cannot parse owner/repo");
  });
});

// ── Integration Test: Express.js ──────────────────────────────

describe("walkRepo — Express.js", () => {
  let result: Awaited<ReturnType<typeof walkRepo>>;

  const VALID_LANGUAGES: Language[] = [
    "typescript",
    "javascript",
    "python",
    "go",
    "markdown",
    "json",
    "other",
  ];

  // Download once, share across tests (this is a real network call)
  beforeAll(async () => {
    result = await walkRepo(
      "https://github.com/expressjs/express",
      `test-express-${Date.now()}`
    );
  }, 60_000); // 60s timeout for download + extraction

  test("returns more than 50 files", () => {
    expect(result.files.length).toBeGreaterThan(50);
  });

  test("repoName is expressjs/express", () => {
    expect(result.repoName).toBe("expressjs/express");
  });

  test("totalSizeBytes is a positive number", () => {
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });

  test("totalSizeBytes equals the sum of individual file sizes", () => {
    const computed = result.files.reduce((sum, f) => sum + f.sizeBytes, 0);
    expect(result.totalSizeBytes).toBe(computed);
  });

  test("every file has a valid language", () => {
    for (const file of result.files) {
      expect(VALID_LANGUAGES).toContain(file.language);
    }
  });

  test("no node_modules files slip through", () => {
    const leaked = result.files.filter(
      (f) => f.filePath.includes("node_modules")
    );
    expect(leaked).toHaveLength(0);
  });

  test("no .git files slip through", () => {
    const leaked = result.files.filter(
      (f) => f.filePath.startsWith(".git/") || f.filePath.includes("/.git/")
    );
    expect(leaked).toHaveLength(0);
  });

  test("no dist/build/coverage files slip through", () => {
    const leaked = result.files.filter(
      (f) =>
        f.filePath.startsWith("dist/") ||
        f.filePath.startsWith("build/") ||
        f.filePath.startsWith("coverage/") ||
        f.filePath.includes("/dist/") ||
        f.filePath.includes("/build/") ||
        f.filePath.includes("/coverage/")
    );
    expect(leaked).toHaveLength(0);
  });

  test("no .min.js or .map files slip through", () => {
    const leaked = result.files.filter(
      (f) => f.filePath.endsWith(".min.js") || f.filePath.endsWith(".map")
    );
    expect(leaked).toHaveLength(0);
  });

  test("no lock files slip through", () => {
    const leaked = result.files.filter(
      (f) =>
        f.filePath.endsWith("package-lock.json") ||
        f.filePath.endsWith("yarn.lock") ||
        f.filePath.endsWith("bun.lockb")
    );
    expect(leaked).toHaveLength(0);
  });

  test("no file exceeds 100 KB", () => {
    const oversized = result.files.filter((f) => f.sizeBytes > 100 * 1024);
    expect(oversized).toHaveLength(0);
  });

  test("every file has non-empty content", () => {
    for (const file of result.files) {
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  test("every file has lineCount >= 1", () => {
    for (const file of result.files) {
      expect(file.lineCount).toBeGreaterThanOrEqual(1);
    }
  });

  test("every file has sizeBytes > 0", () => {
    for (const file of result.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
    }
  });

  test("every filePath is relative (no leading /)", () => {
    for (const file of result.files) {
      expect(file.filePath.startsWith("/")).toBe(false);
    }
  });

  test("includes JavaScript files (Express is JS)", () => {
    const jsFiles = result.files.filter((f) => f.language === "javascript");
    expect(jsFiles.length).toBeGreaterThan(10);
  });

  test("includes markdown files (README, etc.)", () => {
    const mdFiles = result.files.filter((f) => f.language === "markdown");
    expect(mdFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("includes a package.json", () => {
    const pkgJson = result.files.find((f) => f.filePath === "package.json");
    expect(pkgJson).toBeDefined();
    expect(pkgJson!.language).toBe("json");
  });

  test("no binary files slip through (no null bytes in content)", () => {
    for (const file of result.files) {
      const hasNull = file.content.includes("\0");
      expect(hasNull).toBe(false);
    }
  });
});

// ── Error Handling Tests ──────────────────────────────────────

describe("walkRepo — error cases", () => {
  test("throws descriptive error for non-existent repo", async () => {
    await expect(
      walkRepo(
        "https://github.com/this-owner-does-not-exist-xyz/no-such-repo-abc",
        `test-404-${Date.now()}`
      )
    ).rejects.toThrow(/not found on GitHub/i);
  }, 30_000);

  test("throws on malformed URL", async () => {
    await expect(
      walkRepo("not-a-valid-url", `test-bad-url-${Date.now()}`)
    ).rejects.toThrow(/Invalid GitHub URL/);
  });

  test("cleans up temp directory even on failure", async () => {
    const repoId = `test-cleanup-${Date.now()}`;
    const tmpDir = `/tmp/codesearch/${repoId}`;

    try {
      await walkRepo(
        "https://github.com/this-owner-does-not-exist-xyz/no-such-repo-abc",
        repoId
      );
    } catch {
      // Expected to throw
    }

    // The temp directory should be cleaned up
    const exists = await Bun.file(tmpDir).exists().catch(() => false);
    expect(exists).toBe(false);
  }, 30_000);
});
