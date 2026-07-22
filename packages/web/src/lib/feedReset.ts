import type { SearchMode } from "./searchMode.ts";

// What the logo click resets, besides the filter reducer's own "clear-all"
// (tag/source/query) — see App.tsx's handleLogoClick. Section open/closed
// state is deliberately NOT part of this: it's the user's persisted
// preference and the logo reset must leave it alone.
export interface FeedResetState {
  searchMode: SearchMode;
  archivedView: boolean;
}

export const DEFAULT_FEED_RESET_STATE: Readonly<FeedResetState> = {
  searchMode: "keyword",
  archivedView: false,
};

// Pure so the "logo always resets to keyword mode + non-archived, regardless
// of whatever was active before" rule is unit-testable without mounting
// App.tsx.
export function computeLogoResetState(): FeedResetState {
  return { ...DEFAULT_FEED_RESET_STATE };
}
