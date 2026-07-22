// Task 31 Part 5: floating "back to top" button, shown once the visitor has
// scrolled past roughly one viewport's worth of content — chosen as a fixed
// 600px rather than measuring innerHeight, since a fixed threshold is
// simpler to reason about/test and close enough to "one screen" on both
// desktop and mobile viewports this app targets.
export const SCROLL_TOP_VISIBLE_THRESHOLD_PX = 600;

export function isScrollToTopVisible(scrollY: number): boolean {
  return scrollY > SCROLL_TOP_VISIBLE_THRESHOLD_PX;
}

// Pure decision, kept separate from the actual `window.scrollTo` call so it
// can be tested without a DOM — see usePrefersReducedMotion (motion.ts) for
// where the boolean comes from.
export function scrollToTopBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}
