import { assertEquals } from "@std/assert";
import { nextTooltipOpen } from "./tooltip.ts";

// --- Desktop (isTouch = false): hover and focus both open it, leaving ---
// --- either closes it. A no-op "toggle" (click) doesn't fight hover/focus. ---

Deno.test("nextTooltipOpen (desktop): pointer-enter opens it", () => {
  assertEquals(nextTooltipOpen(false, "pointer-enter", false), true);
});

Deno.test("nextTooltipOpen (desktop): pointer-leave closes it", () => {
  assertEquals(nextTooltipOpen(true, "pointer-leave", false), false);
});

Deno.test("nextTooltipOpen (desktop): focus opens it", () => {
  assertEquals(nextTooltipOpen(false, "focus", false), true);
});

Deno.test("nextTooltipOpen (desktop): blur closes it", () => {
  assertEquals(nextTooltipOpen(true, "blur", false), false);
});

Deno.test("nextTooltipOpen (desktop): toggle (a mouse click) is a no-op — hover/focus already control it", () => {
  assertEquals(nextTooltipOpen(false, "toggle", false), false);
  assertEquals(nextTooltipOpen(true, "toggle", false), true);
});

// --- Touch (isTouch = true): hover events are no-ops; toggle (tap) flips ---
// --- it; dismiss always closes it, regardless of device. ---

Deno.test("nextTooltipOpen (touch): pointer-enter/leave are no-ops", () => {
  assertEquals(nextTooltipOpen(false, "pointer-enter", true), false);
  assertEquals(nextTooltipOpen(true, "pointer-leave", true), true);
});

Deno.test("nextTooltipOpen (touch): toggle (a tap) flips it open/closed", () => {
  assertEquals(nextTooltipOpen(false, "toggle", true), true);
  assertEquals(nextTooltipOpen(true, "toggle", true), false);
});

Deno.test("nextTooltipOpen (touch): focus still opens it (e.g. an external keyboard/switch control)", () => {
  assertEquals(nextTooltipOpen(false, "focus", true), true);
});

Deno.test("nextTooltipOpen: dismiss always closes it, on both device kinds", () => {
  assertEquals(nextTooltipOpen(true, "dismiss", false), false);
  assertEquals(nextTooltipOpen(true, "dismiss", true), false);
});
