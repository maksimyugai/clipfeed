import { assertEquals } from "@std/assert";
import type { ArticleListItem } from "@clipfeed/shared/types";
import { mergeRefreshedArticles, pickFailedIds } from "./failedRefresh.ts";

function article(overrides: Partial<ArticleListItem> & { id: string }): ArticleListItem {
  return {
    url: `https://example.com/${overrides.id}`,
    canonical_url: null,
    title: overrides.id,
    source: null,
    author: null,
    published_at: null,
    added_at: "2026-01-01T00:00:00.000Z",
    added_via: "manual",
    lang_original: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    tags: [],
    status: "ready",
    archived: false,
    error: null,
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: null,
    faithfulness_json: null,
    faithfulness_checked_at: null,
    embedded_at: null,
    telegram_published_at: null,
    en_generated_at: null,
    image_key: null,
    image_source_url: null,
    ...overrides,
  };
}

// --- pickFailedIds ---

Deno.test("pickFailedIds - only 'failed' rows are selected", () => {
  const articles = [
    article({ id: "a", status: "ready" }),
    article({ id: "b", status: "failed" }),
    article({ id: "c", status: "pending" }),
    article({ id: "d", status: "failed" }),
  ];
  assertEquals(pickFailedIds(articles), ["b", "d"]);
});

Deno.test("pickFailedIds - empty when there are no failed rows", () => {
  const articles = [article({ id: "a", status: "ready" }), article({ id: "b", status: "pending" })];
  assertEquals(pickFailedIds(articles), []);
});

Deno.test("pickFailedIds - empty list in, empty list out", () => {
  assertEquals(pickFailedIds([]), []);
});

// --- mergeRefreshedArticles ---

Deno.test("mergeRefreshedArticles - a fulfilled result replaces the matching row", () => {
  const current = [article({ id: "a", status: "failed" }), article({ id: "b", status: "ready" })];
  const refreshed = article({ id: "a", status: "ready" });
  const results: PromiseSettledResult<ArticleListItem>[] = [
    { status: "fulfilled", value: refreshed },
  ];
  const merged = mergeRefreshedArticles(current, ["a"], results);
  assertEquals(merged[0], refreshed);
  assertEquals(merged[1], current[1]);
});

Deno.test("mergeRefreshedArticles - a rejected result leaves that row unchanged", () => {
  const current = [article({ id: "a", status: "failed" })];
  const results: PromiseSettledResult<ArticleListItem>[] = [
    { status: "rejected", reason: new Error("network blip") },
  ];
  const merged = mergeRefreshedArticles(current, ["a"], results);
  assertEquals(merged, current);
});

Deno.test("mergeRefreshedArticles - mixed fulfilled/rejected: only the fulfilled ones replace", () => {
  const current = [
    article({ id: "a", status: "failed" }),
    article({ id: "b", status: "failed" }),
    article({ id: "c", status: "failed" }),
  ];
  const bRefreshed = article({ id: "b", status: "ready" });
  const results: PromiseSettledResult<ArticleListItem>[] = [
    { status: "rejected", reason: new Error("x") },
    { status: "fulfilled", value: bRefreshed },
    { status: "rejected", reason: new Error("y") },
  ];
  const merged = mergeRefreshedArticles(current, ["a", "b", "c"], results);
  assertEquals(merged[0], current[0]);
  assertEquals(merged[1], bRefreshed);
  assertEquals(merged[2], current[2]);
});

Deno.test("mergeRefreshedArticles - no ids/results: returns the same list untouched", () => {
  const current = [article({ id: "a", status: "ready" })];
  assertEquals(mergeRefreshedArticles(current, [], []), current);
});

Deno.test("mergeRefreshedArticles - a refreshed row not present in current is simply not inserted (no orphan)", () => {
  const current = [article({ id: "a", status: "failed" })];
  const results: PromiseSettledResult<ArticleListItem>[] = [
    { status: "fulfilled", value: article({ id: "ghost", status: "ready" }) },
  ];
  const merged = mergeRefreshedArticles(current, ["ghost"], results);
  assertEquals(merged, current);
});
