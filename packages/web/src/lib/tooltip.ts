// Pure open/close decision for the Tooltip component (Tooltip.tsx) — kept
// separate from the DOM-event wiring, same "pure logic + thin hook"
// convention as pollSchedule.ts/sectionState.ts elsewhere in this codebase,
// so the actual open/close DECISION is unit-testable without a real DOM.
//
// Desktop (a hover-capable pointer): hover and keyboard focus both open it,
// leaving either closes it. Touch (`isTouch`): hover events either don't
// fire or aren't meaningful, so pointer-enter/leave are no-ops there — a
// tap (dispatched as the same "toggle" event a click produces) is the only
// way to open/close it, and it dismisses on outside-tap/Escape (handled by
// the component via a "dismiss" event, not through this table).
export type TooltipEvent =
  | "pointer-enter"
  | "pointer-leave"
  | "focus"
  | "blur"
  | "toggle"
  | "dismiss";

export function nextTooltipOpen(open: boolean, event: TooltipEvent, isTouch: boolean): boolean {
  switch (event) {
    case "pointer-enter":
      return isTouch ? open : true;
    case "pointer-leave":
      return isTouch ? open : false;
    case "focus":
      return true;
    case "blur":
      return false;
    case "toggle":
      return isTouch ? !open : open;
    case "dismiss":
      return false;
    default:
      return open;
  }
}
