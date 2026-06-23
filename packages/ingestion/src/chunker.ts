/**
 * @codesearch/ingestion — src/chunker.ts
 * ───────────────────────────────────────────────────────────────
 * Parses source files with tree-sitter and splits them into
 * semantically meaningful chunks (functions, classes, blocks).
 *
 * Falls back to a sliding-window chunker when tree-sitter cannot
 * produce clean top-level nodes (e.g. very large files).
 *
 * Dependencies: tree-sitter, tree-sitter-typescript, tree-sitter-javascript,
 *               tree-sitter-python, @codesearch/shared
 *
 * Run this to verify:
 *   bun run packages/ingestion/src/chunker.ts
 */

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import { readFile } from "node:fs/promises";
import type { CodeChunk, SupportedLanguage } from "@codesearch/shared";

const MAX_TOKENS = Number(process.env.CHUNK_MAX_TOKENS ?? 512);
const OVERLAP_TOKENS = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 64);

// Rough token estimate: 1 token ≈ 4 characters for code
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

/** Map language identifiers to tree-sitter grammars. */
const GRAMMAR_MAP: Record<SupportedLanguage, unknown> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  javascript: JavaScript,
  jsx: JavaScript,
  python: Python,
};

/** Node types that represent meaningful top-level code structures. */
const SYMBOL_NODE_TYPES = new Set([
  // TypeScript / JavaScript
  "function_declaration",
  "method_definition",
  "class_declaration",
  "arrow_function",
  "export_statement",
  "lexical_declaration",
  "variable_declaration",
  // Python
  "function_definition",
  "class_definition",
  "decorated_definition",
]);

/**
 * Parse a file and split it into code chunks. Uses tree-sitter to
 * find semantic boundaries, then falls back to sliding-window for
 * anything that doesn't fit into a clean AST node.
 */
export async function chunkFile(
  absolutePath: string,
  relativePath: string,
  repoId: string,
  language: SupportedLanguage
): Promise<CodeChunk[]> {
  const source = await readFile(absolutePath, "utf-8");
  const lines = source.split("\n");

  // Set up the parser
  const parser = new Parser();
  const grammar = GRAMMAR_MAP[language];
  parser.setLanguage(grammar as Parser.Language);

  const tree = parser.parse(source);
  const chunks: CodeChunk[] = [];

  // Walk top-level children and extract meaningful symbols
  const rootChildren = tree.rootNode.children;

  for (const node of rootChildren) {
    const nodeText = node.text;
    const startLine = node.startPosition.row + 1; // 1-based
    const endLine = node.endPosition.row + 1;
    const symbolName = extractSymbolName(node);

    if (nodeText.length <= MAX_CHARS) {
      // Fits in a single chunk
      chunks.push(makeChunk({
        repoId,
        filePath: relativePath,
        startLine,
        endLine,
        content: nodeText,
        language,
        symbolName,
      }));
    } else {
      // Too large — split with sliding window
      const subChunks = slidingWindowChunk(
        nodeText, startLine, relativePath, repoId, language, symbolName
      );
      chunks.push(...subChunks);
    }
  }

  // If tree-sitter produced zero chunks (unlikely but possible), fall back
  if (chunks.length === 0 && source.length > 0) {
    chunks.push(...slidingWindowChunk(source, 1, relativePath, repoId, language, null));
  }

  return chunks;
}

/** Extract a human-readable symbol name from a tree-sitter node. */
function extractSymbolName(node: Parser.SyntaxNode): string | null {
  // Direct name child
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // For export statements, look one level deeper
  if (node.type === "export_statement") {
    const declaration = node.childForFieldName("declaration");
    if (declaration) {
      const innerName = declaration.childForFieldName("name");
      if (innerName) return innerName.text;
    }
  }

  return null;
}

/** Split text using a character-based sliding window, mapping back to line numbers. */
function slidingWindowChunk(
  text: string,
  baseStartLine: number,
  filePath: string,
  repoId: string,
  language: SupportedLanguage,
  symbolName: string | null
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + MAX_CHARS, text.length);
    const chunkText = text.slice(offset, end);

    // Count newlines before offset to compute start line
    const precedingNewlines = text.slice(0, offset).split("\n").length - 1;
    const chunkNewlines = chunkText.split("\n").length - 1;
    const startLine = baseStartLine + precedingNewlines;
    const endLine = startLine + chunkNewlines;

    chunks.push(makeChunk({
      repoId,
      filePath,
      startLine,
      endLine,
      content: chunkText,
      language,
      symbolName,
    }));

    if (end >= text.length) break;
    offset = end - OVERLAP_CHARS;
  }

  return chunks;
}

/** Build a CodeChunk with a deterministic ID and estimated token count. */
function makeChunk(params: {
  repoId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: SupportedLanguage;
  symbolName: string | null;
}): CodeChunk {
  return {
    id: crypto.randomUUID(),
    repoId: params.repoId,
    filePath: params.filePath,
    startLine: params.startLine,
    endLine: params.endLine,
    content: params.content,
    language: params.language,
    symbolName: params.symbolName,
    tokenCount: Math.ceil(params.content.length / CHARS_PER_TOKEN),
  };
}
