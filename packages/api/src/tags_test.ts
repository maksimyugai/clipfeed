import { assertEquals } from "@std/assert";
import { normalizeTags } from "./tags.ts";

Deno.test("normalizeTags: lowercases and trims plain tags", () => {
  assertEquals(normalizeTags(["  AI  ", "Security"]), ["ai", "security"]);
});

Deno.test("normalizeTags: dedupes case-insensitively, keeping first-seen order", () => {
  assertEquals(normalizeTags(["ai", "AI", "Ai", "security"]), ["ai", "security"]);
});

Deno.test("normalizeTags: drops empty/whitespace-only tags", () => {
  assertEquals(normalizeTags(["ai", "  ", "", "security"]), ["ai", "security"]);
});

// --- synonym map table ---

const SYNONYM_CASES: Array<[string, string | null]> = [
  ["искусственный интеллект", "ai"],
  ["ии", "ai"],
  ["programmirovanie", "programming"],
  ["программирование", "programming"],
  ["обучение", "education"],
  ["obuchenie", "education"],
  ["космос", "space"],
  ["право", "law"],
  ["музыка", "music"],
  ["безопасность", "security"],
  ["конкуренция", "business"],
  ["энергетика", "energy"],
  ["индия", "india"],
  ["китай", "china"],
  ["таймаут", null],
];

for (const [input, expected] of SYNONYM_CASES) {
  Deno.test(`normalizeTags: synonym map "${input}" -> ${JSON.stringify(expected)}`, () => {
    const result = normalizeTags([input]);
    assertEquals(result, expected === null ? [] : [expected]);
  });
}

Deno.test("normalizeTags: synonym mapping is case-insensitive on input", () => {
  assertEquals(normalizeTags(["ИИ", "Искусственный Интеллект"]), ["ai"]);
});

Deno.test("normalizeTags: two synonyms mapping to the same target dedupe into one tag", () => {
  assertEquals(
    normalizeTags(["программирование", "programmirovanie", "ии", "искусственный интеллект"]),
    [
      "programming",
      "ai",
    ],
  );
});

Deno.test("normalizeTags: a dropped (null-mapped) tag is the only tag -> empty result", () => {
  assertEquals(normalizeTags(["таймаут"]), []);
});

Deno.test("normalizeTags: a dropped tag alongside real tags leaves the real ones intact", () => {
  assertEquals(normalizeTags(["ai", "таймаут", "security"]), ["ai", "security"]);
});

Deno.test("normalizeTags: an unknown non-latin tag is kept, just lowercased (not destroyed)", () => {
  assertEquals(normalizeTags(["Полиномиальные Отображения"]), ["полиномиальные отображения"]);
});

Deno.test("normalizeTags: mixed known-synonym, unknown-non-latin, and plain english tags all coexist", () => {
  assertEquals(
    normalizeTags(["ии", "jacobian conjecture", "полиномиальные отображения"]),
    ["ai", "jacobian conjecture", "полиномиальные отображения"],
  );
});

Deno.test("normalizeTags: empty input yields empty output", () => {
  assertEquals(normalizeTags([]), []);
});

Deno.test("normalizeTags: idempotent — normalizing an already-normalized list is a no-op", () => {
  const once = normalizeTags(["ии", "programmirovanie", "google", "таймаут"]);
  const twice = normalizeTags(once);
  assertEquals(twice, once);
});

Deno.test("normalizeTags: proper nouns pass through unchanged (just lowercased)", () => {
  assertEquals(normalizeTags(["Google", "Cloudflare"]), ["google", "cloudflare"]);
});
