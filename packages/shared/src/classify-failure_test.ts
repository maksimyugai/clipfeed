import { assertEquals } from "@std/assert";
import { classifyFailure } from "./classify-failure.ts";

// --- transient ---

Deno.test("classifyFailure: llm timeout (anthropic/gateway) is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: anthropic api error: timed out after 90000ms").class,
    "transient",
  );
});

Deno.test("classifyFailure: llm timeout (workers ai) is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: workers ai error: TimeoutError: timed out after 90000ms")
      .class,
    "transient",
  );
});

Deno.test("classifyFailure: ai gateway 5xx is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: ai gateway error (503): upstream unavailable").class,
    "transient",
  );
});

Deno.test("classifyFailure: anthropic 429 is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: anthropic api error (429): rate limited").class,
    "transient",
  );
});

Deno.test("classifyFailure: anthropic 5xx is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: anthropic api error (500): internal error").class,
    "transient",
  );
});

Deno.test("classifyFailure: a workers ai binding error (non-timeout) is transient", () => {
  assertEquals(
    classifyFailure("internal: summarize: workers ai error: Error: binding unavailable").class,
    "transient",
  );
});

Deno.test("classifyFailure: fetch upstream 5xx is transient", () => {
  assertEquals(
    classifyFailure("internal: fetch: upstream responded 503").class,
    "transient",
  );
});

Deno.test("classifyFailure: dead-lettered queue message is transient", () => {
  assertEquals(classifyFailure("queue: processing failed after retries").class, "transient");
});

Deno.test("classifyFailure: stale-pending sweeper timeout is transient", () => {
  assertEquals(classifyFailure("timeout: processing did not complete").class, "transient");
});

Deno.test("classifyFailure: daily-limit is transient (resets tomorrow), not permanent", () => {
  const result = classifyFailure("daily-limit");
  assertEquals(result.class, "transient");
  assertEquals(result.reason.length > 0, true);
});

// --- permanent ---

Deno.test("classifyFailure: insufficient extracted text is permanent", () => {
  assertEquals(
    classifyFailure("extraction: insufficient text (7 chars)").class,
    "permanent",
  );
});

Deno.test("classifyFailure: fetch 404 is permanent", () => {
  assertEquals(classifyFailure("internal: fetch: upstream responded 404").class, "permanent");
});

Deno.test("classifyFailure: fetch 410 is permanent", () => {
  assertEquals(classifyFailure("internal: fetch: upstream responded 410").class, "permanent");
});

Deno.test("classifyFailure: an ssrf-flagged url is permanent", () => {
  assertEquals(classifyFailure("internal: fetch: blocked by ssrf policy").class, "permanent");
});

Deno.test("classifyFailure: fetch 403 (paywalled/forbidden) is permanent", () => {
  assertEquals(classifyFailure("internal: fetch: upstream responded 403").class, "permanent");
});

Deno.test("classifyFailure: fetch 402 (payment required) is permanent", () => {
  assertEquals(classifyFailure("internal: fetch: upstream responded 402").class, "permanent");
});

// --- permanentReasonKey (SPA localization signal) ---

Deno.test("classifyFailure: each permanent rule sets its own distinct reason key", () => {
  assertEquals(
    classifyFailure("extraction: insufficient text (5 chars)").permanentReasonKey,
    "insufficient_text",
  );
  assertEquals(
    classifyFailure("internal: fetch: upstream responded 404").permanentReasonKey,
    "not_found",
  );
  assertEquals(
    classifyFailure("internal: fetch: upstream responded 410").permanentReasonKey,
    "removed",
  );
  assertEquals(
    classifyFailure("internal: fetch: blocked by ssrf policy").permanentReasonKey,
    "ssrf_blocked",
  );
  assertEquals(
    classifyFailure("internal: fetch: upstream responded 403").permanentReasonKey,
    "paywalled",
  );
  assertEquals(
    classifyFailure("internal: fetch: upstream responded 402").permanentReasonKey,
    "paywalled",
  );
});

Deno.test("classifyFailure: permanentReasonKey is null for transient and unknown classes", () => {
  assertEquals(classifyFailure("daily-limit").permanentReasonKey, null);
  assertEquals(classifyFailure("something unrecognized").permanentReasonKey, null);
});

// --- unknown ---

Deno.test("classifyFailure: summary validation failures are unknown (content-shaped, not infra-shaped)", () => {
  const result = classifyFailure(
    "internal: summarize: summary validation: tldr_ru must be at least 200 characters (got 58)",
  );
  assertEquals(result.class, "unknown");
});

Deno.test("classifyFailure: an unrecognized reason is unknown", () => {
  assertEquals(classifyFailure("something completely unexpected happened").class, "unknown");
});

Deno.test("classifyFailure: the db-layer empty-error coercion fallback is unknown", () => {
  assertEquals(classifyFailure("unknown: no reason recorded (bug)").class, "unknown");
});

// --- matching is case-insensitive and substring-based (survives the internal:<stage>: wrap) ---

Deno.test("classifyFailure: matching is case-insensitive", () => {
  assertEquals(classifyFailure("EXTRACTION: INSUFFICIENT TEXT (3 CHARS)").class, "permanent");
});

Deno.test("classifyFailure: matches mid-string, not just at the start (survives the internal: prefix)", () => {
  // Not prefixed with "internal:" — the raw daily-limit / extraction
  // messages bypass that wrapper entirely (see pipeline.ts's early
  // returns) — both prefixed and unprefixed forms must classify the same.
  assertEquals(classifyFailure("daily-limit").class, classifyFailure("daily-limit").class);
  assertEquals(
    classifyFailure("extraction: insufficient text (1 chars)").class,
    classifyFailure("internal: extract: extraction: insufficient text (1 chars)").class,
  );
});

// --- reason is always populated ---

Deno.test("classifyFailure: reason is a non-empty string for every class", () => {
  for (
    const error of [
      "internal: fetch: upstream responded 404",
      "daily-limit",
      "something unrecognized",
    ]
  ) {
    assertEquals(classifyFailure(error).reason.length > 0, true);
  }
});
