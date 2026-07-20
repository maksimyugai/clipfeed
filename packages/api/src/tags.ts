// Normalizes LLM-produced and manually/agent-seeded tags into one
// consistent vocabulary — see summarize.ts's TAGS prompt rule for the
// upstream half of this fix (asks the model for lowercase, Latin-script,
// broad-category tags in the first place). This is the belt: whatever
// actually comes back (older rows, a model that ignores the rule, a
// telegram/agent seed tag) still gets normalized before it's ever
// persisted, so the sidebar's tag list can't keep accumulating one-off
// transliterations and language-duplicated near-duplicates of the same
// concept.
//
// Extend this map as new recurring duplicates/transliterations show up in
// practice — it's deliberately a flat, hand-maintained table, not an NLP
// model. A value of `null` means "drop this tag" (a meta-tag that isn't a
// real topic, e.g. a leaked internal/error term).
const TAG_SYNONYMS: Record<string, string | null> = {
  "искусственный интеллект": "ai",
  "ии": "ai",
  "programmirovanie": "programming",
  "программирование": "programming",
  "обучение": "education",
  "obuchenie": "education",
  "космос": "space",
  "право": "law",
  "музыка": "music",
  "безопасность": "security",
  "конкуренция": "business",
  "энергетика": "energy",
  "индия": "india",
  "китай": "china",
  "таймаут": null,
};

// Lowercase + trim every tag, apply the synonym map (dropping entries that
// map to null), then dedupe while preserving first-seen order. Unknown
// non-Latin tags are kept as-is (just lowercased) rather than discarded —
// this is a normalization pass, not a whitelist, so it doesn't destroy
// information about topics the map doesn't know about yet.
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const trimmedLower = raw.trim().toLowerCase();
    if (trimmedLower.length === 0) continue;

    const mapped = trimmedLower in TAG_SYNONYMS ? TAG_SYNONYMS[trimmedLower] : trimmedLower;
    if (mapped === null) continue;
    if (seen.has(mapped)) continue;

    seen.add(mapped);
    result.push(mapped);
  }

  return result;
}
