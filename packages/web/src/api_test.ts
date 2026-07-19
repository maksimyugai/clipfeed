import { assertEquals } from "@std/assert";
import { buildArticlesUrl, buildMutationHeaders } from "./api.ts";

Deno.test("buildArticlesUrl: no params yields the bare endpoint", () => {
  assertEquals(buildArticlesUrl({}), "/api/articles");
});

Deno.test("buildArticlesUrl: limit only", () => {
  assertEquals(buildArticlesUrl({ limit: 20 }), "/api/articles?limit=20");
});

Deno.test("buildArticlesUrl: cursor only", () => {
  assertEquals(
    buildArticlesUrl({ cursor: "2026-01-01T00:00:00.000Z" }),
    "/api/articles?cursor=2026-01-01T00%3A00%3A00.000Z",
  );
});

Deno.test("buildArticlesUrl: tag filter", () => {
  assertEquals(buildArticlesUrl({ tag: "news" }), "/api/articles?tag=news");
});

Deno.test("buildArticlesUrl: source filter", () => {
  assertEquals(buildArticlesUrl({ source: "example.com" }), "/api/articles?source=example.com");
});

Deno.test("buildArticlesUrl: search query", () => {
  assertEquals(buildArticlesUrl({ q: "widgets" }), "/api/articles?q=widgets");
});

Deno.test("buildArticlesUrl: archived true/false serialize as 1/0", () => {
  assertEquals(buildArticlesUrl({ archived: true }), "/api/articles?archived=1");
  assertEquals(buildArticlesUrl({ archived: false }), "/api/articles?archived=0");
});

Deno.test("buildArticlesUrl: archived omitted when undefined", () => {
  assertEquals(buildArticlesUrl({ limit: 10 }), "/api/articles?limit=10");
});

Deno.test("buildArticlesUrl: combines cursor + tag + source + q + archived, limit last", () => {
  const url = buildArticlesUrl({
    limit: 20,
    cursor: "c1",
    tag: "ai",
    source: "example.com",
    q: "widget",
    archived: true,
  });
  assertEquals(
    url,
    "/api/articles?limit=20&cursor=c1&tag=ai&source=example.com&q=widget&archived=1",
  );
});

Deno.test("buildArticlesUrl: empty-string filters are omitted, not sent as blank params", () => {
  assertEquals(buildArticlesUrl({ tag: "", source: "", q: "" }), "/api/articles");
});

Deno.test("buildMutationHeaders: attaches cf-turnstile-response when a token is given (active)", () => {
  assertEquals(buildMutationHeaders("some-token"), { "cf-turnstile-response": "some-token" });
});

Deno.test("buildMutationHeaders: no header when the token is null (inactive)", () => {
  assertEquals(buildMutationHeaders(null), {});
});

Deno.test("buildMutationHeaders: no header when the token is undefined (call site omitted it)", () => {
  assertEquals(buildMutationHeaders(undefined), {});
});

Deno.test("buildMutationHeaders: no header for an empty-string token", () => {
  assertEquals(buildMutationHeaders(""), {});
});
