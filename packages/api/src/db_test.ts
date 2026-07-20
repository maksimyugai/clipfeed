import { assertEquals, assertNotEquals } from "@std/assert";
import {
  backfillNormalizedTags,
  buildListQuery,
  insertPendingArticle,
  markArticleFailed,
  markArticleReady,
  sweepStalePending,
} from "./db.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

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
