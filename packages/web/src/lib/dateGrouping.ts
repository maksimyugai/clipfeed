// Buckets articles into Today/Yesterday/Earlier by the BROWSER's local
// calendar day (never a raw 24h/ms window — a fixed offset breaks around
// midnight and DST transitions). Comparison is done on local Y/M/D
// components only, which is what makes it DST-safe: `setDate(-1)` and
// `getFullYear`/`getMonth`/`getDate` all operate in local wall-clock time,
// so a spring-forward/fall-back day still resolves to the correct calendar
// date instead of drifting by the transition's hour.
export type DateSection = "today" | "yesterday" | "earlier";

export const DATE_SECTIONS: readonly DateSection[] = ["today", "yesterday", "earlier"];

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function bucketSection(addedAtIso: string, now: Date = new Date()): DateSection {
  const addedKey = dayKey(new Date(addedAtIso));
  if (addedKey === dayKey(now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (addedKey === dayKey(yesterday)) return "yesterday";
  return "earlier";
}

export function groupArticlesBySection<T extends { added_at: string }>(
  articles: readonly T[],
  now: Date = new Date(),
): Record<DateSection, T[]> {
  const grouped: Record<DateSection, T[]> = { today: [], yesterday: [], earlier: [] };
  for (const article of articles) {
    grouped[bucketSection(article.added_at, now)].push(article);
  }
  return grouped;
}
