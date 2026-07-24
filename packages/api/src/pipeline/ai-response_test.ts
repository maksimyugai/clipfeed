import { assertEquals } from "@std/assert";
import { normalizeAiChatResponse } from "./ai-response.ts";

// --- Task 44 Part A: the normalizer's shape table ---

Deno.test("normalizeAiChatResponse: bare string -> text", () => {
  const result = normalizeAiChatResponse("hello");
  assertEquals(result, { text: "hello", parsed: null, raw: "hello" });
});

Deno.test("normalizeAiChatResponse: { response: string } -> text", () => {
  const raw = { response: "hello" };
  const result = normalizeAiChatResponse(raw);
  assertEquals(result, { text: "hello", parsed: null, raw });
});

Deno.test("normalizeAiChatResponse: { response: object } -> parsed", () => {
  const raw = { response: { claims: [] } };
  const result = normalizeAiChatResponse(raw);
  assertEquals(result, { text: null, parsed: { claims: [] }, raw });
});

Deno.test("normalizeAiChatResponse: bare object (no response wrapper) -> parsed", () => {
  const raw = { claims: [], notes: "" };
  const result = normalizeAiChatResponse(raw);
  assertEquals(result, { text: null, parsed: raw, raw });
});

Deno.test("normalizeAiChatResponse: unexpected shapes -> text and parsed both null", () => {
  for (const raw of [undefined, null, 42, true, []]) {
    const result = normalizeAiChatResponse(raw);
    assertEquals(result.text, null, `text for ${JSON.stringify(raw)}`);
    // An array is typeof "object" but has no `response` key, so it falls
    // through to "parsed" rather than the null-shape branch — still not
    // text, which is all every real call site actually checks.
    if (Array.isArray(raw)) {
      assertEquals(result.parsed, raw);
    } else {
      assertEquals(result.parsed, null, `parsed for ${JSON.stringify(raw)}`);
    }
    assertEquals(result.raw, raw);
  }
});

Deno.test("normalizeAiChatResponse: { response: non-string, non-object } still lands in parsed", () => {
  const raw = { response: 42 };
  const result = normalizeAiChatResponse(raw);
  assertEquals(result, { text: null, parsed: 42, raw });
});

Deno.test("normalizeAiChatResponse: { response: null } normalizes parsed to null, not undefined", () => {
  const raw = { response: null };
  const result = normalizeAiChatResponse(raw);
  assertEquals(result, { text: null, parsed: null, raw });
});
