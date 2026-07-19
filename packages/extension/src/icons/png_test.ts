import { assertEquals } from "@std/assert";
import { crc32, encodePng } from "./png.ts";
import { renderIconImage } from "./render.ts";

Deno.test("crc32: matches the standard CRC-32 check value for the ASCII string '123456789'", () => {
  const bytes = new TextEncoder().encode("123456789");
  assertEquals(crc32(bytes), 0xcbf43926);
});

Deno.test("encodePng: output starts with the PNG signature", () => {
  const image = renderIconImage(16);
  return encodePng(image).then((png) => {
    assertEquals([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

Deno.test("encodePng: IHDR chunk encodes the correct width/height/color type", async () => {
  const image = renderIconImage(32);
  const png = await encodePng(image);
  // 8-byte signature, then chunk length(4) + "IHDR"(4) + width(4) + height(4) + ...
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assertEquals(view.getUint32(16), 32); // width
  assertEquals(view.getUint32(20), 32); // height
  assertEquals(png[24], 8); // bit depth
  assertEquals(png[25], 6); // color type: RGBA
});

Deno.test("encodePng: ends with an IEND chunk", async () => {
  const image = renderIconImage(16);
  const png = await encodePng(image);
  const tail = new TextDecoder().decode(png.slice(png.length - 8, png.length - 4));
  assertEquals(tail, "IEND");
});
