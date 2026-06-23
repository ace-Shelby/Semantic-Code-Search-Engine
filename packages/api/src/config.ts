function required(key: string): string {
  const value = Bun.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: Bun.env.PORT || 3001,
  qdrantUrl: Bun.env.QDRANT_URL || "http://localhost:6333",
  redisUrl: Bun.env.REDIS_URL || "redis://localhost:6379",
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: Bun.env.OPENAI_BASE_URL,
  openaiEmbeddingModel: Bun.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  openaiLlmModel: Bun.env.OPENAI_LLM_MODEL || "gpt-4o-mini",
  langfusePublicKey: required("LANGFUSE_PUBLIC_KEY"),
  langfuseSecretKey: required("LANGFUSE_SECRET_KEY"),
  ingestApiKey: required("INGEST_API_KEY"),
  nodeEnv: Bun.env.NODE_ENV || "development",
};
