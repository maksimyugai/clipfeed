// Pure filter-state reducer for the feed's tag/source/search filters — kept
// separate from App.tsx so the clear-all / toggle-off / chip-dismiss
// combinations are unit-testable without mounting the component tree.
export interface FilterState {
  tag: string | null;
  source: string | null;
  query: string;
}

export const EMPTY_FILTER_STATE: Readonly<FilterState> = { tag: null, source: null, query: "" };

export type FilterAction =
  | { type: "set-tag"; tag: string | null }
  | { type: "set-source"; source: string | null }
  | { type: "set-query"; query: string }
  | { type: "clear-all" };

// "set-tag"/"set-source" with null covers both toggle-off (a caller
// re-clicking the already-active pill computes null itself, same as the
// pre-existing Sidebar/SourcePills toggle behavior) and a chip's dismiss
// ("✕") button, which always passes null regardless of the current value.
// "clear-all" is distinct from clearing each field individually: it's the
// "все"/"all" pill, which resets the whole filter set — tag, source, AND
// the search query — in one action, unlike toggling a single pill off.
export function filterReducer(state: FilterState, action: FilterAction): FilterState {
  switch (action.type) {
    case "set-tag":
      return { ...state, tag: action.tag };
    case "set-source":
      return { ...state, source: action.source };
    case "set-query":
      return { ...state, query: action.query };
    case "clear-all":
      return { ...EMPTY_FILTER_STATE };
  }
}

export function hasActiveFilters(state: Pick<FilterState, "tag" | "source">): boolean {
  return state.tag !== null || state.source !== null;
}
