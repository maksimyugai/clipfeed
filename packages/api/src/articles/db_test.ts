import { assertEquals, assertNotEquals } from "@std/assert";
import {
  backfillNormalizedTags,
  buildListQuery,
  countUnembeddedArticles,
  escapeLikeTerm,
  findRecentTitles,
  findRecentTitlesForDedup,
  getArticlesByIds,
  getFaithfulnessStats,
  insertPendingArticle,
  LIST_COLUMNS,
  listUnembeddedArticles,
  markArticleFailed,
  markArticleReady,
  markEmbedded,
  markStaleArticlesSkipped,
  sweepStalePending,
  TELEGRAM_SKIPPED_STALE_MARKER,
  tokenizeSearchQuery,
  toPublicArticle,
  toPublicListItem,
  updateFaithfulnessOnly,
} from "./db.ts";
import { FakeD1 } from "../testing/fake_d1.ts";
import type { Article, ArticleListItem } from "@clipfeed/shared/types";

// Task 34: guards against LIST_COLUMNS silently drifting behind ArticleListItem
// (Article minus full_text) — a real D1 only returns columns actually
// SELECTed, so a field missing here comes back as undefined for every list
// row in production. FakeD1 can't catch this (it returns whole stored rows
// regardless of the projected column list), which is exactly how
// faithfulness_verdict/embedded_at/telegram_published_at went missing from
// GET /api/articles unnoticed until Task 34's live verification caught it.
//
// Task 40: `expected` used to be a hand-maintained string literal array —
// which had itself silently fallen behind (missing en_generated_at,
// image_key, image_source_url, all added by Task 35 after this test was
// written), so it could never have caught the very class of drift it exists
// to guard against. Deriving `expected` from Object.keys() of a real sample
// typed as ArticleListItem instead means the compiler enforces completeness:
// an added/renamed/removed Article field either breaks this sample's
// type-check or is automatically reflected in `expected`, so a future
// LIST_COLUMNS omission fails this test rather than silently degrading.
const sampleListItem: ArticleListItem = {
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
  summary_ru: "summary",
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
  processing_started_at: null,
  faithfulness_enforced_at: null,
};

Deno.test("LIST_COLUMNS: projects every ArticleListItem column (Article minus full_text)", () => {
  const expected = Object.keys(sampleListItem);
  const columns = LIST_COLUMNS.split(",").map((c) => c.trim());
  for (const field of expected) {
    assertEquals(columns.includes(field), true, `LIST_COLUMNS is missing "${field}"`);
  }
});

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

Deno.test("buildListQuery: q filter matches title + both summaries, with an ESCAPE clause", () => {
  const { sql, binds } = buildListQuery({ limit: 10, q: "widget" });
  assertEquals(
    sql.includes(
      "(title LIKE ? ESCAPE '\\' OR summary_ru LIKE ? ESCAPE '\\' OR summary_en LIKE ? ESCAPE '\\')",
    ),
    true,
  );
  assertEquals(binds.slice(0, 3), ["%widget%", "%widget%", "%widget%"]);
});

Deno.test("buildListQuery: archived true/false bind 1/0", () => {
  assertEquals(buildListQuery({ limit: 5, archived: true }).binds, [1, 6]);
  assertEquals(buildListQuery({ limit: 5, archived: false }).binds, [0, 6]);
});

// --- Task 41 Part D: status filter ---

Deno.test("buildListQuery: status='ready' adds a status = ? condition", () => {
  const { sql, binds } = buildListQuery({ limit: 5, status: "ready" });
  assertEquals(sql.includes("WHERE status = ?"), true);
  assertEquals(binds, ["ready", 6]);
});

Deno.test("buildListQuery: status omitted (undefined) — no status condition, every row eligible", () => {
  const { sql, binds } = buildListQuery({ limit: 5 });
  assertEquals(sql.includes("status = ?"), false);
  assertEquals(sql.includes("WHERE"), false);
  assertEquals(binds, [6]);
});

Deno.test("buildListQuery: combines all filters with AND in a fixed order", () => {
  const { sql, binds } = buildListQuery({
    limit: 5,
    cursor: "2026-01-01T00:00:00.000Z",
    tag: "ai",
    source: "example.com",
    q: "widget",
    archived: true,
    status: "ready",
  });
  assertEquals(
    sql.includes(
      "WHERE added_at < ? AND tags LIKE ? AND source = ? AND " +
        "(title LIKE ? ESCAPE '\\' OR summary_ru LIKE ? ESCAPE '\\' OR summary_en LIKE ? ESCAPE '\\') " +
        "AND archived = ? AND status = ?",
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
    "ready",
    6,
  ]);
});

// --- Task 32: multi-word search — AND-of-terms semantics, byte-safe
// truncation, and LIKE-wildcard escaping. See the incident regression
// test below for the actual root cause (D1's 50-byte LIKE pattern
// limit). ---

Deno.test("tokenizeSearchQuery: single word — one term", () => {
  assertEquals(tokenizeSearchQuery("widget"), ["widget"]);
});

Deno.test("tokenizeSearchQuery: multi-word (Latin) splits into separate terms", () => {
  assertEquals(tokenizeSearchQuery("hugging face"), ["hugging", "face"]);
});

Deno.test("tokenizeSearchQuery: multi-word (Cyrillic) splits into separate terms", () => {
  assertEquals(tokenizeSearchQuery("секьюрити проблемы"), ["секьюрити", "проблемы"]);
});

Deno.test("tokenizeSearchQuery: mixed-script multi-word query", () => {
  assertEquals(
    tokenizeSearchQuery("секьюрити проблемы у hugging face"),
    ["секьюрити", "проблемы", "у", "hugging", "face"],
  );
});

Deno.test("tokenizeSearchQuery: leading/trailing/repeated whitespace collapses — no empty tokens", () => {
  assertEquals(tokenizeSearchQuery("  widget   gadget  "), ["widget", "gadget"]);
});

Deno.test("tokenizeSearchQuery: whitespace-only query yields zero terms (not an empty-string term)", () => {
  assertEquals(tokenizeSearchQuery("   "), []);
});

Deno.test("tokenizeSearchQuery: caps at 6 terms, dropping the rest rather than erroring", () => {
  assertEquals(
    tokenizeSearchQuery("one two three four five six seven eight"),
    ["one", "two", "three", "four", "five", "six"],
  );
});

Deno.test("tokenizeSearchQuery: a single very long term is truncated to the byte budget, not left whole", () => {
  const term = "a".repeat(200);
  const [truncated] = tokenizeSearchQuery(term);
  assertEquals(truncated.length < 200, true);
  assertEquals(new TextEncoder().encode(truncated).length <= 45, true);
});

Deno.test("tokenizeSearchQuery: byte truncation never splits a multi-byte (Cyrillic) code point", () => {
  const term = "а".repeat(100); // Cyrillic а, 2 bytes each
  const [truncated] = tokenizeSearchQuery(term);
  // A clean truncation re-encodes to the same string with no replacement
  // characters — a split code point would corrupt this round-trip.
  const bytes = new TextEncoder().encode(truncated);
  assertEquals(new TextDecoder("utf-8", { fatal: true }).decode(bytes), truncated);
});

Deno.test("escapeLikeTerm: a literal % is escaped so it can't act as a wildcard", () => {
  assertEquals(escapeLikeTerm("50%"), "50\\%");
});

Deno.test("escapeLikeTerm: a literal _ is escaped so it can't act as a single-char wildcard", () => {
  assertEquals(escapeLikeTerm("foo_bar"), "foo\\_bar");
});

Deno.test("escapeLikeTerm: a literal backslash is escaped first, before % and _ are escaped", () => {
  assertEquals(escapeLikeTerm("a\\b"), "a\\\\b");
});

Deno.test("buildListQuery: a term containing wildcard characters is escaped in the bound pattern", () => {
  const { binds } = buildListQuery({ limit: 10, q: "50%_off" });
  assertEquals(binds[0], "%50\\%\\_off%");
});

Deno.test("buildListQuery: multi-word q ANDs one OR-group per term, in term order", () => {
  const { sql, binds } = buildListQuery({ limit: 10, q: "hugging face" });
  const group =
    "(title LIKE ? ESCAPE '\\' OR summary_ru LIKE ? ESCAPE '\\' OR summary_en LIKE ? ESCAPE '\\')";
  assertEquals(sql.includes(`${group} AND ${group}`), true);
  assertEquals(binds.slice(0, 6), [
    "%hugging%",
    "%hugging%",
    "%hugging%",
    "%face%",
    "%face%",
    "%face%",
  ]);
});

Deno.test("buildListQuery: a whitespace-only q adds no condition at all (same as omitting q)", () => {
  const withSpaces = buildListQuery({ limit: 10, q: "   " });
  const withoutQ = buildListQuery({ limit: 10 });
  assertEquals(withSpaces.sql, withoutQ.sql);
  assertEquals(withSpaces.binds, withoutQ.binds);
});

// Regression test for the Task 32 incident: GET /api/articles?q=<multi-word
// phrase> 500'd in production once the raw query string, bound directly as
// a single LIKE pattern, exceeded D1/SQLite's default 50-BYTE LIKE-pattern
// length limit (confirmed empirically against a real D1 binding — a
// 48-byte q produced a 50-byte pattern and succeeded; 49 bytes produced 51
// and threw `D1_ERROR: LIKE or GLOB pattern too complex`, identically for
// ASCII and Cyrillic input). This asserts the actual invariant that
// prevents it from ever recurring: no single generated LIKE pattern can
// exceed that limit, no matter how long the raw query is.
Deno.test("buildListQuery: no generated LIKE pattern can ever exceed D1's 50-byte limit (Task 32 regression)", () => {
  const longMultiWordQuery =
    "секьюрити проблемы у hugging face and quite a few more words piled on to make absolutely sure this is long enough to have crashed the old implementation";
  const { binds } = buildListQuery({ limit: 10, q: longMultiWordQuery });

  const likeBinds = binds.filter((b) => typeof b === "string") as string[];
  assertEquals(likeBinds.length > 0, true);
  for (const pattern of likeBinds) {
    assertEquals(
      new TextEncoder().encode(pattern).length <= 50,
      true,
      `pattern exceeded 50 bytes: ${pattern}`,
    );
  }
});

// --- sweepStalePending: Task 41 Part C two-branch split ---
// PROCESSING branch (processing_started_at set) -> 'timeout: processing did
// not complete', measured from processing_started_at. QUEUE-WAIT branch
// (processing_started_at still null) -> 'queue: never picked up', measured
// from added_at — this is what stops the sweeper punishing a message for
// time it spent waiting in the queue behind others (max_concurrency), not
// actually stuck mid-pipeline.

const NOW = new Date("2026-01-01T00:10:00.000Z");

Deno.test("sweepStalePending: PROCESSING branch — a row whose processing_started_at is older than pendingTimeoutMinutes is flipped, with the processing-timeout error", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "stuck-processing",
      status: "pending",
      added_at: "2025-12-31T23:00:00.000Z", // long before processing even started — irrelevant here
      processing_started_at: "2025-12-31T23:59:00.000Z", // 11 min before NOW
      error: null,
    },
  );

  await sweepStalePending(db, 10, 30, NOW);

  const row = db.rows[0];
  assertEquals(row.status, "failed");
  assertEquals(row.error, "timeout: processing did not complete");
});

Deno.test("sweepStalePending: PROCESSING branch — a row whose processing started recently is left pending", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "processing-fresh",
      status: "pending",
      added_at: "2025-12-31T23:00:00.000Z",
      processing_started_at: "2026-01-01T00:08:00.000Z", // 2 min before NOW
      error: null,
    },
  );

  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "pending");
});

Deno.test("sweepStalePending: QUEUE-WAIT branch — a row that never reached a consumer (processing_started_at null) is flipped once added_at exceeds queueWaitTimeoutMinutes, with the queue-wait error — never the processing-timeout error", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "never-picked-up",
      status: "pending",
      added_at: "2025-12-31T23:39:00.000Z", // 31 min before NOW
      processing_started_at: null,
      error: null,
    },
  );

  await sweepStalePending(db, 10, 30, NOW);

  const row = db.rows[0];
  assertEquals(row.status, "failed");
  assertEquals(row.error, "queue: never picked up");
});

Deno.test("sweepStalePending: QUEUE-WAIT branch — a row still within the queue-wait budget is left pending, even though it's already past pendingTimeoutMinutes", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "still-queued",
      status: "pending",
      added_at: "2026-01-01T00:05:00.000Z", // 5 min before NOW — past a 10min PENDING_TIMEOUT_MIN
      // but well within a 30min QUEUE_WAIT_TIMEOUT_MIN, and this row never
      // started processing — a busy queue, not a stuck pipeline.
      processing_started_at: null,
      error: null,
    },
  );

  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "pending");
});

Deno.test("sweepStalePending: non-pending rows are never touched by either branch", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "old-ready",
      status: "ready",
      added_at: "2025-12-01T00:00:00.000Z",
      processing_started_at: "2025-12-01T00:01:00.000Z",
      error: null,
    },
  );
  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "ready");
});

Deno.test("sweepStalePending: pendingTimeoutMinutes/queueWaitTimeoutMinutes are honored independently — a longer value spares the same row", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "eleven-min-processing",
      status: "pending",
      added_at: "2025-12-31T23:00:00.000Z",
      processing_started_at: "2025-12-31T23:59:00.000Z", // 11 min before NOW
      error: null,
    },
  );

  await sweepStalePending(db, 60, 30, NOW);
  assertEquals(db.rows[0].status, "pending");

  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "failed");
});

// --- Race safety: a swept-to-failed row whose real pipeline completes
// afterward must end up 'ready', never stuck showing the generic sweep
// error for content that actually succeeded. Both sweep UPDATEs re-check
// `status = 'pending'` at execution time (not from a stale read), so
// whichever write actually lands SECOND against a given row is what wins —
// this is what makes the two writes safe regardless of ordering. ---

Deno.test("sweepStalePending: last-writer-safe — a real completion landing AFTER the sweep overwrites the sweep's failure (content wins)", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "race-1",
      status: "pending",
      added_at: "2025-12-31T23:00:00.000Z",
      processing_started_at: "2025-12-31T23:59:00.000Z",
      error: null,
    },
  );

  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "failed");

  // The pipeline, unaware it was just swept, finishes moments later and
  // writes its own real result — markArticleReady is unconditional on id,
  // so this simply overwrites whatever the sweep left behind.
  await markArticleReady(db, "race-1", {
    full_text: "text",
    title: "Race 1",
    author: null,
    lang_original: "en",
    summary_ru: "summary",
    summary_json: {
      title_ru: "t",
      tldr_ru: "t",
      body_ru: [],
      bullets_ru: [],
      tags: [],
      lang_original: "en",
    },
    tags: [],
  });

  assertEquals(db.rows[0].status, "ready");
});

Deno.test("sweepStalePending: last-writer-safe — a real completion landing BEFORE the sweep means the sweep is a no-op (status is no longer 'pending')", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "race-2",
      status: "pending",
      added_at: "2025-12-31T23:00:00.000Z",
      processing_started_at: "2025-12-31T23:59:00.000Z",
      error: null,
    },
  );

  await markArticleReady(db, "race-2", {
    full_text: "text",
    title: "Race 2",
    author: null,
    lang_original: "en",
    summary_ru: "summary",
    summary_json: {
      title_ru: "t",
      tldr_ru: "t",
      body_ru: [],
      bullets_ru: [],
      tags: [],
      lang_original: "en",
    },
    tags: [],
  });
  assertEquals(db.rows[0].status, "ready");

  // The sweep's own WHERE clause re-checks status = 'pending' at UPDATE
  // time — it no longer matches this row at all, so it can't clobber the
  // real result even though processing_started_at is still "stale" old.
  await sweepStalePending(db, 10, 30, NOW);
  assertEquals(db.rows[0].status, "ready");
  assertEquals(db.rows[0].error, null);
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

// --- markStaleArticlesSkipped (Task 37 §2: stale drip candidates are
// skipped, not queued forever) ---

const STALE_CUTOFF = "2026-01-02T00:00:00.000Z";

Deno.test("markStaleArticlesSkipped: marks only ready/non-archived/unpublished rows older than the cutoff", async () => {
  const db = new FakeD1();
  db.rows.push(
    {
      id: "old-unpublished",
      status: "ready",
      archived: 0,
      telegram_published_at: null,
      added_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "today",
      status: "ready",
      archived: 0,
      telegram_published_at: null,
      added_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "already-published",
      status: "ready",
      archived: 0,
      telegram_published_at: "2026-01-01T05:00:00.000Z",
      added_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "archived",
      status: "ready",
      archived: 1,
      telegram_published_at: null,
      added_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "not-ready",
      status: "pending",
      archived: 0,
      telegram_published_at: null,
      added_at: "2026-01-01T00:00:00.000Z",
    },
  );

  const count = await markStaleArticlesSkipped(db, STALE_CUTOFF);
  assertEquals(count, 1);

  const byId = (id: string) => db.rows.find((r) => r.id === id)!;
  assertEquals(byId("old-unpublished").telegram_published_at, TELEGRAM_SKIPPED_STALE_MARKER);
  assertEquals(byId("today").telegram_published_at, null);
  assertEquals(byId("already-published").telegram_published_at, "2026-01-01T05:00:00.000Z");
  assertEquals(byId("archived").telegram_published_at, null);
  assertEquals(byId("not-ready").telegram_published_at, null);
});

Deno.test("markStaleArticlesSkipped: a second call with the same cutoff is idempotent, returns 0", async () => {
  const db = new FakeD1();
  db.rows.push({
    id: "old-unpublished",
    status: "ready",
    archived: 0,
    telegram_published_at: null,
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const first = await markStaleArticlesSkipped(db, STALE_CUTOFF);
  assertEquals(first, 1);

  const second = await markStaleArticlesSkipped(db, STALE_CUTOFF);
  assertEquals(second, 0);
  assertEquals(
    db.rows.find((r) => r.id === "old-unpublished")!.telegram_published_at,
    TELEGRAM_SKIPPED_STALE_MARKER,
  );
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

// --- findRecentTitlesForDedup (Task 24 Part B: pre-scrape pool dedup, 72h window) ---

Deno.test("findRecentTitlesForDedup: returns id+title+added_at for rows at/after the window, newest first", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "r1",
    url: "https://example.com/r1",
    title: "Older in-window story",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-02T00:00:00.000Z",
  });
  await insertPendingArticle(db, {
    id: "r2",
    url: "https://example.com/r2",
    title: "Newer in-window story",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-03T00:00:00.000Z",
  });
  await insertPendingArticle(db, {
    id: "r3",
    url: "https://example.com/r3",
    title: "Outside the window",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2025-12-30T00:00:00.000Z",
  });

  const rows = await findRecentTitlesForDedup(db, "2026-01-01T00:00:00.000Z");
  assertEquals(rows, [
    { id: "r2", title: "Newer in-window story", added_at: "2026-01-03T00:00:00.000Z" },
    { id: "r1", title: "Older in-window story", added_at: "2026-01-02T00:00:00.000Z" },
  ]);
});

Deno.test("findRecentTitlesForDedup: caps the result at the given limit", async () => {
  const db = new FakeD1();
  for (let i = 0; i < 5; i++) {
    await insertPendingArticle(db, {
      id: `r${i}`,
      url: `https://example.com/r${i}`,
      title: `Story ${i}`,
      source: "example.com",
      tags: [],
      added_via: "agent",
      added_at: `2026-01-0${i + 1}T00:00:00.000Z`,
    });
  }

  const rows = await findRecentTitlesForDedup(db, "2026-01-01T00:00:00.000Z", 2);
  assertEquals(rows.length, 2);
});

Deno.test("findRecentTitlesForDedup: no matching rows yields an empty array", async () => {
  const db = new FakeD1();
  const rows = await findRecentTitlesForDedup(db, "2026-01-01T00:00:00.000Z");
  assertEquals(rows, []);
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

// --- Embeddings marker column + backfill queries (Task 27) ---

Deno.test("markEmbedded: writes embedded_at, leaves everything else untouched", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "e1",
    url: "https://example.com/e1",
    title: "e1",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "e1", {
    full_text: "full text",
    title: "e1",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });

  await markEmbedded(db, "e1", "2026-01-02T00:00:00.000Z");

  const row = db.rows.find((r) => r.id === "e1")!;
  assertEquals(row.embedded_at, "2026-01-02T00:00:00.000Z");
  assertEquals(row.status, "ready");
});

Deno.test("listUnembeddedArticles/countUnembeddedArticles: only 'ready', non-archived, embedded_at-null rows, oldest first", async () => {
  const db = new FakeD1();

  await insertPendingArticle(db, {
    id: "ready-unembedded-old",
    url: "https://example.com/1",
    title: "one",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "ready-unembedded-old", {
    full_text: "full text",
    title: "one",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });

  await insertPendingArticle(db, {
    id: "ready-unembedded-new",
    url: "https://example.com/2",
    title: "two",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-02T00:00:00.000Z",
  });
  await markArticleReady(db, "ready-unembedded-new", {
    full_text: "full text",
    title: "two",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });

  await insertPendingArticle(db, {
    id: "ready-already-embedded",
    url: "https://example.com/3",
    title: "three",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T12:00:00.000Z",
  });
  await markArticleReady(db, "ready-already-embedded", {
    full_text: "full text",
    title: "three",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });
  await markEmbedded(db, "ready-already-embedded", "2026-01-03T00:00:00.000Z");

  await insertPendingArticle(db, {
    id: "still-pending",
    url: "https://example.com/4",
    title: "four",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T06:00:00.000Z",
  }); // status stays 'pending' -> must be excluded

  assertEquals(await countUnembeddedArticles(db), 2);

  const page = await listUnembeddedArticles(db, 10);
  assertEquals(page.map((a) => a.id), ["ready-unembedded-old", "ready-unembedded-new"]);
  assertEquals(page[0].title_ru, "t");
  assertEquals(page[0].tldr_ru, "t");
  assertEquals(page[0].bullets_ru, []);
  assertEquals(page[0].added_via, "manual");
  assertEquals(page[0].lang_original, "en");

  const firstPage = await listUnembeddedArticles(db, 1);
  assertEquals(firstPage.map((a) => a.id), ["ready-unembedded-old"]);
});

// --- getArticlesByIds: hydrates a Vectorize search result (search.ts) ---

Deno.test("getArticlesByIds: returns full rows (including full_text) for every matching id", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "g1",
    url: "https://example.com/g1",
    title: "one",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleReady(db, "g1", {
    full_text: "the full text",
    title: "one",
    author: null,
    lang_original: "en",
    summary_ru: "s",
    summary_json: MINIMAL_SUMMARY_JSON,
    tags: [],
  });
  await insertPendingArticle(db, {
    id: "g2",
    url: "https://example.com/g2",
    title: "two",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const rows = await getArticlesByIds(db, ["g1", "g2"]);
  assertEquals(rows.map((r) => r.id).sort(), ["g1", "g2"]);
  const g1 = rows.find((r) => r.id === "g1")!;
  assertEquals(g1.full_text, "the full text");
});

Deno.test("getArticlesByIds: an id with no matching row is simply absent, not an error", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "g3",
    url: "https://example.com/g3",
    title: "three",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const rows = await getArticlesByIds(db, ["g3", "does-not-exist"]);
  assertEquals(rows.map((r) => r.id), ["g3"]);
});

Deno.test("getArticlesByIds: an empty id list returns an empty array without querying D1", async () => {
  const db = new FakeD1();
  assertEquals(await getArticlesByIds(db, []), []);
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
    summary_en: null,
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
    embedded_at: null,
    telegram_published_at: null,
    en_generated_at: null,
    image_key: null,
    image_source_url: null,
    processing_started_at: null,
    faithfulness_enforced_at: "2026-01-01T00:05:00.000Z",
  };
  const pub = toPublicArticle(article);
  assertEquals("faithfulness_json" in pub, false);
  assertEquals("faithfulness_enforced_at" in pub, false);
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
    summary_en: null,
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
    embedded_at: null,
    telegram_published_at: null,
    en_generated_at: null,
    image_key: null,
    image_source_url: null,
    processing_started_at: null,
    faithfulness_enforced_at: null,
  };
  const pub = toPublicListItem(item);
  assertEquals("faithfulness_json" in pub, false);
  assertEquals("faithfulness_enforced_at" in pub, false);
  assertEquals("error" in pub, false);
  assertEquals(pub.faithfulness_verdict, "fail");
  assertEquals(pub.has_error, true);
});
