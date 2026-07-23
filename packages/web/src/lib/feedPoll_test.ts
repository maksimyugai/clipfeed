import { assertEquals } from "@std/assert";
import { applyFeedPollSnapshot, feedPollDelayMs, hasPendingArticles } from "./feedPoll.ts";
import { FAST_INTERVAL_MS, FAST_PHASE_MS, SLOW_INTERVAL_MS } from "./pollSchedule.ts";
import type { ArticleListItem } from "@clipfeed/shared/types";

function item(status: "pending" | "ready" | "failed"): Pick<ArticleListItem, "status"> {
  return { status };
}

// --- hasPendingArticles ---

Deno.test("hasPendingArticles: false for an empty list", () => {
  assertEquals(hasPendingArticles([]), false);
});

Deno.test("hasPendingArticles: false when nothing is pending", () => {
  assertEquals(hasPendingArticles([item("ready"), item("failed")]), false);
});

Deno.test("hasPendingArticles: true when any single item is pending, regardless of count", () => {
  assertEquals(
    hasPendingArticles([item("ready"), item("pending"), item("ready")]),
    true,
  );
});

Deno.test("hasPendingArticles: true when everything is pending", () => {
  assertEquals(hasPendingArticles([item("pending"), item("pending")]), true);
});

// --- feedPollDelayMs: cadence transition, never gives up ---

Deno.test("feedPollDelayMs: fast interval before the phase boundary", () => {
  assertEquals(feedPollDelayMs(0), FAST_INTERVAL_MS);
  assertEquals(feedPollDelayMs(FAST_PHASE_MS - 1), FAST_INTERVAL_MS);
});

Deno.test("feedPollDelayMs: slow interval at and after the phase boundary", () => {
  assertEquals(feedPollDelayMs(FAST_PHASE_MS), SLOW_INTERVAL_MS);
  assertEquals(feedPollDelayMs(FAST_PHASE_MS * 100), SLOW_INTERVAL_MS);
});

Deno.test("feedPollDelayMs: never returns null, unlike the per-card nextPollDelayMs", () => {
  // Ten hours in — the old per-card poll would have given up long ago.
  assertEquals(feedPollDelayMs(10 * 60 * 60 * 1000), SLOW_INTERVAL_MS);
});

// --- applyFeedPollSnapshot ---

function article(overrides: Partial<ArticleListItem>): ArticleListItem {
  return {
    id: "a1",
    url: "https://example.com/a1",
    canonical_url: null,
    title: "Example",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: "2026-01-01T00:00:00.000Z",
    added_via: "manual",
    lang_original: "en",
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    tags: [],
    status: "pending",
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
    processing_started_at: null,
    ...overrides,
  };
}

Deno.test("applyFeedPollSnapshot: a pending row present in the snapshot is refreshed in place", () => {
  const current = [article({ id: "a1", status: "pending" })];
  const snapshot = [article({ id: "a1", status: "ready", summary_ru: "done" })];
  const result = applyFeedPollSnapshot(current, snapshot);
  assertEquals(result[0].status, "ready");
  assertEquals(result[0].summary_ru, "done");
});

Deno.test("applyFeedPollSnapshot: a non-pending row is left untouched even if the snapshot has a different copy", () => {
  const current = [article({ id: "a1", status: "ready", summary_ru: "original" })];
  const snapshot = [article({ id: "a1", status: "ready", summary_ru: "different" })];
  const result = applyFeedPollSnapshot(current, snapshot);
  assertEquals(result[0].summary_ru, "original");
});

Deno.test("applyFeedPollSnapshot: a pending row absent from the snapshot (e.g. beyond the fetched page) is left untouched", () => {
  const current = [article({ id: "a1", status: "pending" })];
  const result = applyFeedPollSnapshot(current, []);
  assertEquals(result[0].status, "pending");
});

Deno.test("applyFeedPollSnapshot: never inserts a snapshot row that isn't already in `current`", () => {
  const current = [article({ id: "a1", status: "pending" })];
  const snapshot = [
    article({ id: "a1", status: "pending" }),
    article({ id: "a2", status: "ready" }),
  ];
  const result = applyFeedPollSnapshot(current, snapshot);
  assertEquals(result.length, 1);
  assertEquals(result.map((a) => a.id), ["a1"]);
});

Deno.test("applyFeedPollSnapshot: updates every pending row regardless of how many there are, from one snapshot", () => {
  const current = [
    article({ id: "a1", status: "pending" }),
    article({ id: "a2", status: "pending" }),
    article({ id: "a3", status: "pending" }),
  ];
  const snapshot = [
    article({ id: "a1", status: "ready" }),
    article({ id: "a2", status: "failed" }),
    article({ id: "a3", status: "pending" }),
  ];
  const result = applyFeedPollSnapshot(current, snapshot);
  assertEquals(result.map((a) => a.status), ["ready", "failed", "pending"]);
});
