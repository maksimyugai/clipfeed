import { cloneElement, type VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { nextTooltipOpen, type TooltipEvent } from "../lib/tooltip.ts";
import { usePrefersReducedMotion, withMotionClass } from "../lib/motion.ts";

export interface TooltipProps {
  text: string;
  trigger: VNode;
}

const TOUCH_QUERY = "(hover: none)";

// Live read, same pattern as motion.ts's usePrefersReducedMotion — doesn't
// need to react to changes (a device's hover capability doesn't flip mid
// session), so a plain lazy-initialized state is enough, no listener.
function useIsTouchDevice(): boolean {
  const [touch] = useState(() => matchMedia(TOUCH_QUERY).matches);
  return touch;
}

// A small, dependency-free tooltip: hover + keyboard focus on desktop, tap
// to toggle on touch (dismissed by an outside tap or Escape) — see
// nextTooltipOpen (tooltip.ts) for the exact open/close table this wires
// up. `trigger` is cloned with the accessibility attributes and event
// handlers added on top of whatever the caller already put there (e.g. the
// faithfulness badge's own classes/text stay untouched).
export function Tooltip({ text, trigger }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const isTouch = useIsTouchDevice();
  const reducedMotion = usePrefersReducedMotion();
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const dispatch = (event: TooltipEvent) =>
    setOpen((prev) => nextTooltipOpen(prev, event, isTouch));

  // Outside-tap / Escape dismiss — only wired up while actually open, same
  // "attach only when needed" convention as AddModal.tsx's Escape listener.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        dispatch("dismiss");
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch("dismiss");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const triggerProps = trigger.props as Record<string, unknown>;
  const mergedClass = [triggerProps.class, "tooltip-trigger"].filter(Boolean).join(" ");
  const triggerElement = cloneElement(trigger, {
    class: mergedClass,
    role: "button",
    tabIndex: 0,
    "aria-describedby": tooltipId,
    onMouseEnter: () => dispatch("pointer-enter"),
    onMouseLeave: () => dispatch("pointer-leave"),
    onFocus: () => dispatch("focus"),
    onBlur: () => dispatch("blur"),
    onClick: () => dispatch("toggle"),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        dispatch("toggle");
      }
    },
  });

  return (
    <span class="tooltip-wrapper" ref={wrapperRef}>
      {triggerElement}
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          class={withMotionClass("tooltip-popover", "tooltip-popover--animated", reducedMotion)}
        >
          {text}
        </span>
      )}
    </span>
  );
}
