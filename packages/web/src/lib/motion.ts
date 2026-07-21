import { useEffect, useState } from "preact/hooks";

// Pure — given whether the visitor prefers reduced motion, decides whether
// an optional animation class name should be appended to a base class.
// Used by the pending->ready slide/fade-in transition (ArticleCard.tsx) and
// could be reused anywhere else a purely-decorative animation needs the
// same on/off decision. When reduced, only `baseClass` is returned — the
// element still gets its final state instantly, just without the motion.
export function withMotionClass(
  baseClass: string,
  motionClass: string,
  reducedMotion: boolean,
): string {
  return reducedMotion ? baseClass : `${baseClass} ${motionClass}`.trim();
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// Live system-preference read, same shape as theme.ts's useTheme reading
// prefers-color-scheme — reacts to the user toggling the OS setting while
// the tab is open, not just at initial load.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia(REDUCED_MOTION_QUERY).matches);

  useEffect(() => {
    const mql = matchMedia(REDUCED_MOTION_QUERY);
    const handler = () => setReduced(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}
