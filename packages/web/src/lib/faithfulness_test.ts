import { assertEquals } from "@std/assert";
import { faithfulnessBadgeInfo, faithfulnessCounts } from "./faithfulness.ts";
import { dictionaries } from "../i18n.ts";

Deno.test("faithfulnessCounts: null json (disabled/not run/visitor mode) -> null", () => {
  assertEquals(faithfulnessCounts(null), null);
});

Deno.test("faithfulnessCounts: error shape (judge unparseable) -> null", () => {
  assertEquals(faithfulnessCounts({ error: "judge unparseable" }), null);
});

Deno.test("faithfulnessCounts: counts unsupported/contradicted claims, ignoring supported ones", () => {
  const counts = faithfulnessCounts({
    claims: [
      { i: 1, verdict: "supported", evidence: "" },
      { i: 2, verdict: "unsupported", evidence: "" },
      { i: 3, verdict: "unsupported", evidence: "" },
      { i: 4, verdict: "contradicted", evidence: "" },
    ],
    notes: "",
  });
  assertEquals(counts, { unsupported: 2, contradicted: 1 });
});

Deno.test("faithfulnessCounts: all-supported claims -> zero counts, not null", () => {
  const counts = faithfulnessCounts({
    claims: [{ i: 1, verdict: "supported", evidence: "" }],
    notes: "",
  });
  assertEquals(counts, { unsupported: 0, contradicted: 0 });
});

// --- faithfulnessBadgeInfo (Task 34 Part B): the badge/tooltip only ever ---
// --- appear for 'weak'/'fail' — this is what ArticleCard.tsx's badge row ---
// --- render condition ultimately depends on. ---

Deno.test("faithfulnessBadgeInfo: 'pass' verdict -> no badge/tooltip at all", () => {
  assertEquals(faithfulnessBadgeInfo(dictionaries.ru, "pass"), null);
});

Deno.test("faithfulnessBadgeInfo: null verdict (disabled/not run) -> no badge/tooltip at all", () => {
  assertEquals(faithfulnessBadgeInfo(dictionaries.ru, null), null);
});

Deno.test("faithfulnessBadgeInfo: 'weak' verdict -> the weak badge text and a tooltip ending in the shared trailer", () => {
  const info = faithfulnessBadgeInfo(dictionaries.ru, "weak");
  assertEquals(info?.badgeText, dictionaries.ru.faithfulnessBadgeWeak);
  assertEquals(info?.tooltipText.startsWith(dictionaries.ru.faithfulnessTooltipWeak), true);
  assertEquals(info?.tooltipText.endsWith(dictionaries.ru.faithfulnessTooltipTrailer), true);
});

Deno.test("faithfulnessBadgeInfo: 'fail' verdict -> the fail badge text and a tooltip ending in the shared trailer", () => {
  const info = faithfulnessBadgeInfo(dictionaries.en, "fail");
  assertEquals(info?.badgeText, dictionaries.en.faithfulnessBadgeFail);
  assertEquals(info?.tooltipText.startsWith(dictionaries.en.faithfulnessTooltipFail), true);
  assertEquals(info?.tooltipText.endsWith(dictionaries.en.faithfulnessTooltipTrailer), true);
});

Deno.test("faithfulnessBadgeInfo: 'weak' and 'fail' use DIFFERENT tooltip copy, both languages", () => {
  for (const dict of [dictionaries.ru, dictionaries.en]) {
    const weak = faithfulnessBadgeInfo(dict, "weak");
    const fail = faithfulnessBadgeInfo(dict, "fail");
    assertEquals(weak?.tooltipText === fail?.tooltipText, false);
    assertEquals(weak?.badgeText === fail?.badgeText, false);
  }
});
