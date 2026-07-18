import { assertEquals } from "@std/assert";
import { buildListQuery } from "./db.ts";

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
