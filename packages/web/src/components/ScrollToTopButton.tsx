import { useEffect, useRef, useState } from "preact/hooks";
import type { Dictionary } from "../i18n.ts";
import { usePrefersReducedMotion } from "../lib/motion.ts";
import { isScrollToTopVisible, scrollToTopBehavior } from "../lib/scrollToTop.ts";

export interface ScrollToTopButtonProps {
  dict: Dictionary;
}

// Floating "back to top" button — appears once the feed has scrolled past
// isScrollToTopVisible's threshold, fades out again near the top. The
// scroll listener is rAF-throttled (a `ticking` flag skips redundant
// requestAnimationFrame calls while one is already pending) rather than
// debounced/sampled on a timer, so visibility tracks the actual scroll
// position at a natural per-frame rate without flooding setState calls on
// a fast trackpad fling.
export function ScrollToTopButton({ dict }: ScrollToTopButtonProps) {
  const [visible, setVisible] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const ticking = useRef(false);

  useEffect(() => {
    const updateVisibility = () => {
      setVisible(isScrollToTopVisible(globalThis.scrollY));
      ticking.current = false;
    };
    const onScroll = () => {
      if (ticking.current) return;
      ticking.current = true;
      globalThis.requestAnimationFrame(updateVisibility);
    };
    onScroll();
    globalThis.addEventListener("scroll", onScroll, { passive: true });
    return () => globalThis.removeEventListener("scroll", onScroll);
  }, []);

  const handleClick = () => {
    globalThis.scrollTo({ top: 0, behavior: scrollToTopBehavior(reducedMotion) });
  };

  return (
    <button
      type="button"
      class="scroll-to-top"
      data-visible={visible}
      aria-label={dict.scrollToTopAria}
      title={dict.scrollToTopAria}
      onClick={handleClick}
      aria-hidden={!visible}
      inert={!visible}
      tabIndex={visible ? 0 : -1}
    >
      ↑
    </button>
  );
}
