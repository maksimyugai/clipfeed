// Shared title-comparison utilities. Originally written for the ranking
// module's post-pick story dedup (Task 19 — two picks covering the same
// Kimi/Moonshot story from different outlets under different URLs, so the
// URL-based dedupe in agent-pool.ts never saw the collision) and
// consolidated here (Task 24) so the scraper agent's pre-scrape pool dedup
// can reuse the exact same similarity function instead of a second,
// independently-drifting copy — one comparison function, used at both the
// pool stage (before any LLM spend) and the post-pick stage (after ranking,
// as a final backstop).

// Deliberately small and manual, not a stemmer/stopword-library dependency —
// this only needs to strip the highest-frequency function words that would
// otherwise inflate the token overlap between two otherwise-unrelated
// headlines (e.g. "the... in... and..." matching across any two English
// titles). Covers en+ru per Task 19's live evidence (an English outlet and a
// Russian-language one covering the same story).
const STOPWORDS_EN = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "by",
  "as",
  "at",
  "it",
  "its",
  "this",
  "that",
  "from",
  "after",
  "over",
  "new",
]);
const STOPWORDS_RU = new Set([
  "и",
  "в",
  "во",
  "не",
  "что",
  "он",
  "на",
  "я",
  "с",
  "со",
  "как",
  "а",
  "то",
  "все",
  "она",
  "так",
  "его",
  "но",
  "да",
  "к",
  "у",
  "же",
  "вы",
  "за",
  "бы",
  "по",
  "только",
  "её",
  "ее",
  "для",
  "из",
  "этот",
  "эта",
  "это",
  "об",
  "от",
]);

function normalizeTitleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS_EN.has(w) && !STOPWORDS_RU.has(w));
}

// Exported for direct testing of the similarity table (identical,
// paraphrased, unrelated pairs) — normalize both titles to a stopword-free
// token set, then plain Jaccard (intersection / union). No stemming, no
// translation — a ru/en paraphrase of the same story only scores high here
// when it shares enough proper nouns/numbers/transliterated terms (which,
// per the Task 19 live incident, real paraphrases of the same story usually
// do).
export function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeTitleWords(a));
  const tokensB = new Set(normalizeTitleWords(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// A separate, stricter comparison from titleSimilarity above: an EXACT-match
// normalized form (punctuation/emoji stripped, whitespace collapsed,
// lowercased — no stopword removal, no token-set fuzziness) used where a
// hard duplicate decision is wanted rather than a similarity score — the
// scraper agent's pool-stage "identical title, different URL" layer (Task
// 24 Part B) and manual/extension/telegram adds' similar-title 409 (Task 24
// Part C), where a fuzzy Jaccard match would be too aggressive to block an
// owner's own deliberate re-add.
export function normalizeTitleExact(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
