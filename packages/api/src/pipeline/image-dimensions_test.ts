import { assertEquals } from "@std/assert";
import { parseImageDimensions } from "./image-dimensions.ts";

// --- PNG ---

function buildPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  bytes.set([0, 0, 0, 13], 8); // chunk length (conventional, unread by our parser)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

Deno.test("parseImageDimensions: PNG reads width/height from the IHDR chunk", () => {
  assertEquals(parseImageDimensions(buildPng(1200, 630), "image/png"), {
    width: 1200,
    height: 630,
  });
});

Deno.test("parseImageDimensions: PNG with a wrong signature returns null", () => {
  const bytes = buildPng(100, 100);
  bytes[0] = 0x00;
  assertEquals(parseImageDimensions(bytes, "image/png"), null);
});

Deno.test("parseImageDimensions: PNG whose first chunk isn't IHDR returns null", () => {
  const bytes = buildPng(100, 100);
  bytes.set([0x00, 0x00, 0x00, 0x00], 12); // corrupt the chunk type
  assertEquals(parseImageDimensions(bytes, "image/png"), null);
});

Deno.test("parseImageDimensions: truncated PNG (shorter than the IHDR chunk) returns null", () => {
  assertEquals(parseImageDimensions(buildPng(100, 100).slice(0, 20), "image/png"), null);
});

// --- JPEG ---

function buildJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2); // APP0, length 4, 2 bytes payload
  bytes.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 8); // SOF0, length 11, precision 8
  new DataView(bytes.buffer).setUint16(13, height);
  new DataView(bytes.buffer).setUint16(15, width);
  bytes.set([0x01, 0x01, 0x11, 0x00], 17); // 1 component
  return bytes;
}

Deno.test("parseImageDimensions: JPEG reads width/height from the SOF0 segment (height before width)", () => {
  assertEquals(parseImageDimensions(buildJpeg(1200, 630), "image/jpeg"), {
    width: 1200,
    height: 630,
  });
});

Deno.test("parseImageDimensions: JPEG skips non-SOF segments (APP0 above) to find the SOF marker", () => {
  const result = parseImageDimensions(buildJpeg(800, 450), "image/jpeg");
  assertEquals(result, { width: 800, height: 450 });
});

Deno.test("parseImageDimensions: JPEG missing the SOI marker returns null", () => {
  const bytes = buildJpeg(100, 100);
  bytes[1] = 0x00;
  assertEquals(parseImageDimensions(bytes, "image/jpeg"), null);
});

Deno.test("parseImageDimensions: JPEG with no SOF segment at all returns null", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI immediately followed by EOI
  assertEquals(parseImageDimensions(bytes, "image/jpeg"), null);
});

Deno.test("parseImageDimensions: truncated JPEG (cut mid-segment) returns null", () => {
  assertEquals(parseImageDimensions(buildJpeg(100, 100).slice(0, 10), "image/jpeg"), null);
});

// --- WebP ---

function webpHeader(format: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(20 + payload.length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0, 0, 0, 0], 4); // file size, unread
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  for (let i = 0; i < 4; i++) bytes[12 + i] = format.charCodeAt(i);
  bytes.set([0, 0, 0, 0], 16); // chunk size, unread
  bytes.set(payload, 20);
  return bytes;
}

Deno.test("parseImageDimensions: WebP VP8X reads the explicit 24-bit-minus-one canvas width/height", () => {
  const payload = new Uint8Array(10);
  payload[4] = 99;
  payload[7] = 49; // width-1=99 -> 100, height-1=49 -> 50, low byte of each 3-byte LE field
  const bytes = webpHeader("VP8X", payload);
  assertEquals(parseImageDimensions(bytes, "image/webp"), { width: 100, height: 50 });
});

Deno.test("parseImageDimensions: WebP lossy (VP8 ) reads the 14-bit width/height after the start code", () => {
  const payload = new Uint8Array(10);
  payload.set([0x00, 0x00, 0x00], 0); // frame tag
  payload.set([0x9d, 0x01, 0x2a], 3); // start code
  new DataView(payload.buffer).setUint16(6, 100, true);
  new DataView(payload.buffer).setUint16(8, 50, true);
  const bytes = webpHeader("VP8 ", payload);
  assertEquals(parseImageDimensions(bytes, "image/webp"), { width: 100, height: 50 });
});

Deno.test("parseImageDimensions: WebP lossy (VP8 ) with a bad start code returns null", () => {
  const payload = new Uint8Array(10);
  payload.set([0x00, 0x00, 0x2a], 3); // wrong start code
  const bytes = webpHeader("VP8 ", payload);
  assertEquals(parseImageDimensions(bytes, "image/webp"), null);
});

function packVp8lBits(width: number, height: number): number {
  return (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
}

Deno.test("parseImageDimensions: WebP lossless (VP8L) unpacks the bit-packed width-1/height-1 fields", () => {
  const payload = new Uint8Array(10);
  payload[0] = 0x2f; // signature
  new DataView(payload.buffer).setUint32(1, packVp8lBits(100, 50), true);
  const bytes = webpHeader("VP8L", payload);
  assertEquals(parseImageDimensions(bytes, "image/webp"), { width: 100, height: 50 });
});

Deno.test("parseImageDimensions: WebP lossless (VP8L) with a bad signature byte returns null", () => {
  const payload = new Uint8Array(10);
  payload[0] = 0x00;
  const bytes = webpHeader("VP8L", payload);
  assertEquals(parseImageDimensions(bytes, "image/webp"), null);
});

Deno.test("parseImageDimensions: WebP missing the RIFF/WEBP fourCCs returns null", () => {
  const bytes = webpHeader("VP8X", new Uint8Array(10));
  bytes[0] = 0x00;
  assertEquals(parseImageDimensions(bytes, "image/webp"), null);
});

Deno.test("parseImageDimensions: WebP with an unrecognized sub-format returns null", () => {
  const bytes = webpHeader("XXXX", new Uint8Array(10));
  assertEquals(parseImageDimensions(bytes, "image/webp"), null);
});

Deno.test("parseImageDimensions: truncated WebP (shorter than the fixed 30-byte header) returns null", () => {
  assertEquals(
    parseImageDimensions(webpHeader("VP8X", new Uint8Array(10)).slice(0, 20), "image/webp"),
    null,
  );
});

// --- dispatch / garbage input ---

Deno.test("parseImageDimensions: an unsupported content-type (e.g. GIF) returns null even with plausible bytes", () => {
  assertEquals(parseImageDimensions(buildPng(100, 100), "image/gif"), null);
});

Deno.test("parseImageDimensions: empty bytes return null for every supported type", () => {
  const empty = new Uint8Array(0);
  assertEquals(parseImageDimensions(empty, "image/png"), null);
  assertEquals(parseImageDimensions(empty, "image/jpeg"), null);
  assertEquals(parseImageDimensions(empty, "image/webp"), null);
});

Deno.test("parseImageDimensions: random garbage bytes never throw, always return null", () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(parseImageDimensions(garbage, "image/png"), null);
  assertEquals(parseImageDimensions(garbage, "image/jpeg"), null);
  assertEquals(parseImageDimensions(garbage, "image/webp"), null);
});

Deno.test("parseImageDimensions: content-type with a charset parameter is still normalized correctly", () => {
  assertEquals(parseImageDimensions(buildPng(50, 50), "image/png; charset=binary"), {
    width: 50,
    height: 50,
  });
});
