import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import { ObservabilityService } from "@codesearch/shared";

export const PORT = Number(process.env.API_PORT ?? 3001);
export const HOST = process.env.API_HOST ?? "0.0.0.0";
export const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export const observability = new ObservabilityService({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
  baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
});
