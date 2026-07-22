import { assertEquals } from "@std/assert";
import {
  isScrollToTopVisible,
  SCROLL_TOP_VISIBLE_THRESHOLD_PX,
  scrollToTopBehavior,
} from "./scrollToTop.ts";

Deno.test("isScrollToTopVisible - at the very top: hidden", () => {
  assertEquals(isScrollToTopVisible(0), false);
});

Deno.test("isScrollToTopVisible - scrolled a little, still under the threshold: hidden", () => {
  assertEquals(isScrollToTopVisible(200), false);
});

Deno.test("isScrollToTopVisible - exactly at the threshold: still hidden (strictly greater-than)", () => {
  assertEquals(isScrollToTopVisible(SCROLL_TOP_VISIBLE_THRESHOLD_PX), false);
});

Deno.test("isScrollToTopVisible - just past the threshold: visible", () => {
  assertEquals(isScrollToTopVisible(SCROLL_TOP_VISIBLE_THRESHOLD_PX + 1), true);
});

Deno.test("isScrollToTopVisible - scrolled far down: visible", () => {
  assertEquals(isScrollToTopVisible(5000), true);
});

Deno.test("scrollToTopBehavior - reduced motion: instant jump", () => {
  assertEquals(scrollToTopBehavior(true), "auto");
});

Deno.test("scrollToTopBehavior - motion allowed: smooth scroll", () => {
  assertEquals(scrollToTopBehavior(false), "smooth");
});
