/**
 * @codesearch/api — routes/ask.ts
 * ───────────────────────────────────────────────────────────────
 * RAG (Retrieval-Augmented Generation) endpoint.
 *
 *   POST /  — answer a natural-language question about a repo's code
 *
 * Flow: embed query → retrieve top-K chunks → feed to LLM → return answer + citations
 *
 * Dependencies: hono, openai, @qdrant/js-client-rest, langfuse, @codesearch/shared
 */

import { Hono } from "hono";
import OpenAI from "openai";
import { qdrant, langfuse } from "../clients.ts";
import type {
  SearchRequest,
  RAGAnswer,
  Citation,
  ApiError,
} from "@codesearch/shared";

export const askRouter = new Hono();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
const LLM_MODEL = process.env.OPENAI_LLM_MODEL ?? "gpt-4o-mini";
const COLLECTION = process.env.QDRANT_COLLECTION ?? "code_chunks";

askRouter.post("/", async (c) => {
  const start = performance.now();
  const traceId = crypto.randomUUID();

  // ── Parse & Validate ────────────────────────────────────────
  const body = await c.req.json<{ query?: string; repoId?: string; topK?: number }>();

  if (!body.query || typeof body.query !== "string") {
    const error: ApiError = {
      error: "VALIDATION_ERROR",
      message: "query is required and must be a non-empty string",
      traceId,
    };
    return c.json(error, 400);
  }

  if (!body.repoId || typeof body.repoId !== "string") {
    const error: ApiError = {
      error: "VALIDATION_ERROR",
      message: "repoId is required",
      traceId,
    };
    return c.json(error, 400);
  }

  const topK = body.topK ?? 8;

  // ── Create LangFuse trace ──────────────────────────────────
  const trace = langfuse.trace({
    id: traceId,
    name: "rag-ask",
    metadata: { repoId: body.repoId, topK },
  });

  // ── Step 1: Embed the question ─────────────────────────────
  const embedSpan = trace.span({ name: "embed-question" });

  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: body.query,
  });

  const queryVector = embeddingResponse.data[0].embedding;
  embedSpan.end();

  // ── Step 2: Retrieve relevant chunks ───────────────────────
  const retrieveSpan = trace.span({ name: "retrieve-chunks" });

  const qdrantResults = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit: topK,
    filter: {
      must: [{ key: "repoId", match: { value: body.repoId } }],
    },
    with_payload: true,
  });

  retrieveSpan.end();

  // ── Step 3: Build the prompt with retrieved context ────────
  const contextChunks = qdrantResults.map((hit, i) => {
    const p = hit.payload as Record<string, unknown>;
    return [
      `--- Chunk ${i + 1} ---`,
      `File: ${p.filePath}  Lines: ${p.startLine}-${p.endLine}  Language: ${p.language}`,
      String(p.content ?? ""),
    ].join("\n");
  });

  const systemPrompt = [
    "You are a senior software engineer answering questions about a codebase.",
    "Use ONLY the provided code chunks to answer. If the answer isn't in the chunks, say so.",
    "Format your answer in Markdown. Reference files and line numbers when citing code.",
  ].join(" ");

  const userPrompt = [
    "## Retrieved Code Chunks\n",
    contextChunks.join("\n\n"),
    "\n\n## Question\n",
    body.query,
  ].join("");

  // ── Step 4: Call the LLM ───────────────────────────────────
  const generation = trace.generation({
    name: "llm-answer",
    model: LLM_MODEL,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const chatResponse = await openai.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const answer = chatResponse.choices[0]?.message?.content ?? "No answer generated.";
  const usage = chatResponse.usage;
  const tokenCost = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);

  generation.end({ output: answer, usage: { totalTokens: tokenCost } });

  // ── Step 5: Build citations ────────────────────────────────
  const citations: Citation[] = qdrantResults.map((hit) => {
    const p = hit.payload as Record<string, unknown>;
    return {
      filePath: String(p.filePath ?? ""),
      startLine: Number(p.startLine ?? 0),
      endLine: Number(p.endLine ?? 0),
      relevanceScore: hit.score,
    };
  });

  const latencyMs = Math.round(performance.now() - start);

  trace.update({ output: { answerLength: answer.length, tokenCost, latencyMs } });
  await langfuse.flushAsync();

  c.header("X-Trace-Id", traceId);

  const response: RAGAnswer = { answer, citations, tokenCost, latencyMs, traceId };
  return c.json(response);
});
