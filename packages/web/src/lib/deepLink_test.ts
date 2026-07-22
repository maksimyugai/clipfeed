import { assertEquals } from "@std/assert";
import {
  isArticleInList,
  parseArticleHash,
  parseArticlePath,
  parseDeepLinkId,
} from "./deepLink.ts";

Deno.test("parseArticleHash: extracts the id from a well-formed hash", () => {
  assertEquals(parseArticleHash("#article-abc-123"), "abc-123");
});

Deno.test("parseArticleHash: null for an empty hash", () => {
  assertEquals(parseArticleHash(""), null);
});

Deno.test("parseArticleHash: null for a hash with no id after the prefix", () => {
  assertEquals(parseArticleHash("#article-"), null);
});

Deno.test("parseArticleHash: null for an unrelated hash", () => {
  assertEquals(parseArticleHash("#foo"), null);
  assertEquals(parseArticleHash("#article"), null);
});

// --- Task 32 Part B: the new "/a/<id>" path form, plus the combined
// path-then-hash resolution used at App.tsx's initial mount ---

Deno.test("parseArticlePath: extracts the id from a well-formed path", () => {
  assertEquals(parseArticlePath("/a/abc-123"), "abc-123");
});

Deno.test("parseArticlePath: null for the root path", () => {
  assertEquals(parseArticlePath("/"), null);
});

Deno.test("parseArticlePath: null for a path with no id after the prefix", () => {
  assertEquals(parseArticlePath("/a/"), null);
});

Deno.test("parseArticlePath: null for an unrelated path", () => {
  assertEquals(parseArticlePath("/api/articles"), null);
  assertEquals(parseArticlePath("/apples"), null);
});

Deno.test("parseDeepLinkId: prefers the path form when both are present", () => {
  assertEquals(parseDeepLinkId("/a/path-id", "#article-hash-id"), "path-id");
});

Deno.test("parseDeepLinkId: falls back to the legacy hash form when there's no path match", () => {
  assertEquals(parseDeepLinkId("/", "#article-hash-id"), "hash-id");
});

Deno.test("parseDeepLinkId: null when neither form matches", () => {
  assertEquals(parseDeepLinkId("/", ""), null);
  assertEquals(parseDeepLinkId("/some/other/path", "#unrelated"), null);
});

Deno.test("isArticleInList: true when the id is present", () => {
  assertEquals(isArticleInList("b", [{ id: "a" }, { id: "b" }, { id: "c" }]), true);
});

Deno.test("isArticleInList: false when the id is absent, including an empty list", () => {
  assertEquals(isArticleInList("z", [{ id: "a" }, { id: "b" }]), false);
  assertEquals(isArticleInList("z", []), false);
});
