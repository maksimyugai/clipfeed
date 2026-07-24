// Task 46 Part C: reads width/height straight out of the header bytes of an
// already-downloaded image (no extra fetch, no dependency) so GET /a/:id can
// emit og:image:width/height — crawlers render large media more reliably
// with explicit dimensions. Strictly best-effort: any truncated/garbage/
// unrecognized input returns null rather than throwing, since an image (and
// now its dimensions) is optional data that must never fail an article.

export interface ImageDimensions {
  width: number;
  height: number;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// IHDR is always the first chunk (spec-mandated), directly after the 8-byte
// signature and the 4-byte length + 4-byte "IHDR" type of the first chunk —
// width/height are its first two 4-byte big-endian fields.
function parsePng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== "IHDR") return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

// SOFn markers (0xC0-0xCF) EXCEPT 0xC4 (DHT), 0xC8 (JPG, reserved), and 0xCC
// (DAC) — those three share the SOF numeric range but aren't frame headers.
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Walks JPEG's marker-segment stream (each marker is 0xFF + a code byte,
// most followed by a 2-byte big-endian segment length) until it finds a
// Start-Of-Frame segment, whose payload is: 1 byte precision, then height
// then width as 2-byte big-endian fields (height BEFORE width, unlike PNG).
function parseJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++; // fill byte, not part of the marker
      continue;
    }
    // SOI/EOI and RSTn (0xD0-0xD7) carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 9 > bytes.length) return null;
    if (isSofMarker(marker)) {
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      return { width, height };
    }
    const segmentLength = readU16BE(bytes, offset + 2);
    if (segmentLength < 2) return null; // malformed, would loop forever
    offset += 2 + segmentLength;
  }
  return null;
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

// The three WebP sub-formats each encode dimensions differently in the
// first sub-chunk (always at byte offset 20 — 12-byte RIFF/WEBP header +
// 8-byte sub-chunk fourCC/size):
//  - VP8X (extended, e.g. carries metadata): explicit 24-bit-minus-one LE
//    canvas width/height fields.
//  - VP8  (lossy): a 3-byte frame tag, a 3-byte start code, then 14-bit
//    width/height packed into 2-byte LE fields (top 2 bits are a scale
//    factor, masked off).
//  - VP8L (lossless): a signature byte, then 14-bit-minus-one width/height
//    bit-packed (LSB-first) into the following 4 bytes.
function parseWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (fourCc(bytes, 0) !== "RIFF" || fourCc(bytes, 8) !== "WEBP") return null;
  const format = fourCc(bytes, 12);
  const payload = 20;

  if (format === "VP8X") {
    const width = 1 + (bytes[payload + 4] | (bytes[payload + 5] << 8) | (bytes[payload + 6] << 16));
    const height = 1 +
      (bytes[payload + 7] | (bytes[payload + 8] << 8) | (bytes[payload + 9] << 16));
    return { width, height };
  }

  if (format === "VP8 ") {
    if (
      bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a
    ) {
      return null;
    }
    const width = (bytes[payload + 6] | (bytes[payload + 7] << 8)) & 0x3fff;
    const height = (bytes[payload + 8] | (bytes[payload + 9] << 8)) & 0x3fff;
    return { width, height };
  }

  if (format === "VP8L") {
    if (bytes[payload] !== 0x2f) return null;
    const bits = (bytes[payload + 1] | (bytes[payload + 2] << 8) | (bytes[payload + 3] << 16) |
      (bytes[payload + 4] << 24)) >>> 0;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }

  return null;
}

// Dispatches on the already-validated Content-Type (see
// images.ts's extensionForContentType, which limits callers to exactly
// these three raster formats plus GIF, which has no parser here — GIF
// dimensions aren't requested by this task and the function simply returns
// null for it). Never throws: a truncated download, a mislabeled
// Content-Type, or a format-specific parse failure all fall through to null.
export function parseImageDimensions(
  bytes: Uint8Array,
  contentType: string,
): ImageDimensions | null {
  try {
    const normalized = contentType.split(";")[0].trim().toLowerCase();
    switch (normalized) {
      case "image/png":
        return parsePng(bytes);
      case "image/jpeg":
        return parseJpeg(bytes);
      case "image/webp":
        return parseWebp(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
