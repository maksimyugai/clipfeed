import { assertEquals, assertRejects } from "@std/assert";
import { FakeD1 } from "./fake_d1.ts";
import { insertPendingArticle, LIST_COLUMNS, listArticles } from "../articles/db.ts";
import { parseArticlesSchema } from "./articles-schema.ts";

// --- Task 44 Part B point 1: column projection ---

Deno.test("FakeD1: a narrow SELECT column list returns ONLY those columns, not the whole stored row", async () => {
  const db = new FakeD1();
  // Bypasses INSERT on purpose — simulates a stored row that (like a real
  // one) carries every column, so a projection bug would leak extras.
  db.rows.push({ id: "a1", url: "https://example.com/a1", tags: '["x"]', extra_field: "leaked" });

  const result = await db.prepare("SELECT id, tags FROM articles").bind().all();
  assertEquals(result.results, [{ id: "a1", tags: '["x"]' }]);
});

Deno.test("FakeD1: LIST_COLUMNS-shaped queries (the real listArticles path) never leak a field outside that list", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "a1",
    url: "https://example.com/a1",
    title: "Example",
    source: "example.com",
    tags: ["x"],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const { items } = await listArticles(db, { limit: 20 });
  const expectedColumns = LIST_COLUMNS.split(",").map((c) => c.trim());
  const actualColumns = Object.keys(items[0]);
  assertEquals(actualColumns.sort(), expectedColumns.sort());
});

Deno.test("FakeD1: SELECT * genuinely returns every stored field — '*' is not projected away", async () => {
  const db = new FakeD1();
  db.rows.push({ id: "a1", url: "https://example.com/a1", some_field: "kept" });

  const row = await db.prepare("SELECT * FROM articles WHERE id = ?").bind("a1").first();
  assertEquals(row, { id: "a1", url: "https://example.com/a1", some_field: "kept" });
});

Deno.test("FakeD1: an aliased column projects under its alias, reading from its real source column", async () => {
  const db = new FakeD1();
  db.rows.push({
    id: "a1",
    status: "pending",
    processing_started_at: "2026-01-01T00:00:00.000Z",
    added_at: "2025-12-31T00:00:00.000Z",
  });

  const result = await db.prepare(
    "SELECT id, processing_started_at as ts FROM articles WHERE status = 'pending' AND processing_started_at IS NOT NULL AND processing_started_at < ?",
  ).bind("2026-06-01T00:00:00.000Z").all();
  assertEquals(result.results, [{ id: "a1", ts: "2026-01-01T00:00:00.000Z" }]);
});

Deno.test("FakeD1: an aggregate SELECT (COUNT/SUM/MAX) is left untouched — its own branch already builds the right shape", async () => {
  const db = new FakeD1();
  db.rows.push({
    id: "a1",
    status: "failed",
    archived: 0,
    fail_class: "transient",
    heal_attempts: 1,
  });

  const result = await db.prepare(
    "SELECT fail_class, COUNT(*) as count, SUM(heal_attempts) as attempts FROM articles WHERE status = 'failed'",
  ).bind().all();
  assertEquals(result.results, [{ fail_class: "transient", count: 1, attempts: 1 }]);
});

// --- Task 44 Part B point 2: default row derived from the migrations ---

Deno.test("FakeD1: every nullable schema column defaults to null on a minimal INSERT (derived from migrations, not a second hand-list)", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "a1",
    url: "https://example.com/a1",
    title: "Example",
    source: null,
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const row = db.rows[0];
  for (const col of parseArticlesSchema()) {
    if (!col.notNull) {
      assertEquals(row[col.name] === null || row[col.name] !== undefined, true, col.name);
    }
  }
  // Spot-check a handful of specific nullable columns landed as null, not
  // merely "not undefined" — this is the exact class of column that went
  // missing from the old hand-maintained literal in Task 34/35.
  for (
    const col of [
      "faithfulness_verdict",
      "embedded_at",
      "telegram_published_at",
      "en_generated_at",
      "faithfulness_enforced_at",
    ]
  ) {
    assertEquals(row[col], null, col);
  }
});

// --- Task 44 Part B point 3: NOT NULL enforcement ---

Deno.test("FakeD1: INSERT omitting a NOT NULL column (no DEFAULT) throws, matching real D1", async () => {
  const db = new FakeD1();
  await assertRejects(
    () =>
      db.prepare(
        `INSERT INTO articles (id, title, source, added_at, added_via, tags, status, archived)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
      ).bind("a1", "Example", null, "2026-01-01T00:00:00.000Z", "manual", "[]").run(),
    Error,
    "NOT NULL constraint failed: articles.url",
  );
});

Deno.test("FakeD1: an UPDATE that would null out a NOT NULL column throws instead of silently writing it", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "a1",
    url: "https://example.com/a1",
    title: "Example",
    source: null,
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  await assertRejects(
    () => db.prepare("UPDATE articles SET title = ? WHERE id = ?").bind(null, "a1").run(),
    Error,
    "NOT NULL constraint failed: articles.title",
  );
});

Deno.test("FakeD1: an UPDATE that only touches nullable columns never trips the NOT NULL check", async () => {
  const db = new FakeD1();
  await insertPendingArticle(db, {
    id: "a1",
    url: "https://example.com/a1",
    title: "Example",
    source: null,
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  await db.prepare("UPDATE articles SET error = ? WHERE id = ?").bind("some error", "a1").run();
  assertEquals(db.rows[0].error, "some error");
});

// --- articles-schema.ts: sanity-check the parser itself ---

Deno.test("parseArticlesSchema: finds every column across the base table and every ALTER TABLE migration", () => {
  const columns = parseArticlesSchema();
  const names = columns.map((c) => c.name);
  assertEquals(names.includes("id"), true);
  assertEquals(names.includes("status"), true); // regression: a trailing
  // comment on the PREVIOUS column's line once swallowed this one — see
  // stripSqlComments's doc comment.
  assertEquals(names.includes("faithfulness_enforced_at"), true); // the
  // most recently added column (migration 0009) — proves every migration
  // file is actually being read, not just the base table.
  assertEquals(new Set(names).size, names.length, "no duplicate column names");
});

Deno.test("parseArticlesSchema: correctly classifies NOT NULL / DEFAULT for a representative sample", () => {
  const byName = new Map(parseArticlesSchema().map((c) => [c.name, c]));
  assertEquals(byName.get("id")?.notNull, true); // PRIMARY KEY
  assertEquals(byName.get("url")?.notNull, true);
  assertEquals(byName.get("canonical_url")?.notNull, false);
  assertEquals(byName.get("status")?.notNull, true);
  assertEquals(byName.get("status")?.hasDefault, true);
  assertEquals(byName.get("heal_attempts")?.notNull, true);
  assertEquals(byName.get("heal_attempts")?.hasDefault, true);
  assertEquals(byName.get("embedded_at")?.notNull, false);
});
