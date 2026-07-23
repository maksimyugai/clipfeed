import { assert, assertEquals } from "@std/assert";
import { extractArticle } from "./extract.ts";

Deno.test("extractArticle: strips comments, style, and svg blocks from extracted text", () => {
  const html = `<html><body><article><h1>Title</h1><!-- a comment -->
    <style>.foo { color: red; }</style>
    <svg><text>svg text should not appear</text></svg>
    <p>Real paragraph content here for the article body, long enough to matter.</p>
  </article></body></html>`;

  const result = extractArticle(html);

  assertEquals(result.textContent.includes("svg text should not appear"), false);
  assertEquals(result.textContent.includes("color: red"), false);
  assertEquals(result.textContent.includes("a comment"), false);
  assert(result.textContent.includes("Real paragraph content"));
});

Deno.test("extractArticle: strips a huge <script> block BEFORE capping, so it can't push real content past HTML_PARSE_CAP", () => {
  // Without strip-before-cap ordering, this 3MB script (which alone exceeds
  // the 1.5MB cap) would push the article content entirely past the parse
  // boundary, leaving nothing to extract.
  const junkScript = `<script>${"x".repeat(3_000_000)}</script>`;
  const html = `<html><head><title>Real Title</title></head><body>${junkScript}<article><p>${
    "Real article content. ".repeat(50)
  }</p></article></body></html>`;

  const result = extractArticle(html);

  assertEquals(result.title, "Real Title");
  assert(result.textContent.includes("Real article content"));
});

Deno.test("extractArticle: caps parser input at HTML_PARSE_CAP bytes even for legitimately large non-script content", () => {
  // 2MB of plain filler (no noise tags to strip) — still over the 1.5MB cap,
  // so a <title> placed after it must be truncated away and never reach the
  // parser at all.
  const filler = "y".repeat(2_000_000);
  const html =
    `<html><body><article><p>${filler}</p></article><title>Should Not Survive</title></body></html>`;

  const result = extractArticle(html, "Fallback Title");

  assertEquals(result.title, "Fallback Title");
});
