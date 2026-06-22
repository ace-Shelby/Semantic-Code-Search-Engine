/**
 * @codesearch/frontend — app/api/ask/route.ts
 * ───────────────────────────────────────────────────────────────
 * Next.js Edge API route that proxies the SSE stream from the
 * Hono backend to the browser.
 *
 * Why a proxy?
 *   • Avoids CORS complexity — the browser talks to the same origin.
 *   • Lets us inject auth / rate-limiting at the Next.js layer later.
 *   • Edge runtime supports streaming natively with zero buffering.
 *
 * The proxy is transparent: it forwards the request body to the
 * backend and pipes the SSE response stream back to the client
 * byte-for-byte, including all headers the backend sets.
 */

export const runtime = "edge";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  // Forward the request to the Hono backend.
  const upstream = await fetch(`${BACKEND_URL}/api/v1/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body,
  });

  // If the backend returned a non-streaming error (JSON), forward it as-is.
  const contentType = upstream.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "X-Trace-Id": upstream.headers.get("X-Trace-Id") ?? "",
      },
    });
  }

  // The upstream responded with an SSE stream. Pipe it through to the
  // client. Using TransformStream ensures zero-copy proxying with
  // proper backpressure: the readable side only pulls from upstream
  // when the client is ready for more data.
  if (!upstream.body) {
    return new Response("Backend returned empty body", { status: 502 });
  }

  // Build response headers, forwarding the ones the client needs.
  const responseHeaders = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const traceId = upstream.headers.get("X-Trace-Id");
  if (traceId) {
    responseHeaders.set("X-Trace-Id", traceId);
  }

  // Pipe the upstream SSE stream directly to the client.
  // The ReadableStream from fetch is already in the right format —
  // no transformation needed.
  return new Response(upstream.body, {
    status: 200,
    headers: responseHeaders,
  });
}
