import type { DateSection } from "./dateGrouping.ts";

// Only sections the user has EXPLICITLY toggled are present here — a
// missing key means "no explicit choice yet", not "closed". This
// distinction is what lets a context-dependent default (Task 24 Part D's
// Today-empty auto-open for Yesterday) apply exactly once and then get out
// of the way permanently once the user makes their own choice, instead of
// silently re-overriding it on every subsequent render (see Task 26 Part 0
// — that re-override was the bug: Yesterday couldn't stay closed while
// Today stayed empty). Same localStorage key as Task 21; the stored shape
// is still a plain object, just with optional rather than required keys.
export type SectionOpenState = Partial<Record<DateSection, boolean>>;

const SECTIONS_STORAGE_KEY = "clipfeed-sections";

const SECTION_KEYS = ["today", "yesterday", "earlier"] as const;

function isSectionOpenState(value: unknown): value is SectionOpenState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return SECTION_KEYS.every((k) => v[k] === undefined || typeof v[k] === "boolean");
}

export function readStoredSectionState(storage: Pick<Storage, "getItem">): SectionOpenState {
  const raw = storage.getItem(SECTIONS_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isSectionOpenState(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredSectionState(
  storage: Pick<Storage, "setItem">,
  state: SectionOpenState,
): void {
  storage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(state));
}

// The non-user-set default for a section. Only "yesterday" is
// context-dependent (Task 24 Part D): while Today has zero articles,
// Yesterday defaults open so a visitor doesn't land on an empty Today with
// everything else collapsed too. This is ONLY the default, applied when the
// user hasn't made an explicit choice for the section — see
// isSectionOpenTodayEmptyAware for how that choice, once made, overrides it.
export function defaultSectionOpen(section: DateSection, todayIsEmpty: boolean): boolean {
  if (section === "today") return true;
  if (section === "yesterday") return todayIsEmpty;
  return false;
}

// Effective open/closed state for a section that's already known to be
// worth rendering (whether or not to render it at all — e.g. hiding a
// truly-empty section — is Feed.tsx's call, decoupled from this). While a
// search query is active the user is hunting, not browsing, so every
// visible section auto-expands regardless of its persisted/default state.
export function isSectionOpen(
  section: DateSection,
  state: SectionOpenState,
  isSearching: boolean,
): boolean {
  if (isSearching) return true;
  const userSet = state[section];
  return userSet !== undefined ? userSet : defaultSectionOpen(section, false);
}

// Task 24 Part D + Task 26 Part 0 fix: a section's effective state is the
// user's explicit choice if one exists, else the (possibly Today-empty-
// aware) computed default. Once the user toggles a section — in EITHER
// direction — `state[section]` becomes defined and this stops recomputing
// the default for it, permanently, even across many later renders/reloads
// while Today stays empty. Previously the override applied unconditionally
// whenever Today was empty, which silently re-opened Yesterday right after
// the user had just clicked to collapse it — see App.tsx's
// handleToggleSection for the matching fix on the write side (the toggle
// must flip the same effective value this function computes, not the raw
// stored value, or the user's very first click inverts their intent).
export function isSectionOpenTodayEmptyAware(
  section: DateSection,
  state: SectionOpenState,
  isSearching: boolean,
  todayIsEmpty: boolean,
): boolean {
  if (isSearching) return true;
  const userSet = state[section];
  return userSet !== undefined ? userSet : defaultSectionOpen(section, todayIsEmpty);
}
