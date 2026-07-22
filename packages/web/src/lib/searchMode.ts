// Keyword = today's title/summary LIKE search (default, GET /api/articles?q=);
// semantic = "ask your feed" over stored embeddings (GET /api/search) — see
// README "Semantic dedup & search". Same localStorage-persisted-choice
// pattern as theme.ts.
export type SearchMode = "keyword" | "semantic";

const SEARCH_MODE_STORAGE_KEY = "clipfeed-search-mode";
const DEFAULT_SEARCH_MODE: SearchMode = "keyword";

export function isSearchMode(value: string | null): value is SearchMode {
  return value === "keyword" || value === "semantic";
}

export function readStoredSearchMode(storage: Pick<Storage, "getItem">): SearchMode {
  const stored = storage.getItem(SEARCH_MODE_STORAGE_KEY);
  return isSearchMode(stored) ? stored : DEFAULT_SEARCH_MODE;
}

export function writeStoredSearchMode(
  storage: Pick<Storage, "setItem">,
  mode: SearchMode,
): void {
  storage.setItem(SEARCH_MODE_STORAGE_KEY, mode);
}
