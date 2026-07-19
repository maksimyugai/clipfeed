import { assertEquals } from "@std/assert";
import { buildHtmlPayload } from "./payload.ts";

Deno.test("buildHtmlPayload: sends full HTML when under the threshold", () => {
  const result = buildHtmlPayload("<html>small</html>", "<article>small</article>", 100, 200);
  assertEquals(result, { html: "<html>small</html>", source: "full" });
});

Deno.test("buildHtmlPayload: downgrades to readability HTML when full HTML exceeds the threshold", () => {
  const full = "x".repeat(150);
  const readability = "<article>short</article>";
  const result = buildHtmlPayload(full, readability, 100, 200);
  assertEquals(result, { html: readability, source: "readability" });
});

Deno.test("buildHtmlPayload: downgrades to none when both full and readability HTML exceed the hard cap", () => {
  const full = "x".repeat(150);
  const readability = "y".repeat(250);
  const result = buildHtmlPayload(full, readability, 100, 200);
  assertEquals(result, { html: null, source: "none" });
});

Deno.test("buildHtmlPayload: downgrades to none when there is no readability fallback", () => {
  const full = "x".repeat(150);
  const result = buildHtmlPayload(full, null, 100, 200);
  assertEquals(result, { html: null, source: "none" });
});

Deno.test("buildHtmlPayload: boundary is inclusive at exactly the threshold", () => {
  const full = "x".repeat(100);
  const result = buildHtmlPayload(full, null, 100, 200);
  assertEquals(result, { html: full, source: "full" });
});

Deno.test("buildHtmlPayload: uses byte length, not character length, for multi-byte text", () => {
  const full = "😀".repeat(30); // 4 bytes each = 120 bytes, over a 100-byte threshold
  const result = buildHtmlPayload(full, null, 100, 200);
  assertEquals(result.source, "none");
});
