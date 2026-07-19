import { assertEquals } from "@std/assert";
import {
  gradientColor,
  isInsideRoundedSquare,
  isMonogramPixel,
  renderIconImage,
} from "./render.ts";

Deno.test("isInsideRoundedSquare: corner pixel is cut off", () => {
  assertEquals(isInsideRoundedSquare(0, 0), false);
});

Deno.test("isInsideRoundedSquare: center pixel is inside", () => {
  assertEquals(isInsideRoundedSquare(8, 8), true);
});

Deno.test("isInsideRoundedSquare: edge midpoint (not near a corner) is inside", () => {
  assertEquals(isInsideRoundedSquare(8, 0), true);
});

Deno.test("isMonogramPixel: a pixel inside the C's left bar is a monogram pixel", () => {
  assertEquals(isMonogramPixel(2, 6), true);
});

Deno.test("isMonogramPixel: a pixel in the gap between C and F is not a monogram pixel", () => {
  assertEquals(isMonogramPixel(7, 6), false);
});

Deno.test("gradientColor: interpolates from the start color at the origin", () => {
  assertEquals(gradientColor(0, 0), [0x7f, 0x77, 0xdd]);
});

Deno.test("gradientColor: interpolates to the end color at the far corner", () => {
  assertEquals(gradientColor(15, 15), [0xd4, 0x53, 0x7e]);
});

Deno.test("renderIconImage: throws for a size that isn't a multiple of the 16x16 grid", () => {
  let threw = false;
  try {
    renderIconImage(20);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("renderIconImage: produces a correctly sized RGBA buffer", () => {
  const image = renderIconImage(32);
  assertEquals(image.width, 32);
  assertEquals(image.height, 32);
  assertEquals(image.pixels.length, 32 * 32 * 4);
});

Deno.test("renderIconImage: corner pixels are fully transparent", () => {
  const image = renderIconImage(16);
  assertEquals(image.pixels[3], 0); // alpha of pixel (0,0)
});

Deno.test("renderIconImage: a background (non-monogram, non-corner) pixel is opaque", () => {
  const image = renderIconImage(16);
  const offset = (0 * 16 + 8) * 4; // (8, 0): inside the square, not part of "cf"
  assertEquals(image.pixels[offset + 3], 255);
});

Deno.test("renderIconImage: a monogram pixel is opaque white", () => {
  const image = renderIconImage(16);
  const offset = (6 * 16 + 2) * 4; // (2, 6): inside the C's left bar
  assertEquals([...image.pixels.slice(offset, offset + 4)], [255, 255, 255, 255]);
});
