import { assertEquals } from "@std/assert";
import { faithfulnessCounts } from "./faithfulness.ts";

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
