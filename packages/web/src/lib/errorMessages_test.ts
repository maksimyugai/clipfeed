import { assertEquals } from "@std/assert";
import { ApiError } from "../api.ts";
import { classifyApiError, type ErrorMessageDict, localizedErrorMessage } from "./errorMessages.ts";

const DICT: ErrorMessageDict = {
  errorAlreadyReady: "ALREADY_READY",
  errorDuplicateUrl: "DUPLICATE_URL",
  errorSimilarTitle: "SIMILAR_TITLE",
  errorUnauthorized: "UNAUTHORIZED",
  errorRateLimited: "RATE_LIMITED",
  errorServerError: "SERVER_ERROR",
  errorGeneric: "GENERIC",
};

// --- classifyApiError: the mapping table ---

Deno.test("classifyApiError - 409 'article is already ready' -> already-ready", () => {
  const err = new ApiError("article is already ready", 409);
  assertEquals(classifyApiError(err), "already-ready");
});

Deno.test("classifyApiError - 409 'duplicate' with no reason -> duplicate-url", () => {
  const err = new ApiError("duplicate", 409, { error: "duplicate" });
  assertEquals(classifyApiError(err), "duplicate-url");
});

Deno.test("classifyApiError - 409 'duplicate' with reason 'similar_title' -> similar-title", () => {
  const err = new ApiError("duplicate", 409, { error: "duplicate", reason: "similar_title" });
  assertEquals(classifyApiError(err), "similar-title");
});

Deno.test("classifyApiError - 409 'duplicate' with no body at all -> duplicate-url (not similar-title)", () => {
  const err = new ApiError("duplicate", 409);
  assertEquals(classifyApiError(err), "duplicate-url");
});

Deno.test("classifyApiError - 401 -> unauthorized", () => {
  assertEquals(classifyApiError(new ApiError("unauthorized", 401)), "unauthorized");
});

Deno.test("classifyApiError - 429 -> rate-limited", () => {
  assertEquals(classifyApiError(new ApiError("too many requests", 429)), "rate-limited");
});

Deno.test("classifyApiError - 500/502/503 -> server-error", () => {
  assertEquals(classifyApiError(new ApiError("boom", 500)), "server-error");
  assertEquals(classifyApiError(new ApiError("bad gateway", 502)), "server-error");
  assertEquals(classifyApiError(new ApiError("unavailable", 503)), "server-error");
});

Deno.test("classifyApiError - an unrecognized 4xx (e.g. a stray 400/404/409) -> unknown", () => {
  assertEquals(classifyApiError(new ApiError("bad request", 400)), "unknown");
  assertEquals(classifyApiError(new ApiError("not found", 404)), "unknown");
  assertEquals(classifyApiError(new ApiError("article must be ready or failed", 409)), "unknown");
});

Deno.test("classifyApiError - a non-ApiError (network failure, plain Error, anything else) -> unknown", () => {
  assertEquals(classifyApiError(new Error("fetch failed")), "unknown");
  assertEquals(classifyApiError("just a string"), "unknown");
  assertEquals(classifyApiError(null), "unknown");
  assertEquals(classifyApiError(undefined), "unknown");
});

// --- localizedErrorMessage: never the raw server string ---

Deno.test("localizedErrorMessage - maps every known kind to its dict entry, never err.message", () => {
  assertEquals(
    localizedErrorMessage(new ApiError("article is already ready", 409), DICT),
    "ALREADY_READY",
  );
  assertEquals(
    localizedErrorMessage(new ApiError("duplicate", 409, { error: "duplicate" }), DICT),
    "DUPLICATE_URL",
  );
  assertEquals(
    localizedErrorMessage(
      new ApiError("duplicate", 409, { error: "duplicate", reason: "similar_title" }),
      DICT,
    ),
    "SIMILAR_TITLE",
  );
  assertEquals(localizedErrorMessage(new ApiError("nope", 401), DICT), "UNAUTHORIZED");
  assertEquals(localizedErrorMessage(new ApiError("slow down", 429), DICT), "RATE_LIMITED");
  assertEquals(localizedErrorMessage(new ApiError("boom", 500), DICT), "SERVER_ERROR");
});

Deno.test("localizedErrorMessage - unknown/non-ApiError always falls back to the generic copy, never the raw message", () => {
  assertEquals(
    localizedErrorMessage(new Error("some raw technical stack trace text"), DICT),
    "GENERIC",
  );
  assertEquals(localizedErrorMessage(new ApiError("weird raw text", 418), DICT), "GENERIC");
});
