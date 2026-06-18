import type { MiddlewareHandler } from "hono";

interface AuthErrorBody {
  error: string;
  message: string;
  traceId: string;
}

export function requireBearerToken(envKey = "INGEST_API_KEY"): MiddlewareHandler {
  return async (c, next) => {
    const traceId = crypto.randomUUID();
    const expectedToken = process.env[envKey];

    if (!expectedToken) {
      const body: AuthErrorBody = {
        error: "CONFIGURATION_ERROR",
        message: `${envKey} is not configured`,
        traceId,
      };
      return c.json(body, 500);
    }

    const authorization = c.req.header("Authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();

    if (!token || token !== expectedToken) {
      const body: AuthErrorBody = {
        error: "UNAUTHORIZED",
        message: "A valid bearer token is required",
        traceId,
      };
      return c.json(body, 401);
    }

    await next();
  };
}
