import type { AddedVia, ArticleStatus } from "@clipfeed/shared/types";

// Only the two fields this module actually needs — callers pass a real
// ArticleListItem, but keeping the parameter type minimal makes every
// function here trivially testable with plain literals.
export interface AgentBatchItem {
  added_via: AddedVia;
  status: ArticleStatus;
}

export function isAgentBatchPending(item: AgentBatchItem): boolean {
  return item.added_via === "agent" && item.status === "pending";
}

export type PendingCardVariant = "hidden" | "skeleton";

// Task 25's added_via routing rule, made directly testable rather than left
// as an inline branch inside ArticleCard.tsx: an agent-added pending
// article renders nothing on its own (represented instead by the aggregate
// indicator); every other added_via ('manual' | 'extension' | 'telegram')
// — an owner deliberately adding something — gets the skeleton card. Only
// meaningful for a 'pending' article; callers only reach this branch after
// already checking `status === 'pending'`.
export function pendingCardVariant(item: Pick<AgentBatchItem, "added_via">): PendingCardVariant {
  return item.added_via === "agent" ? "hidden" : "skeleton";
}

// Task 40 Part C: which of the three indicator phrasings applies for a given
// (ready, total) pair, independent of `visible` (which already hides the
// indicator entirely once ready >= total — see Feed.tsx) so the phrasing
// choice itself is directly testable across all three states, including the
// one the mounted component never actually sees.
export type AgentBatchPhrase = "preparing" | "partial" | "done";

export function agentBatchPhrase(ready: number, total: number): AgentBatchPhrase {
  if (ready >= total) return "done";
  if (ready === 0) return "preparing";
  return "partial";
}

export interface AgentBatchState {
  // True while ANY agent-added article in the section is still 'pending' —
  // this is the section's "a batch is actively in flight" signal, driving
  // both whether the indicator renders at all and the Task 24 countdown
  // precedence below. A failed agent-pending article is neither 'pending'
  // nor 'ready' by the time this runs, so it's excluded from both `ready`
  // and `visible` automatically — it was never "coming" in the first
  // place, matching the task's own instruction.
  visible: boolean;
  ready: number; // M
  total: number; // N = M + still-pending
}

// See Task 25 Part A: shown while any agent-added article in a section is
// still pending, summarizing progress instead of rendering each one as an
// individual card (agent-pending cards are hidden — see ArticleCard.tsx).
// Ready agent articles are NOT hidden — they render normally in the list
// AND are counted here as `ready`, so the indicator and the real cards
// coexist without contradicting each other.
export function computeAgentBatchIndicator(items: readonly AgentBatchItem[]): AgentBatchState {
  let ready = 0;
  let pending = 0;
  for (const item of items) {
    if (item.added_via !== "agent") continue;
    if (item.status === "ready") ready += 1;
    else if (item.status === "pending") pending += 1;
  }
  return { visible: pending > 0, ready, total: ready + pending };
}

// True when NOTHING in this section will render as a visible card — every
// item is either absent (empty section) or an agent-pending row (hidden,
// see ArticleCard.tsx's Part A branch). `Array.every` on an empty array is
// vacuously true, which is exactly the "genuinely empty section" case this
// also needs to cover.
export function isSectionVisiblyEmpty(items: readonly AgentBatchItem[]): boolean {
  return items.every(isAgentBatchPending);
}

// Task 24/25 interaction: the empty-Today countdown and this task's batch
// indicator both want the same space when Today has nothing VISIBLE yet.
// Precedence: once an agent batch has started (any agent-pending item
// exists), the indicator wins — "articles are actively coming" is a
// stronger, more specific signal than a timer, so the countdown must not
// show alongside or instead of it. The countdown only shows when the
// section is both visibly empty AND no agent batch is in flight (agent
// hasn't run yet, or nothing was scraped this run).
export function shouldShowEmptyCountdown(items: readonly AgentBatchItem[]): boolean {
  return isSectionVisiblyEmpty(items) && !computeAgentBatchIndicator(items).visible;
}

// Task 29 Part C: the Today countdown is only meaningful in the default,
// unfiltered view — under an active tag/source filter or search query,
// "nothing here" simply means the filter excludes everything, not that
// something is being prepared (see Feed.tsx, which hides Today like any
// other empty section once this is false). Archived view never shows it
// either way, same as before this task.
export function computeTodayIsEmpty(
  archivedView: boolean,
  isFilteredView: boolean,
  todayItems: readonly AgentBatchItem[],
): boolean {
  return !archivedView && !isFilteredView && shouldShowEmptyCountdown(todayItems);
}
