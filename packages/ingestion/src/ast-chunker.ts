/**
 * @codesearch/ingestion — src/ast-chunker.ts
 * ───────────────────────────────────────────────────────────────
 * AST-aware code chunker for the ingestion pipeline.
 *
 * For TypeScript, JavaScript, and Python files: parses the source
 * into an AST using tree-sitter, extracts top-level symbols
 * (functions, classes, arrow functions, exports), and produces
 * semantically meaningful chunks.
 *
 * For Go, Markdown, JSON, and other languages: falls back to a
 * line-based sliding-window chunker (40 lines, 8-line overlap).
 *
 * Oversized AST nodes (>600 tokens) are automatically split
 * using the sliding-window strategy.
 *
 * Dependencies: tree-sitter, tree-sitter-typescript,
 *               tree-sitter-javascript, tree-sitter-python,
 *               nanoid, @codesearch/shared
 */

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import { nanoid } from "nanoid";
import type { RawFile, CodeChunk, Language } from "@codesearch/shared";

// ── Constants ─────────────────────────────────────────────────

/** Maximum tokens per chunk before forced splitting. */
const MAX_CHUNK_TOKENS = 600;

/** Characters per token (rough approximation for code). */
const CHARS_PER_TOKEN = 4;

/** Max characters before a node is split (derived from token limit). */
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;

/** Lines per chunk for the sliding-window fallback. */
const WINDOW_LINES = 40;

/** Overlap lines between adjacent sliding-window chunks. */
const OVERLAP_LINES = 8;

/** Minimum lines for a chunk to be kept (smaller chunks are noise). */
const MIN_CHUNK_LINES = 5;

// ── Language → Grammar Mapping ────────────────────────────────

/** Languages that have tree-sitter grammars and get AST-aware chunking. */
type ASTLanguage = "typescript" | "javascript" | "python";

/**
 * Map of language → tree-sitter grammar.
 * Only languages in this map get AST-aware chunking; all others
 * fall back to the sliding-window strategy.
 */
const GRAMMAR_MAP: Record<ASTLanguage, unknown> = {
  typescript: TypeScript.typescript,
  javascript: JavaScript,
  python: Python,
};

/** Check whether a language has a tree-sitter grammar available. */
function isASTLanguage(lang: Language): lang is ASTLanguage {
  return lang in GRAMMAR_MAP;
}

// ── AST Node Types ────────────────────────────────────────────

/**
 * Top-level AST node types we consider meaningful chunk boundaries.
 *
 * TypeScript/JavaScript:
 *   - function_declaration:   `function foo() {}`
 *   - class_declaration:      `class Foo {}`
 *   - method_definition:      (inside class bodies, but also extracted as children)
 *   - lexical_declaration:    `const foo = () => {}` (arrow functions assigned to variables)
 *   - variable_declaration:   `var foo = () => {}`
 *   - export_statement:       `export function foo()` / `export const foo = () => {}`
 *
 * Python:
 *   - function_definition:    `def foo():`
 *   - class_definition:       `class Foo:`
 *   - decorated_definition:   `@decorator \n def foo():`
 */
const EXTRACTABLE_NODE_TYPES = new Set([
  // TypeScript / JavaScript
  "function_declaration",
  "class_declaration",
  "method_definition",
  "lexical_declaration",
  "variable_declaration",
  "export_statement",
  // Python
  "function_definition",
  "class_definition",
  "decorated_definition",
]);

// ── Public API ────────────────────────────────────────────────

/**
 * Chunk an array of raw files into embedding-ready {@link CodeChunk}s.
 *
 * Uses AST-aware chunking for TypeScript, JavaScript, and Python.
 * Falls back to sliding-window chunking for all other languages.
 *
 * @param files   — Raw files from the FileWalker
 * @param repoId  — Repository identifier (included in every chunk)
 * @returns Flat array of code chunks, filtered to remove trivially small chunks (<5 lines)
 *
 * @example
 * ```ts
 * const rawFiles = await walkRepo("https://github.com/expressjs/express", "express-123");
 * const chunks = await chunkFiles(rawFiles.files, "express-123");
 * console.log(`Produced ${chunks.length} chunks`);
 * ```
 */
export async function chunkFiles(files: RawFile[], repoId: string): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    try {
      const chunks = chunkSingleFile(file, repoId);
      allChunks.push(...chunks);
    } catch (err) {
      console.warn(
        `⚠️  Failed to chunk ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Fall back to sliding-window on any parse error
      const fallbackChunks = slidingWindowChunk(file.content, file.filePath, repoId, file.language);
      allChunks.push(...fallbackChunks);
      console.log(`   Chunked ${file.filePath}: ${fallbackChunks.length} chunks (sliding-window/error-fallback)`);
    }
  }

  return allChunks;
}

// ── Single File Chunking ──────────────────────────────────────

/**
 * Chunk a single file, choosing the appropriate strategy
 * based on the file's language.
 */
function chunkSingleFile(file: RawFile, repoId: string): CodeChunk[] {
  if (isASTLanguage(file.language)) {
    return chunkWithAST(file, repoId);
  }

  const chunks = slidingWindowChunk(file.content, file.filePath, repoId, file.language);
  console.log(`   Chunked ${file.filePath}: ${chunks.length} chunks (sliding-window)`);
  return chunks;
}

// ── AST-Aware Chunking ───────────────────────────────────────

/**
 * Parse a file with tree-sitter and extract semantically meaningful
 * chunks from the AST. Falls back to sliding-window if no extractable
 * top-level symbols are found or if the parser returns null.
 */
function chunkWithAST(file: RawFile, repoId: string): CodeChunk[] {
  const grammar = GRAMMAR_MAP[file.language as ASTLanguage];

  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);

  const tree = parser.parse(file.content);

  // Handle parser returning null (corrupted input, encoding issues)
  if (!tree || !tree.rootNode) {
    console.warn(`   ⚠️  tree-sitter returned null for ${file.filePath}, falling back to sliding-window`);
    const chunks = slidingWindowChunk(file.content, file.filePath, repoId, file.language);
    console.log(`   Chunked ${file.filePath}: ${chunks.length} chunks (sliding-window/parse-failed)`);
    return chunks;
  }

  const chunks: CodeChunk[] = [];
  const rootChildren = tree.rootNode.children;

  for (const node of rootChildren) {
    if (!EXTRACTABLE_NODE_TYPES.has(node.type)) {
      continue;
    }

    // Unwrap export_statement to get the inner declaration
    const { targetNode, symbolName } = unwrapNode(node);

    const content = file.content.slice(targetNode.startIndex, targetNode.endIndex);
    const startLine = targetNode.startPosition.row + 1; // tree-sitter is 0-indexed
    const endLine = targetNode.endPosition.row + 1;
    const tokenCount = estimateTokens(content);

    if (tokenCount > MAX_CHUNK_TOKENS) {
      // Oversized node — split it, but preserve the symbol name on all sub-chunks
      const subChunks = slidingWindowChunkFromNode(
        content,
        startLine,
        file.filePath,
        repoId,
        file.language,
        symbolName
      );
      chunks.push(...subChunks);
    } else {
      const lineCount = endLine - startLine + 1;
      if (lineCount >= MIN_CHUNK_LINES) {
        chunks.push({
          id: crypto.randomUUID(),
          repoId,
          filePath: file.filePath,
          startLine,
          endLine,
          content,
          language: file.language,
          symbolName,
          tokenCount,
        });
      }
    }
  }

  // If the AST produced no usable chunks, fall back to sliding-window
  if (chunks.length === 0 && file.content.length > 0) {
    const fallback = slidingWindowChunk(file.content, file.filePath, repoId, file.language);
    console.log(`   Chunked ${file.filePath}: ${fallback.length} chunks (sliding-window/no-symbols)`);
    return fallback;
  }

  console.log(`   Chunked ${file.filePath}: ${chunks.length} chunks (ast)`);
  return chunks;
}

// ── Node Unwrapping ───────────────────────────────────────────

interface UnwrappedNode {
  /** The innermost meaningful AST node (after stripping export wrappers). */
  targetNode: Parser.SyntaxNode;
  /** Human-readable symbol name (function/class/variable name), or null. */
  symbolName: string | null;
}

/**
 * Unwrap a top-level AST node to find the actual declaration and its name.
 *
 * Handles the following patterns:
 *   - `function foo() {}`          → name = "foo"
 *   - `class Foo {}`               → name = "Foo"
 *   - `const foo = () => {}`       → name = "foo"
 *   - `export function foo() {}`   → unwrap export, name = "foo"
 *   - `export const foo = () => {}` → unwrap export, name = "foo"
 *   - `@decorator def foo():`      → unwrap decorator, name = "foo"
 *
 * We keep the full node text (including the `export` keyword / decorator)
 * so the chunk contains complete, valid code.
 */
function unwrapNode(node: Parser.SyntaxNode): UnwrappedNode {
  // The targetNode for slicing is always the outermost node
  // (we want `export function foo()` not just `function foo()`)
  const targetNode = node;

  const symbolName = extractSymbolName(node);
  return { targetNode, symbolName };
}

/**
 * Recursively extract a human-readable symbol name from an AST node.
 *
 * Traverses through export wrappers, decorators, lexical declarations,
 * and variable declarators to find the `name` field.
 */
function extractSymbolName(node: Parser.SyntaxNode): string | null {
  // Direct name child (function_declaration, class_declaration, etc.)
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return nameNode.text;
  }

  // export_statement → unwrap to declaration
  if (node.type === "export_statement") {
    const declaration = node.childForFieldName("declaration");
    if (declaration) {
      return extractSymbolName(declaration);
    }
    // `export default expression` — no declaration field
    return null;
  }

  // decorated_definition (Python) → unwrap to definition
  if (node.type === "decorated_definition") {
    const definition = node.childForFieldName("definition");
    if (definition) {
      return extractSymbolName(definition);
    }
    return null;
  }

  // lexical_declaration / variable_declaration → find variable_declarator
  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
    for (const child of node.children) {
      if (child.type === "variable_declarator") {
        const varName = child.childForFieldName("name");
        if (varName) {
          return varName.text;
        }
      }
    }
    return null;
  }

  return null;
}

// ── Sliding Window Chunking ───────────────────────────────────

/**
 * Split file content into chunks using a line-based sliding window.
 * Used for languages without tree-sitter grammars, or as a fallback
 * when AST parsing produces no extractable symbols.
 *
 * @param windowSize  — Lines per chunk (default: 40)
 * @param overlapSize — Overlap between adjacent chunks (default: 8)
 */
function slidingWindowChunk(
  content: string,
  filePath: string,
  repoId: string,
  language: Language,
  windowSize: number = WINDOW_LINES,
  overlapSize: number = OVERLAP_LINES,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  const step = windowSize - overlapSize;

  let offset = 0;
  while (offset < lines.length) {
    const end = Math.min(offset + windowSize, lines.length);
    const chunkLines = lines.slice(offset, end);
    const chunkContent = chunkLines.join("\n");
    const lineCount = end - offset;

    // Only keep chunks with enough substance
    if (lineCount >= MIN_CHUNK_LINES) {
      chunks.push({
        id: crypto.randomUUID(),
        repoId,
        filePath,
        startLine: offset + 1,          // 1-indexed
        endLine: end,                    // 1-indexed, inclusive
        content: chunkContent,
        language,
        symbolName: null,                // no AST info for fallback chunks
        tokenCount: estimateTokens(chunkContent),
      });
    }

    if (end >= lines.length) break;
    offset += step;
  }

  return chunks;
}

/**
 * Split an oversized AST node using the sliding-window strategy,
 * preserving its symbol name across all sub-chunks.
 */
function slidingWindowChunkFromNode(
  content: string,
  baseStartLine: number,
  filePath: string,
  repoId: string,
  language: Language,
  symbolName: string | null,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  const step = WINDOW_LINES - OVERLAP_LINES;

  let offset = 0;
  while (offset < lines.length) {
    const end = Math.min(offset + WINDOW_LINES, lines.length);
    const chunkLines = lines.slice(offset, end);
    const chunkContent = chunkLines.join("\n");
    const lineCount = end - offset;

    if (lineCount >= MIN_CHUNK_LINES) {
      chunks.push({
        id: crypto.randomUUID(),
        repoId,
        filePath,
        startLine: baseStartLine + offset,   // offset from the node's start line
        endLine: baseStartLine + end - 1,     // inclusive
        content: chunkContent,
        language,
        symbolName,
        tokenCount: estimateTokens(chunkContent),
      });
    }

    if (end >= lines.length) break;
    offset += step;
  }

  return chunks;
}

// ── Utilities ─────────────────────────────────────────────────

/**
 * Estimate the token count for a string of code.
 *
 * Uses the approximation: **1 token ≈ 4 characters**.
 *
 * This is a deliberately rough estimate because:
 * 1. **Speed**: Real tokenizers (tiktoken, cl100k_base) are expensive — they
 *    require WASM/native bindings, and calling them per-chunk during ingestion
 *    of thousands of files adds significant latency for negligible benefit.
 * 2. **Good enough**: For code, chars/4 closely tracks the actual token count
 *    from OpenAI's tokenizer. OpenAI's own documentation suggests ~4 chars/token
 *    for English text; code tends to have shorter tokens (operators, brackets)
 *    but also long identifiers, so it averages out.
 * 3. **Consistency**: We only need token counts for two things — enforcing the
 *    chunk size limit (where ±20% accuracy is fine) and estimating embedding
 *    costs (where the real cost comes from the API call overhead, not individual
 *    tokens). A real tokenizer would give false precision.
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}
