import type { ArticleListItem } from "@clipfeed/shared/types";
import { FAST_INTERVAL_MS, FAST_PHASE_MS, SLOW_INTERVAL_MS } from "./pollSchedule.ts";

// Task 41 Part A: replaces N independent per-card polls (one GET per pending
// article, every 4s) with a single feed-level poll that refreshes every
// pending card from one shared snapshot. This predicate is the "is there
// anything to poll for at all" gate — the timer in App.tsx only runs while
// it's true, and stops the instant it's false.
export function hasPendingArticles(articles: readonly Pick<ArticleListItem, "status">[]): boolean {
  return articles.some((a) => a.status === "pending");
}

// Same fast-then-slow cadence as the old per-card poll (lib/pollSchedule.ts's
// nextPollDelayMs), but never gives up — there is no per-poll "stuck" state
// at the feed level (each card still derives its own "given up" display from
// how long ITS OWN pending episode has run, see ArticleCard.tsx). The feed
// poll's only stop condition is hasPendingArticles going false.
export function feedPollDelayMs(elapsedMs: number): number {
  return elapsedMs < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

// Refreshes every currently-pending card from a fresh list snapshot, by id.
// Deliberately narrow: only touches rows that are BOTH already in `current`
// AND still pending — never inserts a row `current` doesn't have (that would
// be an unrequested page/filter change sneaking in) and never overwrites a
// row that already resolved locally (e.g. via a manual "Check now" that beat
// this tick to the punch).
export function applyFeedPollSnapshot(
  current: readonly ArticleListItem[],
  snapshot: readonly ArticleListItem[],
): ArticleListItem[] {
  const bySnapshotId = new Map(snapshot.map((a) => [a.id, a] as const));
  return current.map((a) => {
    if (a.status !== "pending") return a;
    const fresh = bySnapshotId.get(a.id);
    return fresh ? { ...a, ...fresh } : a;
  });
}
