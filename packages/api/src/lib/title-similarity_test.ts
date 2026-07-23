import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { normalizeTitleExact, titleSimilarity } from "./title-similarity.ts";

// --- titleSimilarity: identical / paraphrased (en, ru/en cross-language) /
// unrelated title pairs — the exact live incident (Task 19) was two outlets
// covering the same Kimi/Moonshot story under different URLs and different
// wording. Consolidated here from ranking_test.ts (Task 24) so both
// ranking.ts's post-pick story dedup and agent-pool.ts's pre-scrape pool
// dedup are tested against the one shared implementation. ---

Deno.test("titleSimilarity: identical titles score 1.0", () => {
  const title = "Moonshot AI releases Kimi K2 model with major reasoning gains";
  assertEquals(titleSimilarity(title, title), 1);
});

Deno.test("titleSimilarity: an English paraphrase of the same story scores well above the 0.5 threshold", () => {
  const a = "Moonshot AI releases new Kimi K2 model with major reasoning gains";
  const b = "Kimi K2, the new Moonshot AI model, brings major reasoning gains";
  assertEquals(titleSimilarity(a, b) >= 0.5, true);
});

Deno.test("titleSimilarity: a ru/en cross-language pair covering the same story meets the threshold", () => {
  // The exact live-incident shape: an English outlet and a Russian-language
  // one covering the identical Moonshot/Kimi K2 story.
  const en = "Moonshot AI launches Kimi K2 model";
  const ru = "Moonshot AI выпустила модель Kimi K2";
  assertEquals(titleSimilarity(en, ru) >= 0.5, true);
});

Deno.test("titleSimilarity: unrelated titles score 0", () => {
  const a = "NVIDIA announces new RTX 5090 graphics card";
  const b = "Linux kernel 6.9 released with new scheduler";
  assertEquals(titleSimilarity(a, b), 0);
});

Deno.test("titleSimilarity: unrelated titles with no shared vocabulary at all score 0, not just low", () => {
  const a = "Company raises prices for cloud storage subscribers";
  const b = "Astronomers discover new exoplanet orbiting distant star";
  assertEquals(titleSimilarity(a, b), 0);
});

Deno.test("titleSimilarity: empty or all-stopword titles never divide by zero", () => {
  assertEquals(titleSimilarity("", "anything"), 0);
  assertEquals(titleSimilarity("a an the of to", "in on for with"), 0);
});

// --- normalizeTitleExact: used for hard-duplicate decisions (pool-stage
// identical-title dedup, manual/extension/telegram similar-title 409) where
// a fuzzy Jaccard match would be too aggressive. ---

Deno.test("normalizeTitleExact: identical titles normalize identically", () => {
  const title = "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel";
  assertEquals(normalizeTitleExact(title), normalizeTitleExact(title));
});

Deno.test("normalizeTitleExact: punctuation and emoji differences collapse to the same form", () => {
  const a = "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel!";
  const b = "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel 🚀🔥";
  assertEquals(normalizeTitleExact(a), normalizeTitleExact(b));
});

Deno.test("normalizeTitleExact: extra/irregular whitespace collapses to single spaces", () => {
  const a = "AMD  Prepares   Zen 6\tPerf Profiling";
  const b = "AMD Prepares Zen 6 Perf Profiling";
  assertEquals(normalizeTitleExact(a), normalizeTitleExact(b));
});

Deno.test("normalizeTitleExact: case differences collapse to the same form", () => {
  const a = "AMD PREPARES ZEN 6 PERF PROFILING";
  const b = "amd prepares zen 6 perf profiling";
  assertEquals(normalizeTitleExact(a), normalizeTitleExact(b));
});

Deno.test("normalizeTitleExact: a paraphrase (different wording, same story) does NOT normalize identically", () => {
  // This is the documented honest limitation (Task 24 Part B point 5): exact
  // normalization only catches literal duplicates, not paraphrases — that's
  // titleSimilarity's job (fuzzy) vs this function's job (exact).
  const a = "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel";
  const b = "Linux Kernel Gets New Zen 6 Performance Profiling Support";
  assertEquals(normalizeTitleExact(a) === normalizeTitleExact(b), false);
});

Deno.test("normalizeTitleExact: unrelated titles do not normalize identically", () => {
  const a = "NVIDIA announces new RTX 5090 graphics card";
  const b = "Astronomers discover new exoplanet orbiting distant star";
  assertEquals(normalizeTitleExact(a) === normalizeTitleExact(b), false);
});
