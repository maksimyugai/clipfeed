import { assertEquals } from "@std/assert";
import { isShowingSemanticFallback, shouldRunSemanticFallback } from "./searchFallback.ts";

function baseInput() {
  return {
    searchMode: "keyword" as const,
    query: "кабели",
    initialLoadDone: true,
    resultCount: 0,
    alreadyAttemptedQuery: null as string | null,
  };
}

Deno.test("shouldRunSemanticFallback: fires when keyword search is empty, loaded, not yet attempted", () => {
  assertEquals(shouldRunSemanticFallback(baseInput()), true);
});

Deno.test("shouldRunSemanticFallback: does not fire in semantic mode", () => {
  assertEquals(shouldRunSemanticFallback({ ...baseInput(), searchMode: "semantic" }), false);
});

Deno.test("shouldRunSemanticFallback: does not fire for an empty/whitespace-only query", () => {
  assertEquals(shouldRunSemanticFallback({ ...baseInput(), query: "" }), false);
  assertEquals(shouldRunSemanticFallback({ ...baseInput(), query: "   " }), false);
});

Deno.test("shouldRunSemanticFallback: does not fire before the initial keyword load has settled", () => {
  assertEquals(shouldRunSemanticFallback({ ...baseInput(), initialLoadDone: false }), false);
});

Deno.test("shouldRunSemanticFallback: does not fire when keyword search already found results", () => {
  assertEquals(shouldRunSemanticFallback({ ...baseInput(), resultCount: 3 }), false);
});

Deno.test("shouldRunSemanticFallback: does not re-fire for a query it already ran for (at most once per query)", () => {
  assertEquals(
    shouldRunSemanticFallback({ ...baseInput(), alreadyAttemptedQuery: "кабели" }),
    false,
  );
});

Deno.test("shouldRunSemanticFallback: DOES fire for a genuinely different query, even if another was already attempted", () => {
  assertEquals(
    shouldRunSemanticFallback({ ...baseInput(), alreadyAttemptedQuery: "статья" }),
    true,
  );
});

Deno.test("shouldRunSemanticFallback: comparison is against the trimmed query", () => {
  assertEquals(
    shouldRunSemanticFallback({
      ...baseInput(),
      query: "  кабели  ",
      alreadyAttemptedQuery: "кабели",
    }),
    false,
  );
});

// --- isShowingSemanticFallback ---

Deno.test("isShowingSemanticFallback: true when in semantic mode with a matching fallbackQuery", () => {
  assertEquals(isShowingSemanticFallback("semantic", "кабели", "кабели"), true);
});

Deno.test("isShowingSemanticFallback: false when fallbackQuery is null (semantic reached manually, not via fallback)", () => {
  assertEquals(isShowingSemanticFallback("semantic", "кабели", null), false);
});

Deno.test("isShowingSemanticFallback: false in keyword mode even if a fallbackQuery is set", () => {
  assertEquals(isShowingSemanticFallback("keyword", "кабели", "кабели"), false);
});

Deno.test("isShowingSemanticFallback: false once the query has moved on from the fallback's query", () => {
  assertEquals(isShowingSemanticFallback("semantic", "другой запрос", "кабели"), false);
});

Deno.test("isShowingSemanticFallback: comparison trims the current query", () => {
  assertEquals(isShowingSemanticFallback("semantic", "  кабели  ", "кабели"), true);
});
