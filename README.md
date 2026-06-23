# Semantic Code Search Engine

A state-of-the-art, AI-powered semantic code search engine. It allows you to ingest entire GitHub repositories, chunk their source code using AST parsing, generate high-dimensional embeddings, and perform incredibly accurate natural-language search and Retrieval-Augmented Generation (RAG) over your codebase.

## 🌟 Features
- **Semantic & Hybrid Search**: Combines Dense Vector Search (cosine similarity) with BM25 Keyword Search using Reciprocal Rank Fusion (RRF).
- **Retrieval-Augmented Generation (RAG)**: Ask conversational questions about your codebase. The AI synthesizes answers using retrieved chunks and provides exact file/line citations.
- **AST-Aware Chunking**: Intelligently parses TypeScript, JavaScript, and Python into semantically meaningful chunks (functions, classes) using `tree-sitter`, ensuring embeddings capture full context.
- **Ultra-Premium UI**: A stunning, "Linear-style" frontend with frosted glassmorphism, dot-grid depth, and streaming markdown formatting.

## 🛠️ Tech Stack
- **Runtime & Package Manager**: [Bun](https://bun.sh/)
- **Monorepo**: Turborepo / Bun Workspaces
- **Frontend**: Next.js (React), Tailwind CSS, Framer Motion, Lucide Icons, React Markdown
- **API**: Hono (Edge-ready)
- **Vector Database**: [Qdrant](https://qdrant.tech/)
- **Cache & Rate Limiting**: Redis
- **AI Models**: Gemini (via OpenAI SDK compatibility layer) for embeddings and LLM generation.

## 📂 Project Structure
This is a monorepo structured as follows:
- `packages/api`: The Hono API server handling search, RAG, and health checks.
- `packages/frontend`: The Next.js web application.
- `packages/ingestion`: The worker library for cloning, AST chunking, and embedding GitHub repositories into Qdrant.
- `packages/shared`: Shared TypeScript types and core utilities (Observability, Caching).

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.sh/) installed locally
- Docker & Docker Compose (for running Qdrant and Redis locally)

### 1. Install Dependencies
```bash
bun install
```

### 2. Start Infrastructure
Start the local Qdrant vector database and Redis cache:
```bash
docker-compose up -d
```

### 3. Environment Variables
Copy the example environment file and fill in your Gemini API key (or OpenAI key):
```bash
cp .env.example .env
```
Ensure you set `OPENAI_API_KEY` with your key from [Google AI Studio](https://aistudio.google.com/).

### 4. Run the Development Servers
Start the frontend and API servers in parallel:
```bash
# Start the Next.js Frontend (Runs on port 3000)
npm run dev

# In a separate terminal, start the Hono API (Runs on port 3001)
bun run dev:api
```

## 🧠 How It Works
1. **Ingestion**: You submit a GitHub URL on the frontend. The API triggers the ingestion pipeline.
2. **Chunking**: The repository is cloned. Supported languages are parsed into an Abstract Syntax Tree (AST) to extract functions and classes. Other files use a sliding-window chunker.
3. **Embedding**: Chunks are embedded using `text-embedding-004` (or your chosen model) and stored in Qdrant.
4. **Retrieval**: When you search, the query is embedded and searched against Qdrant. A parallel BM25 search is run. The results are merged via RRF.
5. **Generation**: If you ask a question, the top chunks are injected into a token-budgeted context window, and the LLM streams back a synthesized answer with precise file line citations.

## 🔒 CI/CD & Deployment
- The repository uses GitHub Actions for continuous integration (Typechecking, Linting, Testing).
- **API** is configured for deployment on Railway (via Dockerfile).
- **Frontend** is configured for deployment on Vercel.

## License
MIT
