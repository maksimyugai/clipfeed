import { ApiError } from "../api.ts";

export type ApiErrorKind =
  | "already-ready"
  | "duplicate-url"
  | "similar-title"
  | "unauthorized"
  | "rate-limited"
  | "server-error"
  | "unknown";

interface DuplicateErrorBody {
  reason?: string;
}

// Classifies a caught error into a small, known vocabulary — never a raw
// server string. A non-ApiError (network failure, a JS bug elsewhere) also
// falls to 'unknown': there's nothing more specific to say about it either.
// The two 409 "duplicate" shapes (see POST /api/admin/articles) share the
// exact same `error: "duplicate"` message and are told apart only by the
// `reason` field on the parsed body — see ApiError.body.
export function classifyApiError(err: unknown): ApiErrorKind {
  if (!(err instanceof ApiError)) return "unknown";
  if (err.status === 409 && err.message === "article is already ready") {
    return "already-ready";
  }
  if (err.status === 409 && err.message === "duplicate") {
    const body = err.body as DuplicateErrorBody | undefined;
    return body?.reason === "similar_title" ? "similar-title" : "duplicate-url";
  }
  if (err.status === 401) return "unauthorized";
  if (err.status === 429) return "rate-limited";
  if (err.status >= 500) return "server-error";
  return "unknown";
}

export interface ErrorMessageDict {
  errorAlreadyReady: string;
  errorDuplicateUrl: string;
  errorSimilarTitle: string;
  errorUnauthorized: string;
  errorRateLimited: string;
  errorServerError: string;
  errorGeneric: string;
}

// The one place that turns a caught error into user-facing text — every
// toast call site should route through this instead of interpolating
// err.message directly (see App.tsx's showError). 'already-ready' is
// included for completeness/reuse even though the retry flow's happy path
// never surfaces it as a toast at all — see App.tsx's handleRetry, which
// intercepts that case before it would reach here.
export function localizedErrorMessage(err: unknown, dict: ErrorMessageDict): string {
  switch (classifyApiError(err)) {
    case "already-ready":
      return dict.errorAlreadyReady;
    case "duplicate-url":
      return dict.errorDuplicateUrl;
    case "similar-title":
      return dict.errorSimilarTitle;
    case "unauthorized":
      return dict.errorUnauthorized;
    case "rate-limited":
      return dict.errorRateLimited;
    case "server-error":
      return dict.errorServerError;
    case "unknown":
      return dict.errorGeneric;
  }
}
