import { assertEquals } from "@std/assert";
import { parseTags } from "./tags.ts";

Deno.test("parseTags: splits on commas and trims whitespace", () => {
  assertEquals(parseTags(" ai ,  reading , tools "), ["ai", "reading", "tools"]);
});

Deno.test("parseTags: drops empty entries from stray commas", () => {
  assertEquals(parseTags("ai,,reading,  ,"), ["ai", "reading"]);
});

Deno.test("parseTags: returns an empty list for blank input", () => {
  assertEquals(parseTags("   "), []);
});

Deno.test("parseTags: dedupes case-insensitively, keeping the first occurrence's casing", () => {
  assertEquals(parseTags("AI, ai, Ai"), ["AI"]);
});

Deno.test("parseTags: caps at 10 tags", () => {
  const input = Array.from({ length: 15 }, (_, i) => `tag${i}`).join(",");
  assertEquals(parseTags(input).length, 10);
});

Deno.test("parseTags: truncates a tag longer than 50 chars", () => {
  const long = "a".repeat(60);
  const [tag] = parseTags(long);
  assertEquals(tag.length, 50);
});
