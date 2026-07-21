import { assertEquals } from "@std/assert";
import { withMotionClass } from "./motion.ts";

Deno.test("withMotionClass - reduced motion: only the base class, no animation class appended", () => {
  assertEquals(
    withMotionClass("card--just-ready", "card--slide-fade-in", true),
    "card--just-ready",
  );
});

Deno.test("withMotionClass - motion allowed: base + animation class, space-joined", () => {
  assertEquals(
    withMotionClass("card--just-ready", "card--slide-fade-in", false),
    "card--just-ready card--slide-fade-in",
  );
});

Deno.test("withMotionClass - empty base class still works (no leading space)", () => {
  assertEquals(withMotionClass("", "shimmer", false), "shimmer");
  assertEquals(withMotionClass("", "shimmer", true), "");
});
