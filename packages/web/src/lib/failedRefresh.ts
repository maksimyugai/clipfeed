import type { ArticleListItem } from "@clipfeed/shared/types";

// Only 'failed' rows are worth refetching on a visibility/focus event — a
// card in every other status is either not stale-prone (ready/archived) or
// already actively polling on its own (pending, see usePendingPoll in
// ArticleCard.tsx). Scoping to just the currently-visible failed ids also
// bounds the refetch cost to what's on screen, not the whole feed. Pure so
// the focus-triggered refresh path (App.tsx) is testable without DOM/fetch.
export function pickFailedIds(articles: readonly ArticleListItem[]): string[] {
  return articles.filter((a) => a.status === "failed").map((a) => a.id);
}

// Merges a batch of individually-refetched rows back into the full list —
// a rejected fetch for one id (network blip, the article got deleted in the
// meantime) leaves that row exactly as it was, never removed or blanked;
// only fulfilled results actually replace anything. `ids[i]` corresponds
// positionally to `results[i]` (both come from the same
// `Promise.allSettled(ids.map(...))` call).
export function mergeRefreshedArticles(
  current: readonly ArticleListItem[],
  ids: readonly string[],
  results: readonly PromiseSettledResult<ArticleListItem>[],
): ArticleListItem[] {
  const byId = new Map<string, ArticleListItem>();
  results.forEach((result, i) => {
    if (result.status === "fulfilled") byId.set(ids[i], result.value);
  });
  if (byId.size === 0) return current as ArticleListItem[];
  return current.map((a) => byId.get(a.id) ?? a);
}
