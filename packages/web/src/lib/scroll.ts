// Scrolls a just-expanded card's title near the top of the viewport.
// Native `scrollIntoView({ block: "start" })` can't take a pixel offset, so
// this measures the title's position directly and uses `window.scrollTo`
// instead — that's what lets it account for the header height (only when
// the header is actually sticky/fixed — a static header scrolls away with
// the page, so it needs no offset) plus a small fixed breathing-room gap.
const BASE_OFFSET_PX = 12;

export function computeScrollOffset(headerEl: Element | null): number {
  if (!headerEl) return BASE_OFFSET_PX;
  const position = getComputedStyle(headerEl).position;
  const isStickyOrFixed = position === "sticky" || position === "fixed";
  return (isStickyOrFixed ? (headerEl as HTMLElement).offsetHeight : 0) + BASE_OFFSET_PX;
}

// Generalized from the title-scroll case below — any element that should
// land just under the (possibly sticky) app header, e.g. the "read
// yesterday" link's scroll target when Today's section is empty (see
// Feed.tsx).
export function scrollElementIntoView(el: HTMLElement | null): void {
  if (!el) return;
  const offset = computeScrollOffset(document.querySelector(".app-header"));
  const top = el.getBoundingClientRect().top + globalThis.scrollY - offset;
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
    false;
  globalThis.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
}

export function scrollTitleIntoView(titleEl: HTMLElement | null): void {
  scrollElementIntoView(titleEl);
}
