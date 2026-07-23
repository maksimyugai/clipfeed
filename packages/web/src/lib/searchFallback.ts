import type { SearchMode } from "./searchMode.ts";

// Task 43 Part 3: when a KEYWORD search comes back empty, we run the same
// query once in SEMANTIC mode in the background and — only if THAT finds
// something — flip the visible mode and show the hits under a distinct
// heading (see Feed.tsx). Pulled out as pure functions so the "when do we
// fire, at most once per query" decision is unit-testable without mounting
// the SPA's effects.

export interface SearchFallbackDecisionInput {
  searchMode: SearchMode;
  query: string;
  initialLoadDone: boolean;
  resultCount: number;
  // The most recent query the fallback has already been attempted for
  // (or null if never attempted yet this session) — comparing against the
  // CURRENT trimmed query is what makes this "at most once per query"
  // rather than "at most once ever": a genuinely different query is free
  // to trigger its own fallback attempt.
  alreadyAttemptedQuery: string | null;
}

export function shouldRunSemanticFallback(input: SearchFallbackDecisionInput): boolean {
  const trimmed = input.query.trim();
  if (input.searchMode !== "keyword") return false;
  if (trimmed === "") return false;
  if (!input.initialLoadDone) return false;
  if (input.resultCount > 0) return false;
  if (input.alreadyAttemptedQuery === trimmed) return false;
  return true;
}

// Whether the currently-displayed results should be labeled as a semantic
// fallback (drives the "no keyword matches — here's what's similar by
// meaning" heading in Feed.tsx) — true only while the mode has been
// auto-flipped to semantic BY THE FALLBACK and the query hasn't changed
// since. A user who manually switches to semantic mode themselves (not via
// the fallback) never sees this heading, since fallbackQuery stays null in
// that case.
export function isShowingSemanticFallback(
  searchMode: SearchMode,
  query: string,
  fallbackQuery: string | null,
): boolean {
  return searchMode === "semantic" && fallbackQuery !== null && query.trim() === fallbackQuery;
}
