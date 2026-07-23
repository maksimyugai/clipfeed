import type { Lang } from "./i18n.ts";

export type OwnerModeState = "loading" | "owner" | "visitor";

// Classifies the outcome of GET /api/admin/me into a UI mode. A 401 (no/
// invalid Access identity, or Access not configured on the server at all)
// and any other request error both mean "visitor" — the only way to see
// owner-only UI (add/archive/delete/retry, the archive toggle) is a
// successful, authenticated response.
export function classifyMeOutcome(outcome: "pending" | "success" | "error"): OwnerModeState {
  if (outcome === "pending") return "loading";
  return outcome === "success" ? "owner" : "visitor";
}

// Owner-only UI (add/archive/delete/retry actions, the archive toggle)
// stays hidden while loading, not just while confirmed a visitor — briefly
// flashing owner controls before a 401 comes back would be worse than a
// beat of nothing.
export function canMutate(mode: OwnerModeState): boolean {
  return mode === "owner";
}

// Task 35 Part A §4: the EN toggle (Header.tsx) is owner-only — the owner
// reads Russian only, so lazy EN generation only makes sense for the one
// person who'd ever request it. A visitor always gets the Russian feed,
// regardless of whatever lang a stale localStorage value from a previous
// owner session on the same browser might carry (see i18n.ts's
// readStoredLang) — `isOwner` gates this the same way it gates every other
// owner-only control, not a separate mechanism.
export function resolveEffectiveLang(storedLang: Lang, isOwner: boolean): Lang {
  return isOwner ? storedLang : "ru";
}
