import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

type JsonStatusCode = 400 | 401 | 403 | 404 | 422 | 500 | 503;

interface StandardErrorResponse {
  error: string;
  message: string;
  traceId: string;
  statusCode: number;
}

export const globalErrorHandler: ErrorHandler = (err, c) => {
  const traceId = crypto.randomUUID();
  const statusCode = getStatusCode(err);
  const timestamp = new Date().toISOString();
  const message = getPublicMessage(err, statusCode);

  console.error(`[${timestamp}] [${traceId}] Unhandled error`, {
    method: c.req.method,
    path: c.req.path,
    statusCode,
    message: err instanceof Error ? err.message : String(err),
    ...(process.env.NODE_ENV !== "production" &&
      err instanceof Error && {
        stack: err.stack,
      }),
  });

  const body: StandardErrorResponse = {
    error: toErrorCode(statusCode),
    message,
    traceId,
    statusCode,
  };

  c.header("X-Trace-Id", traceId);
  return c.json(body, statusCode);
};

function getStatusCode(err: Error): JsonStatusCode {
  if (err instanceof HTTPException) {
    if ([400, 401, 403, 404, 422, 503].includes(err.status)) {
      return err.status as JsonStatusCode;
    }
  }

  return 500;
}

function getPublicMessage(err: Error, statusCode: number): string {
  if (err instanceof HTTPException) {
    return err.message;
  }

  if (process.env.NODE_ENV === "production" && statusCode >= 500) {
    return "Internal server error";
  }

  return err instanceof Error ? err.message : "An unexpected error occurred";
}

function toErrorCode(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 422) return "VALIDATION_ERROR";
  if (statusCode === 503) return "SERVICE_UNAVAILABLE";
  return "INTERNAL_SERVER_ERROR";
}
