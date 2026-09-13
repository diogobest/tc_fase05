import type { ErrorRequestHandler, RequestHandler } from "express";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown[];
  constructor(
    status: number,
    code: string,
    message: string,
    details: unknown[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound: RequestHandler = (_req, _res, next) =>
  next(new AppError(404, "NOT_FOUND", "Resource not found"));

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let normalized = error instanceof AppError ? error : undefined;
  if (!normalized && error?.type === "entity.too.large") normalized = new AppError(413, "PAYLOAD_TOO_LARGE", "Request payload is too large");
  if (!normalized && error instanceof SyntaxError && "body" in error) normalized = new AppError(400, "INVALID_JSON", "Malformed JSON body");
  if (!normalized && error?.code === "23514") normalized = new AppError(422, "CONSTRAINT_VIOLATION", "Data violates a business constraint");
  const known = Boolean(normalized);
  const status = normalized?.status ?? 500;
  if (!known) console.error(JSON.stringify({ requestId: req.requestId, error: String(error) }));
  res.status(status).json({ error: {
    code: normalized?.code ?? "INTERNAL_ERROR",
    message: normalized?.message ?? "An unexpected error occurred",
    details: normalized?.details ?? [],
    requestId: req.requestId,
  } });
};
