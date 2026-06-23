/**
 * @codesearch/ingestion — src/embedder.ts
 * ───────────────────────────────────────────────────────────────
 * Generates vector embeddings for code chunks using OpenAI's
 * text-embedding-3-small model. Processes chunks in batches
 * and returns them with their embedding vectors attached.
 *
 * Dependencies: openai, @codesearch/shared
 *
 * Run this to verify:
 *   bun run packages/ingestion/src/embedder.ts
 */

import OpenAI from "openai";
import type { CodeChunk } from "@codesearch/shared";

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseURL: process.env.OPENAI_BASE_URL,
  maxRetries: 5,
});

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

/** A code chunk with its embedding vector attached. */
export interface EmbeddedChunk extends CodeChunk {
  vector: number[];
}

/**
 * Embed an array of code chunks in a single OpenAI API call.
 *
 * The OpenAI embeddings endpoint accepts up to 2048 inputs per call,
 * but we typically batch at ~100 (controlled by EMBEDDING_BATCH_SIZE
 * in the orchestrator). This function handles a single batch.
 */
export async function embedChunks(chunks: CodeChunk[]): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const inputs = chunks.map((chunk) => {
    // Prefix with metadata to improve embedding quality for code
    return `File: ${chunk.filePath} | Language: ${chunk.language} | Symbol: ${chunk.symbolName ?? "N/A"}\n\n${chunk.content}`;
  });

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
    dimensions: Number(process.env.QDRANT_VECTOR_SIZE ?? 768),
  });

  // OpenAI returns embeddings in the same order as input
  return chunks.map((chunk, i) => ({
    ...chunk,
    vector: response.data[i].embedding,
  }));
}
