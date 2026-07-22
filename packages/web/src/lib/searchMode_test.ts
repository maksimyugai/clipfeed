import { assertEquals } from "@std/assert";
import {
  isFlatSemanticView,
  isSearchMode,
  readStoredSearchMode,
  writeStoredSearchMode,
} from "./searchMode.ts";

function makeFakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

Deno.test("isSearchMode: accepts only 'keyword' and 'semantic'", () => {
  assertEquals(isSearchMode("keyword"), true);
  assertEquals(isSearchMode("semantic"), true);
  assertEquals(isSearchMode("fuzzy"), false);
  assertEquals(isSearchMode(null), false);
});

Deno.test("readStoredSearchMode: defaults to 'keyword' when nothing stored", () => {
  assertEquals(readStoredSearchMode(makeFakeStorage()), "keyword");
});

Deno.test("readStoredSearchMode: defaults to 'keyword' when the stored value is invalid", () => {
  assertEquals(
    readStoredSearchMode(makeFakeStorage({ "clipfeed-search-mode": "fuzzy" })),
    "keyword",
  );
});

Deno.test("writeStoredSearchMode + readStoredSearchMode round-trip", () => {
  const storage = makeFakeStorage();
  writeStoredSearchMode(storage, "semantic");
  assertEquals(readStoredSearchMode(storage), "semantic");
});

Deno.test("isFlatSemanticView: true only when actively searching in semantic mode", () => {
  assertEquals(isFlatSemanticView(true, "semantic"), true);
});

Deno.test("isFlatSemanticView: false in keyword mode, even while searching", () => {
  assertEquals(isFlatSemanticView(true, "keyword"), false);
});

Deno.test("isFlatSemanticView: false when not searching, regardless of mode", () => {
  assertEquals(isFlatSemanticView(false, "semantic"), false);
  assertEquals(isFlatSemanticView(false, "keyword"), false);
});
