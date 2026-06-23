import type { QdrantClient } from "@qdrant/js-client-rest";
import type { ChunkPayload, VectorSearchResult } from "@codesearch/shared";

const COLLECTION_PREFIX = process.env.QDRANT_COLLECTION_PREFIX ?? "repo_";

interface QdrantHit {
  id: string | number;
  score: number;
  payload?: unknown;
}

export class QdrantService {
  constructor(private readonly client: QdrantClient) {}

  async collectionExists(repoId: string): Promise<boolean> {
    assertRepoId(repoId);

    try {
      await this.client.getCollection(toCollectionName(repoId));
      return true;
    } catch (err) {
      if (isQdrantConnectionError(err)) {
        throw err;
      }

      return false;
    }
  }

  async deleteCollection(repoId: string): Promise<void> {
    assertRepoId(repoId);

    if (!(await this.collectionExists(repoId))) {
      return;
    }

    try {
      await this.client.deleteCollection(toCollectionName(repoId));
    } catch (err) {
      if (isQdrantConnectionError(err)) {
        throw err;
      }

      throw new Error(
        `Failed to delete Qdrant collection for repo "${repoId}": ${formatError(err)}`,
      );
    }
  }

  async similaritySearch(
    repoId: string,
    queryVector: number[],
    topK: number,
    filter?: { language?: string },
  ): Promise<VectorSearchResult[]> {
    assertRepoId(repoId);

    const mustConditions: Array<Record<string, unknown>> = [];
    if (filter?.language) {
      mustConditions.push({
        key: "language",
        match: { value: filter.language },
      });
    }

    try {
      const hits = await this.client.search(toCollectionName(repoId), {
        vector: queryVector,
        limit: topK,
        with_payload: true,
        ...(mustConditions.length > 0 && {
          filter: {
            must: mustConditions,
          },
        }),
      });

      return (hits as QdrantHit[]).map((hit) => ({
        id: String(hit.id),
        score: hit.score,
        payload: toChunkPayload(hit.payload),
      }));
    } catch (err) {
      if (isQdrantConnectionError(err)) {
        throw err;
      }

      throw new Error(
        `Similarity search failed for repo "${repoId}": ${formatError(err)}`,
      );
    }
  }
}

export function toCollectionName(repoId: string): string {
  assertRepoId(repoId);
  return `${COLLECTION_PREFIX}${repoId.toLowerCase()}`;
}

export function isQdrantConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }

  const message = formatError(err).toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("cannot connect") ||
    message.includes("unable to connect")
  );
}

function assertRepoId(repoId: string): void {
  if (repoId.length !== 16) {
    throw new Error("repoId must be exactly 16 characters");
  }
}

function toChunkPayload(payload: unknown): ChunkPayload {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};

  return {
    repoId: String(record.repoId ?? ""),
    filePath: String(record.filePath ?? ""),
    startLine: Number(record.startLine ?? 0),
    endLine: Number(record.endLine ?? 0),
    content: String(record.content ?? ""),
    language: String(record.language ?? "other"),
    symbolName: record.symbolName != null ? String(record.symbolName) : null,
    tokenCount: Number(record.tokenCount ?? 0),
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? ` (${String(err.code)})` : "";
    return `${err.message}${code}`;
  }

  return String(err);
}
