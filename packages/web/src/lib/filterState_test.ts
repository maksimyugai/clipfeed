import { assertEquals } from "@std/assert";
import {
  EMPTY_FILTER_STATE,
  filterReducer,
  type FilterState,
  hasActiveFilters,
} from "./filterState.ts";
import { buildArticlesUrl } from "../api.ts";

function toUrl(state: FilterState): string {
  return buildArticlesUrl({
    tag: state.tag ?? undefined,
    source: state.source ?? undefined,
    q: state.query || undefined,
  });
}

Deno.test("filterReducer: set-tag activates a tag filter", () => {
  const next = filterReducer(EMPTY_FILTER_STATE, { type: "set-tag", tag: "ai" });
  assertEquals(next, { tag: "ai", source: null, query: "" });
});

Deno.test("filterReducer: set-tag with null (toggle-off) clears only the tag", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "hello" };
  const next = filterReducer(active, { type: "set-tag", tag: null });
  assertEquals(next, { tag: null, source: "example.com", query: "hello" });
});

Deno.test("filterReducer: set-source with null (toggle-off) clears only the source", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "hello" };
  const next = filterReducer(active, { type: "set-source", source: null });
  assertEquals(next, { tag: "ai", source: null, query: "hello" });
});

Deno.test("filterReducer: set-source with null (chip-dismiss) behaves the same as toggle-off", () => {
  // The chip's dismiss ("✕") button always passes null, regardless of the
  // current value — same reducer path as a pill re-click, verified equal.
  const active: FilterState = { tag: null, source: "news.example", query: "" };
  const dismissed = filterReducer(active, { type: "set-source", source: null });
  const toggledOff = filterReducer(active, { type: "set-source", source: null });
  assertEquals(dismissed, toggledOff);
  assertEquals(dismissed, { tag: null, source: null, query: "" });
});

Deno.test("filterReducer: set-query updates only the query, leaving tag/source untouched", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "" };
  const next = filterReducer(active, { type: "set-query", query: "rust" });
  assertEquals(next, { tag: "ai", source: "example.com", query: "rust" });
});

Deno.test("filterReducer: clear-all resets tag, source, AND query together", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "rust" };
  const next = filterReducer(active, { type: "clear-all" });
  assertEquals(next, { tag: null, source: null, query: "" });
});

Deno.test("hasActiveFilters: false when both tag and source are null", () => {
  assertEquals(hasActiveFilters({ tag: null, source: null }), false);
});

Deno.test("hasActiveFilters: true when only a tag is active", () => {
  assertEquals(hasActiveFilters({ tag: "ai", source: null }), true);
});

Deno.test("hasActiveFilters: true when only a source is active", () => {
  assertEquals(hasActiveFilters({ tag: null, source: "example.com" }), true);
});

// --- reducer + URL-builder combinations (the actual fetch query the SPA sends) ---

Deno.test("combo: clear-all -> buildArticlesUrl drops tag/source/q entirely", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "rust" };
  const cleared = filterReducer(active, { type: "clear-all" });
  assertEquals(toUrl(cleared), "/api/articles");
});

Deno.test("combo: toggle-off a tag leaves the source and query in the URL", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "rust" };
  const next = filterReducer(active, { type: "set-tag", tag: null });
  assertEquals(toUrl(next), "/api/articles?source=example.com&q=rust");
});

Deno.test("combo: chip-dismiss a source leaves the tag and query in the URL", () => {
  const active: FilterState = { tag: "ai", source: "example.com", query: "rust" };
  const next = filterReducer(active, { type: "set-source", source: null });
  assertEquals(toUrl(next), "/api/articles?tag=ai&q=rust");
});

Deno.test("combo: setting a new tag while a source is active keeps both in the URL", () => {
  const withSource: FilterState = { tag: null, source: "example.com", query: "" };
  const next = filterReducer(withSource, { type: "set-tag", tag: "security" });
  assertEquals(toUrl(next), "/api/articles?tag=security&source=example.com");
});
