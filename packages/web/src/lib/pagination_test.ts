import { assertEquals } from "@std/assert";
import { shouldFetchNextInitialPage, shouldFetchOnEarlierExpand } from "./pagination.ts";

const NOW = new Date(2026, 6, 21, 15, 0, 0);
const today = (h: number) => new Date(2026, 6, 21, h).toISOString();
const yesterday = (h: number) => new Date(2026, 6, 20, h).toISOString();
const earlier = (h: number) => new Date(2026, 6, 19, h).toISOString();

Deno.test("shouldFetchNextInitialPage - null cursor always ends pagination", () => {
  assertEquals(shouldFetchNextInitialPage([{ added_at: today(9) }], null, NOW), false);
  assertEquals(shouldFetchNextInitialPage([], null, NOW), false);
});

Deno.test("shouldFetchNextInitialPage - keeps fetching while page is all today/yesterday", () => {
  const page = [{ added_at: today(9) }, { added_at: yesterday(20) }];
  assertEquals(shouldFetchNextInitialPage(page, "cursor-2", NOW), true);
});

Deno.test("shouldFetchNextInitialPage - stops as soon as an earlier item appears, even mid-page", () => {
  const page = [{ added_at: yesterday(1) }, { added_at: earlier(23) }];
  assertEquals(shouldFetchNextInitialPage(page, "cursor-2", NOW), false);
});

Deno.test("shouldFetchNextInitialPage - empty page with a cursor still keeps going", () => {
  assertEquals(shouldFetchNextInitialPage([], "cursor-2", NOW), true);
});

Deno.test("shouldFetchOnEarlierExpand - fetches on first expand when Earlier is empty and more data exists", () => {
  assertEquals(shouldFetchOnEarlierExpand(0, "cursor-3"), true);
});

Deno.test("shouldFetchOnEarlierExpand - no fetch when Earlier already has boundary-page items", () => {
  assertEquals(shouldFetchOnEarlierExpand(2, "cursor-3"), false);
});

Deno.test("shouldFetchOnEarlierExpand - no fetch when nothing more to load", () => {
  assertEquals(shouldFetchOnEarlierExpand(0, null), false);
});

Deno.test("shouldFetchOnEarlierExpand - show-more (already has items, cursor advances) is a separate action, not gated here", () => {
  // Show-more just calls the same fetch-more action unconditionally as long
  // as nextCursor isn't null and no fetch is already in flight — this
  // function only governs the *first*, expand-triggered fetch.
  assertEquals(shouldFetchOnEarlierExpand(5, "cursor-4"), false);
});
