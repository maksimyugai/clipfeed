import { assertEquals, assertNotEquals } from "@std/assert";
import {
  backfillNormalizedTags,
  buildListQuery,
  findRecentTitles,
  getFaithfulnessStats,
  insertPendingArticle,
  markArticleFailed,
  markArticleReady,
  sweepStalePending,
  toPublicArticle,
  toPublicListItem,
  updateFaithfulnessOnly,
} from "./db.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import type { Article, ArticleListItem } from "@clipfeed/shared/types";

Deno.test("buildListQuery: no filters — base query, default limit + 1", () => {
  const { sql, binds } = buildListQuery({ limit: 20 });
  assertEquals(sql.startsWith("SELECT"), true);
  assertEquals(sql.includes("WHERE"), false);
  assertEquals(sql.endsWith("ORDER BY added_at DESC LIMIT ?"), true);
  assertEquals(binds, [21]);
});

Deno.test("buildListQuery: cursor filters strictly-less-than and binds it first", () => {
  const { sql, binds } = buildListQuery({ limit: 10, cursor: "2026-01-01T00:00:00.000Z" });
  assertEquals(sql.includes("WHERE added_at < ?"), true);
  assertEquals(binds, ["2026-01-01T00:00:00.000Z", 11]);
});

Deno.test("buildListQuery: tag filter uses a JSON-array LIKE pattern", () => {
  const { sql, binds } = buildListQuery({ limit: 10, tag: "news" });
  assertEquals(sql.includes("tags LIKE ?"), true);
  assertEquals(binds[0], '%"news"%');
});

Deno.test("buildListQuery: q filter matches title + both summaries", () => {
  const { sql, binds } = buildListQuery({ limit: 10, q: "widget" });
  assertEquals(sql.includes("(title LIKE ? OR summary_ru LIKE ? OR summary_en LIKE ?)"), true);
  assertEquals(binds.slice(0, 3), ["%widget%", "%widget%", "%widget%"]);
});

Deno.test("buildListQuery: archived true/false bind 1/0", () => {
  assertEquals(buildListQuery({ limit: 5, archived: true }).binds, [1, 6]);
  assertEquals(buildListQuery({ limit: 5, archived: false }).binds, [0, 6]);
});

Deno.test("buildListQuery: combines all filters with AND in a fixed order", () => {
  const { sql, binds } = buildListQuery({
    limit: 5,
    cursor: "2026-01-01T00:00:00.000Z",
    tag: "ai",
    source: "example.com",
    q: "widget",
    archived: true,
  });
  assertEquals(
    sql.includes(
      "WHERE added_at < ? AND tags LIKE ? AND source = ? AND (title LIKE ? OR summary_ru LIKE ? OR summary_en LIKE ?) AND archived = ?",
    ),
    true,
  );
  assertEquals(binds, [
    "2026-01-01T00:00:00.000Z",
    '%"ai"%',
    "example.com",
    "%widget%",
    "%widget%",
    "%widget%",
    1,
    6,
  ]);
});

// --- sweepStalePending ---

Deno.test("sweepStalePending: flips only pending rows older than the timeout, leaves newer/non-pending rows alone", async () => {
  const db = new FakeD1();
  db.rows.push(
    { id: "old-pending", status: "pending", added_at: "2025-12-31T23:49:00.000Z", error: null },
    { id: "new-pending", status: "pending", added_at: "2026-01-01T00:08:00.000Z", error: null },
    { id: "old-ready", status: "ready", added_at: "2025-12-31T23:00:00.000Z", error: null },
  );

  await sweepStalePending(db, 10, new Date("2026-01-01T00:10:00.000Z"));

  const byId = (id: string) => db.rows.find((r) => r.id === id)!;
  assertEquals(byId("old-pending").status, "failed");
  assertEquals(byId("old-pending").error, "timeout: processing did not complete");
  assertEquals(byId("new-pending").status, "pending");
  assertEquals(byId("new-pending").error, null);
  assertEquals(byId("old-ready").status, "ready");
});

Deno.test("sweepStalePending: timeout value is honored — a longer timeout spares the same row", async () => {
  const db = new FakeD1();
  db.rows.push(
    { id: "eleven-min-old", status: "pending", added_at: "2025-12-31T23:59:00.000Z", error: null },
  );
  const now = new Date("2026-01-01T00:10:00.000Z");

  await sweepStalePending(db, 60, now);
  assertEquals(db.rows[0].status, "pending");

  await sweepStalePending(db, 10, now);
  assertEquals(db.rows[0].status, "failed");
});

// --- markArticleFailed: no code path may persist an empty/whitespace error ---

Deno.test("markArticleFailed: a normal non-empty reason is stored as-is", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "a1", status: "pending", error: null });
  await markArticleFailed(db, "a1", "internal: fetch: network down");
  assertEquals(db.rows[0].status, "failed");
  assertEquals(db.rows[0].error, "internal: fetch: network down");
});

Deno.test("markArticleFailed: an empty string is coerced to a diagnostic fallback reason", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "a2", status: "pending", error: null });
  await markArticleFailed(db, "a2", "");
  assertEquals(db.rows[0].status, "failed");
  assertEquals(db.rows[0].error, "unknown: no reason recorded (bug)");
  assertNotEquals(db.rows[0].error, "");
  assertNotEquals(db.rows[0].error, null);
});

Deno.test("markArticleFailed: a whitespace-only string is coerced the same way", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "a3", status: "pending", error: null });
  await markArticleFailed(db, "a3", "   \n\t  ");
  assertEquals(db.rows[0].error, "unknown: no reason recorded (bug)");
});

// --- tag normalization (see tags.ts) applied on persist — integration,
// not just the pure normalizeTags() unit tests in tags_test.ts ---

Deno.test("insertPendingArticle: normalizes tags on insert (covers manual/extension, telegram, and agent seeds, which all call this)", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "t1",
    url: "https://example.com/t1",
    title: "t1",
    source: "example.com",
    tags: ["AI", "ии", "ai", "таймаут"],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = db.rows.find((r) => r.id === "t1")!;
  assertEquals(JSON.parse(row.tags as string), ["ai"]);
});

Deno.test("markArticleReady: normalizes tags on the pipeline's success write", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "t2",
    url: "https://example.com/t2",
    title: "t2",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "t2", {
    full_text: "full text",
    title: "t2",
    author: null,
    lang_original: "en",
    summary_ru: "summary",
    summary_en: "summary",
    summary_json: {
      title_ru: "t",
      title_en: "t",
      tldr_ru: "t",
      tldr_en: "t",
      body_ru: [],
      body_en: [],
      bullets_ru: [],
      bullets_en: [],
      tags: [],
      lang_original: "en",
    },
    tags: ["Programmirovanie", "программирование", "google"],
  });
  const row = db.rows.find((r) => r.id === "t2")!;
  assertEquals(JSON.parse(row.tags as string), ["programming", "google"]);
});

// --- backfillNormalizedTags (POST /api/admin/tags/normalize) ---

Deno.test("backfillNormalizedTags: normalizes only rows whose stored tags actually change, reports an accurate count", async () => {
  const db = new FakeD1();
  db.rows.push(
    { id: "b1", tags: JSON.stringify(["ИИ", "ai"]) }, // will change: case dedupe
    { id: "b2", tags: JSON.stringify(["security"]) }, // already normalized: no change
    { id: "b3", tags: JSON.stringify(["таймаут", "space"]) }, // will change: drop + already-plain
  );

  const updated = await backfillNormalizedTags(db);
  assertEquals(updated, 2);

  assertEquals(JSON.parse(db.rows.find((r) => r.id === "b1")!.tags as string), ["ai"]);
  assertEquals(JSON.parse(db.rows.find((r) => r.id === "b2")!.tags as string), ["security"]);
  assertEquals(JSON.parse(db.rows.find((r) => r.id === "b3")!.tags as string), ["space"]);
});

Deno.test("backfillNormalizedTags: a second run is a no-op (idempotent), returns 0", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "b1", tags: JSON.stringify(["ИИ", "ai", "таймаут"]) });

  const first = await backfillNormalizedTags(db);
  assertEquals(first, 1);

  const second = await backfillNormalizedTags(db);
  assertEquals(second, 0);
});

Deno.test("backfillNormalizedTags: a row with no tags at all (null column) is left alone, not counted", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "b4", tags: null });
  const updated = await backfillNormalizedTags(db);
  assertEquals(updated, 0);
});

// --- findRecentTitles (Task 19 Part C: story-level dedup against-DB window) ---

Deno.test("findRecentTitles: returns titles of rows added at/after the given ISO timestamp", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "r1",
    url: "https://example.com/r1",
    title: "Recent story one",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-02T12:00:00.000Z",
  });
  await insertPendingArticle(db, {
    id: "r2",
    url: "https://example.com/r2",
    title: "Older story",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2025-12-30T00:00:00.000Z",
  });

  const titles = await findRecentTitles(db, "2026-01-01T00:00:00.000Z");
  assertEquals(titles, ["Recent story one"]);
});

Deno.test("findRecentTitles: includes rows regardless of status/archived — any saved title counts as 'already covered'", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "r1",
    url: "https://example.com/r1",
    title: "A failed pick",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-02T12:00:00.000Z",
  });
  await markArticleFailed(db, "r1", "internal: fetch: upstream responded 403");

  const titles = await findRecentTitles(db, "2026-01-01T00:00:00.000Z");
  assertEquals(titles, ["A failed pick"]);
});

Deno.test("findRecentTitles: no matching rows yields an empty array", async () => {
  const db = new FakeD1();
  const titles = await findRecentTitles(db, "2026-01-01T00:00:00.000Z");
  assertEquals(titles, []);
});

// --- Faithfulness check (Task 23) ---

const MINIMAL_SUMMARY_JSON = {
  title_ru: "t",
  title_en: "t",
  tldr_ru: "t",
  tldr_en: "t",
  body_ru: [],
  body_en: [],
  bullets_ru: [],
  bullets_en: [],
  tags: [],
  lang_original: "en",
};

Deno.test("markArticleReady: faithfulness omitted -> the 3 columns are not touched (stay at their insert-time default)", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "f1",
    url: "https://example.com/f1",
    title: "f1",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "f1", {
    full_text: "full text",
    title: "f1",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_en: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });
  const row = db.rows.find((r) => r.id === "f1")!;
  assertEquals(row.faithfulness_verdict, null);
  assertEquals(row.faithfulness_json, null);
  assertEquals(row.faithfulness_checked_at, null);
});

Deno.test("markArticleReady: faithfulness present -> all 3 columns written, JSON round-trips", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "f2",
    url: "https://example.com/f2",
    title: "f2",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "f2", {
    full_text: "full text",
    title: "f2",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_en: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
    faithfulness: {
      verdict: "weak",
      json: { claims: [{ i: 1, verdict: "unsupported", evidence: "x" }], notes: "n" },
      checkedAt: "2026-01-01T00:05:00.000Z",
    },
  });
  const row = db.rows.find((r) => r.id === "f2")!;
  assertEquals(row.faithfulness_verdict, "weak");
  assertEquals(
    JSON.parse(row.faithfulness_json as string),
    { claims: [{ i: 1, verdict: "unsupported", evidence: "x" }], notes: "n" },
  );
  assertEquals(row.faithfulness_checked_at, "2026-01-01T00:05:00.000Z");
  assertEquals(row.status, "ready"); // the rest of the write still applies normally
});

Deno.test("markArticleReady: faithfulness with a null verdict (judge unparseable) still writes json/checkedAt", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "f3",
    url: "https://example.com/f3",
    title: "f3",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "f3", {
    full_text: "full text",
    title: "f3",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_en: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
    faithfulness: {
      verdict: null,
      json: { error: "judge unparseable" },
      checkedAt: "2026-01-01T00:05:00.000Z",
    },
  });
  const row = db.rows.find((r) => r.id === "f3")!;
  assertEquals(row.faithfulness_verdict, null);
  assertEquals(JSON.parse(row.faithfulness_json as string), { error: "judge unparseable" });
  assertEquals(row.faithfulness_checked_at, "2026-01-01T00:05:00.000Z");
});

Deno.test("updateFaithfulnessOnly: updates only the 3 faithfulness columns, leaves status/summary untouched", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "f4",
    url: "https://example.com/f4",
    title: "f4",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "f4", {
    full_text: "full text",
    title: "f4",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_en: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });

  await updateFaithfulnessOnly(db, "f4", {
    verdict: "fail",
    json: { claims: [{ i: 1, verdict: "contradicted", evidence: "x" }], notes: "" },
    checkedAt: "2026-02-01T00:00:00.000Z",
  });

  const row = db.rows.find((r) => r.id === "f4")!;
  assertEquals(row.faithfulness_verdict, "fail");
  assertEquals(row.faithfulness_checked_at, "2026-02-01T00:00:00.000Z");
  assertEquals(row.status, "ready");
  assertEquals(JSON.parse(row.summary_json as string), MINIMAL_SUMMARY_JSON);
});

Deno.test("getFaithfulnessStats: counts pass/weak/fail/null across all rows", async () => {
  const db = new FakeD1();
  for (const [id, verdict] of [["p1", "pass"], ["p2", "pass"], ["w1", "weak"], ["fa1", "fail"]]) {
    await insertPendingArticle(db, {
      id,
      url: `https://example.com/${id}`,
      title: id,
      source: "example.com",
      tags: [],
      added_via: "manual",
      added_at: "2026-01-01T00:00:00.000Z",
    });
    await updateFaithfulnessOnly(db, id, {
      verdict: verdict as "pass" | "weak" | "fail",
      json: { claims: [], notes: "" },
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  await insertPendingArticle(db, {
    id: "n1",
    url: "https://example.com/n1",
    title: "n1",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  }); // never checked -> null bucket

  const stats = await getFaithfulnessStats(db);
  assertEquals(stats, { pass: 2, weak: 1, fail: 1, null: 1 });
});

// --- Public-shape redaction (toPublicArticle/toPublicListItem) ---

Deno.test("toPublicArticle: strips faithfulness_json but keeps faithfulness_verdict", () => {
  const article: Article = {
    id: "a1",
    url: "https://example.com/a1",
    canonical_url: null,
    title: "a1",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: "2026-01-01T00:00:00.000Z",
    added_via: "manual",
    lang_original: "en",
    full_text: "full text",
    summary_ru: "s",
    summary_en: "s",
    summary_json: null,
    tags: [],
    status: "ready",
    archived: false,
    error: null,
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: "weak",
    faithfulness_json: { claims: [{ i: 1, verdict: "unsupported", evidence: "x" }], notes: "n" },
    faithfulness_checked_at: "2026-01-01T00:05:00.000Z",
  };
  const pub = toPublicArticle(article);
  assertEquals("faithfulness_json" in pub, false);
  assertEquals("full_text" in pub, false);
  assertEquals("error" in pub, false);
  assertEquals(pub.faithfulness_verdict, "weak");
  assertEquals(pub.has_error, false);
});

Deno.test("toPublicListItem: strips faithfulness_json but keeps faithfulness_verdict", () => {
  const item: ArticleListItem = {
    id: "a2",
    url: "https://example.com/a2",
    canonical_url: null,
    title: "a2",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: "2026-01-01T00:00:00.000Z",
    added_via: "manual",
    lang_original: "en",
    summary_ru: "s",
    summary_en: "s",
    summary_json: null,
    tags: [],
    status: "ready",
    archived: false,
    error: "internal detail",
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: "fail",
    faithfulness_json: { error: "judge unparseable" },
    faithfulness_checked_at: "2026-01-01T00:05:00.000Z",
  };
  const pub = toPublicListItem(item);
  assertEquals("faithfulness_json" in pub, false);
  assertEquals("error" in pub, false);
  assertEquals(pub.faithfulness_verdict, "fail");
  assertEquals(pub.has_error, true);
});
