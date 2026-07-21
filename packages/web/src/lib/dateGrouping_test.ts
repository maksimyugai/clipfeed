import { assertEquals } from "@std/assert";
import { bucketSection, groupArticlesBySection } from "./dateGrouping.ts";

// Fixed "now" for deterministic tests: 2026-07-21 15:00 local time.
const NOW = new Date(2026, 6, 21, 15, 0, 0);

Deno.test("bucketSection - same local calendar day is today", () => {
  assertEquals(bucketSection(new Date(2026, 6, 21, 0, 5).toISOString(), NOW), "today");
  assertEquals(bucketSection(new Date(2026, 6, 21, 23, 55).toISOString(), NOW), "today");
});

Deno.test("bucketSection - previous local calendar day is yesterday", () => {
  assertEquals(bucketSection(new Date(2026, 6, 20, 0, 0).toISOString(), NOW), "yesterday");
  assertEquals(bucketSection(new Date(2026, 6, 20, 23, 59).toISOString(), NOW), "yesterday");
});

Deno.test("bucketSection - two or more days back is earlier", () => {
  assertEquals(bucketSection(new Date(2026, 6, 19, 23, 59).toISOString(), NOW), "earlier");
  assertEquals(bucketSection(new Date(2026, 5, 1, 12, 0).toISOString(), NOW), "earlier");
});

Deno.test("bucketSection - month boundary: yesterday is the last day of the previous month", () => {
  const firstOfMonth = new Date(2026, 6, 1, 10, 0);
  const lastOfPrevMonth = new Date(2026, 5, 30, 23, 30);
  assertEquals(bucketSection(lastOfPrevMonth.toISOString(), firstOfMonth), "yesterday");
});

Deno.test("bucketSection - DST-safe: date-only comparison across a spring-forward day", () => {
  // Not every locale/date has a DST transition, but the bucketing must not
  // care either way — it compares Y/M/D components, never a raw 24h/ms
  // window, so this holds regardless of the host's DST calendar.
  const now = new Date(2026, 2, 9, 15, 0); // 2026-03-09
  const yesterdayLate = new Date(2026, 2, 8, 23, 45); // 2026-03-08 23:45 local
  assertEquals(bucketSection(yesterdayLate.toISOString(), now), "yesterday");
});

Deno.test("groupArticlesBySection - buckets each item individually, page can straddle a boundary", () => {
  const items = [
    { id: "a", added_at: new Date(2026, 6, 21, 9, 0).toISOString() }, // today
    { id: "b", added_at: new Date(2026, 6, 20, 22, 0).toISOString() }, // yesterday
    { id: "c", added_at: new Date(2026, 6, 20, 1, 0).toISOString() }, // yesterday
    { id: "d", added_at: new Date(2026, 6, 19, 23, 0).toISOString() }, // earlier
  ];
  const grouped = groupArticlesBySection(items, NOW);
  assertEquals(grouped.today.map((a) => a.id), ["a"]);
  assertEquals(grouped.yesterday.map((a) => a.id), ["b", "c"]);
  assertEquals(grouped.earlier.map((a) => a.id), ["d"]);
});

Deno.test("groupArticlesBySection - empty input yields empty buckets", () => {
  const grouped = groupArticlesBySection([], NOW);
  assertEquals(grouped.today, []);
  assertEquals(grouped.yesterday, []);
  assertEquals(grouped.earlier, []);
});
