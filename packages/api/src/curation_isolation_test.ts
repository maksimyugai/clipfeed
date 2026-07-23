import { assertEquals } from "@std/assert";

// Task 33 §7/§9: a static-source regression guard for the isolation
// property the whole auto-learned-block design depends on — "automation
// writes ONLY to KV; manual policy lives ONLY in files. No shared key
// space, so neither can overwrite the other by construction." Rather than
// trying to assert this dynamically (which would only ever prove it for
// whatever code paths a given test happens to exercise), this scans every
// non-test source file in packages/api/src for the actual literal KV key
// prefixes / file-write calls involved, so a future change that
// accidentally introduces a second writer is caught regardless of which
// function it's in.

const SRC_DIR = new URL("./", import.meta.url).pathname;

// Recurses into the domain subdirectories introduced by the Task 38
// restructure — `testing/` is skipped so its fake test doubles (never real
// source) stay out of scope, same as before the restructure when they
// simply weren't reachable by a flat, non-recursive directory read.
function readSourceFiles(dir: string = SRC_DIR, prefix = ""): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      if (entry.name === "testing") continue;
      files.push(...readSourceFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    if (entry.name === "curation_isolation_test.ts") continue;
    files.push({
      path: `${prefix}${entry.name}`,
      content: Deno.readTextFileSync(`${dir}${entry.name}`),
    });
  }
  return files;
}

Deno.test("isolation: only autoblock.ts's source references the 'autoblock:'/'autostat:' KV key prefixes", () => {
  const offenders = readSourceFiles()
    .filter((f) => f.path !== "agent/autoblock.ts")
    .filter((f) => f.content.includes("autoblock:") || f.content.includes("autostat:"))
    .map((f) => f.path);
  assertEquals(offenders, []);
});

Deno.test("isolation: no source file writes to the filesystem at runtime (curation.json/blocklist.json are read-only, via static JSON imports)", () => {
  const writeCallPattern = /Deno\.writeTextFile|Deno\.writeFile|fs\.writeFile/;
  const offenders = readSourceFiles()
    .filter((f) => writeCallPattern.test(f.content))
    .map((f) => f.path);
  assertEquals(offenders, []);
});

Deno.test("isolation: curation.ts/blocklist loaders only ever read the config files via static import, never construct a dynamic path", () => {
  const curation = Deno.readTextFileSync(SRC_DIR + "agent/curation.ts");
  assertEquals(curation.includes('import curationData from "../../curation.json"'), true);
  assertEquals(curation.includes('import blocklistData from "../../blocklist.json"'), true);
  // No readFile/readTextFile of any kind — the ONLY way these files are
  // ever read is Deno's static `with { type: "json" }` import assertion,
  // which is resolved at bundle/compile time, not at runtime by app code.
  assertEquals(/readTextFile|readFileSync|Deno\.readFile/.test(curation), false);
});
