import { assertEquals } from "@std/assert";
import { isArticleInList, parseArticleHash } from "./deepLink.ts";

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

Deno.test("isArticleInList: true when the id is present", () => {
  assertEquals(isArticleInList("b", [{ id: "a" }, { id: "b" }, { id: "c" }]), true);
});

Deno.test("isArticleInList: false when the id is absent, including an empty list", () => {
  assertEquals(isArticleInList("z", [{ id: "a" }, { id: "b" }]), false);
  assertEquals(isArticleInList("z", []), false);
});
