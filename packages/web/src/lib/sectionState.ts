import type { DateSection } from "./dateGrouping.ts";

// Per-section collapse state, persisted so it survives reloads — same
// read/write-pair convention as readStoredLang/writeStoredLang in i18n.ts.
export type SectionOpenState = Record<DateSection, boolean>;

export const DEFAULT_SECTION_STATE: Readonly<SectionOpenState> = {
  today: true,
  yesterday: false,
  earlier: false,
};

const SECTIONS_STORAGE_KEY = "clipfeed-sections";

function isSectionOpenState(value: unknown): value is SectionOpenState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.today === "boolean" && typeof v.yesterday === "boolean" &&
    typeof v.earlier === "boolean";
}

export function readStoredSectionState(storage: Pick<Storage, "getItem">): SectionOpenState {
  const raw = storage.getItem(SECTIONS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_SECTION_STATE };
  try {
    const parsed = JSON.parse(raw);
    return isSectionOpenState(parsed) ? parsed : { ...DEFAULT_SECTION_STATE };
  } catch {
    return { ...DEFAULT_SECTION_STATE };
  }
}

export function writeStoredSectionState(
  storage: Pick<Storage, "setItem">,
  state: SectionOpenState,
): void {
  storage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(state));
}

// Effective open/closed state for a section that's already known to be
// worth rendering (whether or not to render it at all — e.g. hiding a
// truly-empty section — is Feed.tsx's call, decoupled from this). While a
// search query is active the user is hunting, not browsing, so every
// visible section auto-expands regardless of its persisted/manually-toggled
// state.
export function isSectionOpen(
  section: DateSection,
  state: SectionOpenState,
  isSearching: boolean,
): boolean {
  return isSearching || state[section];
}

// Task 24 Part D: when Today has zero articles, Yesterday is force-opened
// for this render regardless of its persisted/manually-toggled state — a
// visitor landing on a wall of collapsed section headers with nothing in
// Today shouldn't also have to click to see Yesterday. Only "yesterday" is
// affected; every other section (including "today" itself, and "earlier")
// keeps its normal isSectionOpen behavior unchanged. The override does NOT
// persist — closing Yesterday again once Today gets an article reverts to
// whatever was actually stored.
export function isSectionOpenTodayEmptyAware(
  section: DateSection,
  state: SectionOpenState,
  isSearching: boolean,
  todayIsEmpty: boolean,
): boolean {
  if (section === "yesterday" && todayIsEmpty) return true;
  return isSectionOpen(section, state, isSearching);
}
