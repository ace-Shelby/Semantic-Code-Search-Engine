/**
 * @codesearch/frontend — app/api/proxy/[...path]/route.ts
 * ───────────────────────────────────────────────────────────────
 * Catch-all proxy route that forwards requests to the Hono backend.
 *
 * This avoids CORS issues by keeping all traffic on the same origin.
 * The path after /api/proxy/ is forwarded to the backend as-is.
 *
 * Example: GET /api/proxy/repos → GET http://127.0.0.1:3001/api/v1/repos
 */

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");

export async function GET(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join("/");
  const url = new URL(request.url);

  try {
    const upstream = await fetch(
      `${BACKEND_URL}/api/v1/${path}${url.search}`,
      {
        headers: forwardHeaders(request),
      }
    );

    return proxyResponse(upstream);
  } catch (err) {
    return new Response(`Bad Gateway: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join("/");
  const body = await request.text();

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/${path}`, {
      method: "POST",
      headers: {
        ...forwardHeaders(request),
        "Content-Type": "application/json",
      },
      body,
    });

    return proxyResponse(upstream);
  } catch (err) {
    return new Response(`Bad Gateway: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join("/");

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/${path}`, {
      method: "DELETE",
      headers: forwardHeaders(request),
    });

    return proxyResponse(upstream);
  } catch (err) {
    return new Response(`Bad Gateway: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
}

// ── Helpers ───────────────────────────────────────────────────

function forwardHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = request.headers.get("Authorization");
  if (auth) headers["Authorization"] = auth;
  return headers;
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const traceId = upstream.headers.get("X-Trace-Id");
  if (traceId) headers.set("X-Trace-Id", traceId);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
