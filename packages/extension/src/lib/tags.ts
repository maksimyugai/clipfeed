// Mirrors packages/api/src/articles/validation.ts (MAX_TAGS, MAX_TAG_CHARS) so the
// popup's tag input never produces a request the server would reject.
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 50;

// Parses a comma-separated tag input into a deduped (case-insensitive),
// trimmed, length-capped list, respecting the server's per-request limits.
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of input.split(",")) {
    if (result.length >= MAX_TAGS) break;
    const tag = raw.trim().slice(0, MAX_TAG_CHARS);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  return result;
}
