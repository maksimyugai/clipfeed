import { crc32 } from "../packages/extension/src/icons/png.ts";

// A minimal, dependency-free ZIP writer (local file headers + central
// directory + end record, method 8/deflate) so packaging the store upload
// artifact doesn't require a system `zip` binary — keeping `deno task
// zip:extension` portable across whatever OS a forker builds on.

interface ZipEntry {
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

function newBytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function writeUint16LE(value: number): Uint8Array<ArrayBuffer> {
  const bytes = newBytes(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function writeUint32LE(value: number): Uint8Array<ArrayBuffer> {
  const bytes = newBytes(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
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

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate-raw");
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

async function buildZip(entries: ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.data);
    const compressed = await deflateRaw(entry.data);

    const localHeader = concatBytes([
      writeUint32LE(0x04034b50),
      writeUint16LE(20), // version needed to extract
      writeUint16LE(0), // general purpose bit flag
      writeUint16LE(8), // compression method: deflate
      writeUint16LE(dosTime),
      writeUint16LE(dosDate),
      writeUint32LE(crc),
      writeUint32LE(compressed.length),
      writeUint32LE(entry.data.length),
      writeUint16LE(nameBytes.length),
      writeUint16LE(0), // extra field length
      nameBytes,
    ]);
    localParts.push(localHeader, compressed);

    const centralHeader = concatBytes([
      writeUint32LE(0x02014b50),
      writeUint16LE(20), // version made by
      writeUint16LE(20), // version needed to extract
      writeUint16LE(0), // general purpose bit flag
      writeUint16LE(8), // compression method: deflate
      writeUint16LE(dosTime),
      writeUint16LE(dosDate),
      writeUint32LE(crc),
      writeUint32LE(compressed.length),
      writeUint32LE(entry.data.length),
      writeUint16LE(nameBytes.length),
      writeUint16LE(0), // extra field length
      writeUint16LE(0), // file comment length
      writeUint16LE(0), // disk number start
      writeUint16LE(0), // internal file attributes
      writeUint32LE(0), // external file attributes
      writeUint32LE(offset), // relative offset of local header
      nameBytes,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const centralDirectoryOffset = offset;

  const endRecord = concatBytes([
    writeUint32LE(0x06054b50),
    writeUint16LE(0), // number of this disk
    writeUint16LE(0), // disk where central directory starts
    writeUint16LE(entries.length), // central directory records on this disk
    writeUint16LE(entries.length), // total central directory records
    writeUint32LE(centralDirectory.length),
    writeUint32LE(centralDirectoryOffset),
    writeUint16LE(0), // comment length
  ]);

  return concatBytes([...localParts, centralDirectory, endRecord]);
}

async function collectFiles(root: string, prefix = ""): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for await (const dirEntry of Deno.readDir(root)) {
    const path = `${root}/${dirEntry.name}`;
    const relPath = prefix ? `${prefix}/${dirEntry.name}` : dirEntry.name;
    if (dirEntry.isDirectory) {
      entries.push(...(await collectFiles(path, relPath)));
    } else {
      const data = await Deno.readFile(path) as Uint8Array<ArrayBuffer>;
      entries.push({ path: relPath, data });
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const entries = await collectFiles("dist/extension");
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const zip = await buildZip(entries);
  await Deno.mkdir("dist", { recursive: true });
  await Deno.writeFile("dist/clipfeed-extension.zip", zip);
  console.log(
    `Wrote dist/clipfeed-extension.zip (${zip.length} bytes, ${entries.length} files)`,
  );
}

await main();
