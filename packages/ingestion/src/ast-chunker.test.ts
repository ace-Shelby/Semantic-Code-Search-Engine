/**
 * @codesearch/ingestion — src/ast-chunker.test.ts
 * ───────────────────────────────────────────────────────────────
 * Unit tests for the AST chunker module.
 *
 * Tests:
 *   1. TypeScript file with 3 functions + 1 class → 4 AST chunks
 *   2. Correct startLine/endLine for each chunk
 *   3. symbolName extraction (functions, classes, arrow functions, exports)
 *   4. Sliding-window fallback for non-AST languages
 *   5. Oversized node splitting
 *   6. Small-chunk filtering (<5 lines removed)
 *   7. Python support
 *   8. Error resilience
 *
 * Run this to verify:
 *   bun test packages/ingestion/src/ast-chunker.test.ts
 *
 * Dependencies: bun:test, @codesearch/shared, ./ast-chunker
 */

import { describe, test, expect } from "bun:test";
import { chunkFiles } from "./ast-chunker.ts";
import type { RawFile, CodeChunk, Language } from "@codesearch/shared";

// ── Helpers ───────────────────────────────────────────────────

/** Build a RawFile from source code for testing. */
function makeFile(
  filePath: string,
  content: string,
  language: Language
): RawFile {
  return {
    filePath,
    content,
    language,
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    lineCount: content.split("\n").length,
  };
}

// ── Test Fixtures ─────────────────────────────────────────────

/**
 * Sample TypeScript file with exactly 3 functions and 1 class.
 * Each symbol is >5 lines so it won't be filtered out.
 * Lines are annotated with their 1-indexed line numbers.
 */
const SAMPLE_TYPESCRIPT = `\
interface Config {
  host: string;
  port: number;
}

function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw);
  return {
    host: parsed.host ?? "localhost",
    port: parsed.port ?? 3000,
  };
}

const formatUrl = (config: Config): string => {
  const protocol = "http";
  const host = config.host;
  const port = config.port;
  return \`\${protocol}://\${host}:\${port}\`;
};

export function startServer(config: Config): void {
  const url = formatUrl(config);
  console.log("Starting server at", url);
  console.log("Config:", config);
  console.log("Ready!");
}

class Server {
  private config: Config;
  private running: boolean;

  constructor(config: Config) {
    this.config = config;
    this.running = false;
  }

  start(): void {
    this.running = true;
    console.log("Server started");
    console.log("Listening on", this.config.port);
  }

  stop(): void {
    this.running = false;
    console.log("Server stopped");
  }
}`;

// ── Core Tests: TypeScript AST Chunking ───────────────────────

describe("chunkFiles — TypeScript AST chunking", () => {
  const REPO_ID = "test/repo";
  const file = makeFile("src/server.ts", SAMPLE_TYPESCRIPT, "typescript");

  let chunks: CodeChunk[];

  test("produces exactly 4 chunks (3 functions + 1 class)", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    // The interface at top (4 lines) is below MIN_CHUNK_LINES and gets filtered out
    // What remains: parseConfig (func), formatUrl (arrow/lexical), startServer (export func), Server (class)
    expect(chunks.length).toBe(4);
  });

  test("all chunks have repoId set", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.repoId).toBe(REPO_ID);
    }
  });

  test("all chunks have filePath set", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/server.ts");
    }
  });

  test("all chunks have language = typescript", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.language).toBe("typescript");
    }
  });

  test("all chunks have unique IDs", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all chunks have tokenCount > 0", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  test("tokenCount ≈ content.length / 4", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.length / 4));
    }
  });

  test("every chunk has startLine <= endLine", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });

  test("every chunk has at least 5 lines", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    for (const chunk of chunks) {
      const lineCount = chunk.endLine - chunk.startLine + 1;
      expect(lineCount).toBeGreaterThanOrEqual(5);
    }
  });

  test("symbolName is correctly extracted for all chunks", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const names = chunks.map((c) => c.symbolName);
    expect(names).toContain("parseConfig");
    expect(names).toContain("formatUrl");
    expect(names).toContain("startServer");
    expect(names).toContain("Server");
  });

  test("parseConfig chunk has correct line range", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const parseConfigChunk = chunks.find((c) => c.symbolName === "parseConfig");
    expect(parseConfigChunk).toBeDefined();
    expect(parseConfigChunk!.startLine).toBe(6);
    expect(parseConfigChunk!.endLine).toBe(12);
  });

  test("formatUrl chunk has correct line range", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const formatUrlChunk = chunks.find((c) => c.symbolName === "formatUrl");
    expect(formatUrlChunk).toBeDefined();
    expect(formatUrlChunk!.startLine).toBe(14);
    expect(formatUrlChunk!.endLine).toBe(19);
  });

  test("startServer (exported) chunk has correct line range", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const startServerChunk = chunks.find((c) => c.symbolName === "startServer");
    expect(startServerChunk).toBeDefined();
    expect(startServerChunk!.startLine).toBe(21);
    expect(startServerChunk!.endLine).toBe(26);
  });

  test("Server class chunk has correct line range", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const serverChunk = chunks.find((c) => c.symbolName === "Server");
    expect(serverChunk).toBeDefined();
    expect(serverChunk!.startLine).toBe(28);
    // The class spans from line 28 to the end of the file
    expect(serverChunk!.endLine).toBeGreaterThanOrEqual(44);
  });

  test("chunk content matches the actual source lines", async () => {
    chunks = await chunkFiles([file], REPO_ID);
    const lines = SAMPLE_TYPESCRIPT.split("\n");

    for (const chunk of chunks) {
      // Extract expected content from the original source by line range
      const expectedLines = lines.slice(chunk.startLine - 1, chunk.endLine);
      // The chunk content should start with the first line and end with the last line
      expect(chunk.content).toContain(expectedLines[0]);
      expect(chunk.content).toContain(expectedLines[expectedLines.length - 1]);
    }
  });
});

// ── Sliding Window Fallback ───────────────────────────────────

describe("chunkFiles — sliding-window fallback", () => {
  const REPO_ID = "test/repo";

  test("uses sliding-window for markdown files", async () => {
    const mdContent = Array.from(
      { length: 60 },
      (_, i) => `Line ${i + 1}: This is some markdown content for testing.`
    ).join("\n");

    const file = makeFile("README.md", mdContent, "markdown");
    const chunks = await chunkFiles([file], REPO_ID);

    expect(chunks.length).toBeGreaterThan(0);
    // All chunks should have symbolName = null (no AST info)
    for (const chunk of chunks) {
      expect(chunk.symbolName).toBeNull();
      expect(chunk.language).toBe("markdown");
    }
  });

  test("uses sliding-window for JSON files", async () => {
    const jsonLines = ["{"];
    for (let i = 0; i < 50; i++) {
      jsonLines.push(`  "key_${i}": "value_${i}",`);
    }
    jsonLines.push(`  "last": "value"`);
    jsonLines.push("}");

    const file = makeFile("config.json", jsonLines.join("\n"), "json");
    const chunks = await chunkFiles([file], REPO_ID);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.symbolName).toBeNull();
    }
  });

  test("uses sliding-window for Go files", async () => {
    const goLines = [
      "package main",
      "",
      "import \"fmt\"",
      "",
      "func main() {",
    ];
    for (let i = 0; i < 40; i++) {
      goLines.push(`    fmt.Println("line ${i}")`);
    }
    goLines.push("}");

    const file = makeFile("main.go", goLines.join("\n"), "go");
    const chunks = await chunkFiles([file], REPO_ID);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.language).toBe("go");
    }
  });

  test("sliding window produces overlapping chunks", async () => {
    // 80 lines → with 40-line window and 8-line overlap (step=32):
    // chunk 1: lines 1–40, chunk 2: lines 33–72, chunk 3: lines 65–80
    // chunk 3 is only 16 lines, still >= MIN_CHUNK_LINES
    const content = Array.from(
      { length: 80 },
      (_, i) => `// Line ${i + 1}: content here`
    ).join("\n");

    const file = makeFile("large.go", content, "go");
    const chunks = await chunkFiles([file], REPO_ID);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Verify overlap exists between adjacent chunks
    if (chunks.length >= 2) {
      const firstEnd = chunks[0].endLine;
      const secondStart = chunks[1].startLine;
      expect(secondStart).toBeLessThan(firstEnd); // overlap
    }
  });
});

// ── Small Chunk Filtering ─────────────────────────────────────

describe("chunkFiles — small chunk filtering", () => {
  const REPO_ID = "test/repo";

  test("filters out chunks smaller than 5 lines", async () => {
    // A file with only a tiny function (3 lines)
    const tinyTs = `\
const x = 1;
const y = 2;
const z = 3;`;

    const file = makeFile("tiny.ts", tinyTs, "typescript");
    const chunks = await chunkFiles([file], REPO_ID);

    // The lexical_declarations are each 1 line — all below MIN_CHUNK_LINES
    // The file has only 3 lines total — even the sliding-window fallback should filter it
    expect(chunks.length).toBe(0);
  });
});

// ── Oversized Node Splitting ──────────────────────────────────

describe("chunkFiles — oversized node splitting", () => {
  const REPO_ID = "test/repo";

  test("splits functions larger than 600 tokens into sub-chunks", async () => {
    // Create a function with ~200 lines (well over 600 tokens)
    const bodyLines = Array.from(
      { length: 200 },
      (_, i) => `  console.log("Processing step ${i}: " + data.toString());`
    );
    const bigFunction = [
      "function processData(data: unknown): void {",
      ...bodyLines,
      "}",
    ].join("\n");

    const file = makeFile("big.ts", bigFunction, "typescript");
    const chunks = await chunkFiles([file], REPO_ID);

    // 202 lines of code, each line ~60 chars → ~12000 chars → ~3000 tokens
    // Should be split into multiple chunks of ~40 lines each
    expect(chunks.length).toBeGreaterThan(1);

    // All sub-chunks should inherit the symbol name
    for (const chunk of chunks) {
      expect(chunk.symbolName).toBe("processData");
    }
  });
});

// ── Python Support ────────────────────────────────────────────

describe("chunkFiles — Python support", () => {
  const REPO_ID = "test/repo";

  test("extracts Python functions and classes", async () => {
    const pythonCode = `\
import os
import sys

def load_config(path: str) -> dict:
    with open(path, "r") as f:
        data = f.read()
        parsed = eval(data)
        validated = validate(parsed)
        return validated

class DataProcessor:
    def __init__(self, config: dict):
        self.config = config
        self.data = []
        self.processed = False
        self.results = {}

    def process(self) -> None:
        for item in self.data:
            result = self.transform(item)
            self.results[item] = result
        self.processed = True

    def transform(self, item):
        return str(item).upper()`;

    const file = makeFile("app.py", pythonCode, "python");
    const chunks = await chunkFiles([file], REPO_ID);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const names = chunks.map((c) => c.symbolName).filter(Boolean);
    expect(names).toContain("load_config");
    expect(names).toContain("DataProcessor");
  });
});

// ── Multiple Files ────────────────────────────────────────────

describe("chunkFiles — multiple files", () => {
  const REPO_ID = "test/repo";

  test("processes multiple files and returns combined chunks", async () => {
    const tsFile = makeFile(
      "index.ts",
      `\
function main(): void {
  console.log("hello");
  console.log("world");
  const x = 1;
  const y = 2;
  return;
}`,
      "typescript"
    );

    const mdFile = makeFile(
      "README.md",
      Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: Documentation content here.`).join("\n"),
      "markdown"
    );

    const chunks = await chunkFiles([tsFile, mdFile], REPO_ID);

    const tsChunks = chunks.filter((c) => c.filePath === "index.ts");
    const mdChunks = chunks.filter((c) => c.filePath === "README.md");

    expect(tsChunks.length).toBeGreaterThanOrEqual(1);
    expect(mdChunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Edge Cases ────────────────────────────────────────────────

describe("chunkFiles — edge cases", () => {
  const REPO_ID = "test/repo";

  test("handles empty file list", async () => {
    const chunks = await chunkFiles([], REPO_ID);
    expect(chunks).toEqual([]);
  });

  test("handles file with empty content gracefully", async () => {
    const file = makeFile("empty.ts", "", "typescript");
    const chunks = await chunkFiles([file], REPO_ID);
    expect(chunks.length).toBe(0);
  });

  test("handles file with only whitespace", async () => {
    // 4 newlines = 5 lines, which meets MIN_CHUNK_LINES (5)
    // The sliding-window fallback will produce 1 chunk
    const file = makeFile("whitespace.ts", "\n\n\n\n", "typescript");
    const chunks = await chunkFiles([file], REPO_ID);
    expect(chunks.length).toBe(1);
    expect(chunks[0].symbolName).toBeNull(); // fallback, no AST info
  });

  test("handles file with fewer lines than minimum", async () => {
    // 2 newlines = 3 lines, which is below MIN_CHUNK_LINES (5)
    const file = makeFile("tiny-ws.ts", "\n\n", "typescript");
    const chunks = await chunkFiles([file], REPO_ID);
    expect(chunks.length).toBe(0);
  });
});
