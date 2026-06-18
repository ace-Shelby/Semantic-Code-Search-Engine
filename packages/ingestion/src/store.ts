/**
 * @codesearch/ingestion — src/store.ts
 * ───────────────────────────────────────────────────────────────
 * Handles upserting embedded code chunks into Qdrant.
 * Creates the collection if it doesn't exist (idempotent).
 *
 * Dependencies: @qdrant/js-client-rest, @codesearch/shared
 *
 * Run this to verify:
 *   bun run packages/ingestion/src/store.ts
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type { EmbeddedChunk } from "./embedder.ts";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION ?? "code_chunks";
const VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE ?? 1536);

const client = new QdrantClient({ url: QDRANT_URL });

let collectionEnsured = false;

/**
 * Ensure the Qdrant collection exists with the correct vector config.
 * Called once on first upsert; subsequent calls are no-ops.
 */
async function ensureCollection(): Promise<void> {
  if (collectionEnsured) return;

  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await client.createCollection(COLLECTION, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
      // Create payload indexes for efficient filtering
      optimizers_config: {
        indexing_threshold: 0,
      },
    });

    // Index repoId for filtered searches
    await client.createPayloadIndex(COLLECTION, {
      field_name: "repoId",
      field_schema: "keyword",
    });

    // Index language for optional language filtering
    await client.createPayloadIndex(COLLECTION, {
      field_name: "language",
      field_schema: "keyword",
    });

    // Index filePath for file-scoped searches
    await client.createPayloadIndex(COLLECTION, {
      field_name: "filePath",
      field_schema: "keyword",
    });

    console.log(`  Created Qdrant collection "${COLLECTION}" (${VECTOR_SIZE}d, Cosine)`);
  }

  collectionEnsured = true;
}

/**
 * Upsert a batch of embedded chunks into Qdrant.
 * Each chunk becomes a point with its vector + metadata payload.
 */
export async function upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  await ensureCollection();

  const points = chunks.map((chunk) => ({
    id: chunk.id,
    vector: chunk.vector,
    payload: {
      repoId: chunk.repoId,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      language: chunk.language,
      symbolName: chunk.symbolName,
      tokenCount: chunk.tokenCount,
    },
  }));

  await client.upsert(COLLECTION, { points });
}
