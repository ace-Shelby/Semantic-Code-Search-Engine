/**
 * @codesearch/ingestion — src/index.ts
 * ───────────────────────────────────────────────────────────────
 * Entry point for the ingestion pipeline.
 *
 * Orchestrates: clone repo → walk files → parse with tree-sitter →
 *               chunk → embed via OpenAI → upsert into Qdrant
 *
 * Dependencies: tree-sitter, openai, @qdrant/js-client-rest, ioredis, @codesearch/shared
 *
 * Run this to verify:
 *   bun run packages/ingestion/src/index.ts
 */

import { walkFiles } from "./walker.ts";
import { chunkFile } from "./chunker.ts";
import { embedChunks } from "./embedder.ts";
import { upsertChunks } from "./store.ts";
import { walkRepo } from "./file-walker.ts";
import { chunkFiles } from "./ast-chunker.ts";
import { BM25Indexer } from "./bm25-indexer.ts";
import { QdrantService } from "./qdrant-service.ts";
import type Redis from "ioredis";
import type { CodeChunk, IngestionJob } from "@codesearch/shared";

const DEFAULT_QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

export { BM25Indexer } from "./bm25-indexer.ts";
export { QdrantService } from "./qdrant-service.ts";

export interface RunGitHubIngestionOptions {
  jobId?: string;
  qdrantUrl?: string;
  redisClient?: Redis;
  onProgress?: (job: IngestionJob) => void | Promise<void>;
}

export async function runIngestion(repoPath: string, repoId: string): Promise<IngestionJob> {
  const job: IngestionJob = {
    id: crypto.randomUUID(),
    repoUrl: repoPath,
    repoId,
    status: "running",
    progress: 0,
    totalChunks: 0,
    processedChunks: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  console.log(`📂 Starting ingestion for ${repoId} at ${repoPath}`);

  try {
    // Step 1: Walk the file tree and filter to supported languages
    const files = await walkFiles(repoPath);
    console.log(`  Found ${files.length} supported source files`);

    // Step 2: Parse and chunk each file
    const allChunks: CodeChunk[] = [];
    for (const file of files) {
      const chunks = await chunkFile(file.absolutePath, file.relativePath, repoId, file.language);
      allChunks.push(...chunks);
    }

    job.totalChunks = allChunks.length;
    console.log(`  Produced ${allChunks.length} chunks`);

    // Step 3: Embed chunks in batches
    const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE ?? 100);
    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);

      const embedded = await embedChunks(batch);
      await upsertChunks(embedded);

      job.processedChunks += batch.length;
      job.progress = job.processedChunks / job.totalChunks;
      job.updatedAt = new Date().toISOString();

      console.log(`  Progress: ${job.processedChunks}/${job.totalChunks} chunks`);
    }

    job.status = "complete";
    job.progress = 1;
    job.updatedAt = new Date().toISOString();
    console.log(`✅ Ingestion complete for ${repoId}`);
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.updatedAt = new Date().toISOString();
    console.error(`❌ Ingestion failed for ${repoId}:`, job.error);
  }

  return job;
}

export async function runGitHubIngestion(
  githubUrl: string,
  repoId: string,
  options: RunGitHubIngestionOptions = {},
): Promise<IngestionJob> {
  const job: IngestionJob = {
    id: options.jobId ?? crypto.randomUUID(),
    repoUrl: githubUrl,
    repoId,
    status: "running",
    progress: 0,
    totalChunks: 0,
    processedChunks: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const qdrant = new QdrantService(options.qdrantUrl ?? DEFAULT_QDRANT_URL);
  const bm25Indexer = options.redisClient
    ? new BM25Indexer(options.redisClient)
    : null;

  const emitProgress = async (): Promise<void> => {
    job.updatedAt = new Date().toISOString();
    await options.onProgress?.({ ...job });
  };

  console.log(`📦 Starting GitHub ingestion for ${githubUrl} as ${repoId}`);

  try {
    await emitProgress();

    const { files } = await walkRepo(githubUrl, repoId);
    const chunks = await chunkFiles(files, repoId);

    job.totalChunks = chunks.length;
    job.processedChunks = 0;
    job.progress = chunks.length === 0 ? 1 : 0;
    await emitProgress();

    if (bm25Indexer) {
      await bm25Indexer.buildIndex(repoId, chunks);
    }

    await qdrant.ensureCollection(repoId);

    const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE ?? 100);
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embedded = await embedChunks(batch);
      await qdrant.upsertChunks(repoId, embedded);

      job.processedChunks += batch.length;
      job.progress = job.totalChunks === 0
        ? 1
        : job.processedChunks / job.totalChunks;
      await emitProgress();
    }

    job.status = "complete";
    job.progress = 1;
    await emitProgress();
    console.log(`✅ GitHub ingestion complete for ${repoId}`);
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    await emitProgress();
    console.error(`❌ GitHub ingestion failed for ${repoId}:`, job.error);
  }

  return job;
}

// ── CLI entry point ───────────────────────────────────────────
// Usage: bun run packages/ingestion/src/index.ts ./path/to/repo owner/repo-name
if (import.meta.main) {
  const [repoPath, repoId] = process.argv.slice(2);
  if (repoPath && repoId) {
    runIngestion(repoPath, repoId).then((job) => {
      console.log("\nFinal job status:", JSON.stringify(job, null, 2));
      process.exit(job.status === "complete" ? 0 : 1);
    });
  } else {
    console.log("Usage: bun run src/index.ts <repo-path> <repo-id>");
    console.log("Example: bun run src/index.ts ./repos/my-project owner/my-project");
  }
}
