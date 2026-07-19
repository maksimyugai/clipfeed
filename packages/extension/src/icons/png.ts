import type { RgbaImage } from "./render.ts";

function newBytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint32BE(value: number): Uint8Array<ArrayBuffer> {
  const bytes = newBytes(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = newBytes(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = concatBytes([typeBytes, data]);
  return concatBytes([
    writeUint32BE(data.length),
    typeBytes,
    data,
    writeUint32BE(crc32(crcInput)),
  ]);
}

// PNG's IDAT payload is zlib (RFC 1950) compressed scanline data — the
// "deflate" CompressionStream format is zlib-wrapped (unlike "deflate-raw"),
// so no separate zlib header/Adler32 trailer needs to be hand-rolled here.
async function deflateZlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const writeDone = writer.write(data);
  const closeDone = writer.close();

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await Promise.all([writeDone, closeDone]);

  return concatBytes(chunks);
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export async function encodePng(image: RgbaImage): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, pixels } = image;
  const stride = width * 4;

  const raw = newBytes(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter type: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const ihdrData = concatBytes([
    writeUint32BE(width),
    writeUint32BE(height),
    new Uint8Array([8, 6, 0, 0, 0]), // bit depth 8, color type 6 (RGBA), compression/filter/interlace 0
  ]);

  const idatData = await deflateZlib(raw);

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}
