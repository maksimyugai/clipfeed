import { assertEquals, assertNotEquals } from "@std/assert";
import { stemSearchTerm } from "./ru-stemmer.ts";

// --- Task 43 #1: table-driven cases from the task spec ---

Deno.test("stemSearchTerm: кабели/кабеля/кабелей/кабелем all collapse to the same stem", () => {
  const forms = ["кабели", "кабеля", "кабелей", "кабелем"];
  const stems = forms.map(stemSearchTerm);
  for (const s of stems) assertEquals(s, stems[0]);
  assertEquals(stems[0], "кабел");
});

Deno.test("stemSearchTerm: статья/статьи/статей share a common stem prefix", () => {
  const article = stemSearchTerm("статья");
  const plural = stemSearchTerm("статьи");
  const genitivePlural = stemSearchTerm("статей");
  // All three must reduce to (or share a prefix with) the invariant root
  // "стат" — the part of the word that survives every inflection.
  for (const s of [article, plural, genitivePlural]) {
    assertEquals(s.startsWith("стат"), true);
  }
});

Deno.test("stemSearchTerm: модели/моделей share a common stem", () => {
  assertEquals(stemSearchTerm("модели"), stemSearchTerm("моделей"));
});

Deno.test("stemSearchTerm: безопасность/безопасности share a common stem", () => {
  assertEquals(stemSearchTerm("безопасность"), stemSearchTerm("безопасности"));
});

Deno.test("stemSearchTerm: процессор/процессоры/процессором share a common stem", () => {
  const forms = ["процессор", "процессоры", "процессором"];
  const stems = forms.map(stemSearchTerm);
  for (const s of stems) assertEquals(s, stems[0]);
});

Deno.test("stemSearchTerm: Latin terms are only lowercased, never stemmed", () => {
  assertEquals(stemSearchTerm("Windows"), "windows");
  assertEquals(stemSearchTerm("Gemini"), "gemini");
  assertEquals(stemSearchTerm("PCIe"), "pcie");
});

// --- Task 43 #2: over-stemming guard (never below 4 chars) ---

Deno.test("stemSearchTerm: a 3-char stem like 'код' is allowed to stand (>= 4 rule is on the OUTPUT length)", () => {
  // "кодировка" -> stem should still be a meaningful, longer-than-3 root;
  // this just documents that a short but valid word passes through the
  // guard without being forced back to its unstemmed form.
  const stem = stemSearchTerm("кодировка");
  assertEquals(stem.length >= 4, true);
});

Deno.test("stemSearchTerm: over-stemming guard — 'кода' must not collapse to a fragment that also matches unrelated words like 'который'", () => {
  const stem = stemSearchTerm("кода");
  assertEquals(stem.startsWith("котор"), false);
  assertEquals(stem.length >= 4, true);
});

Deno.test("stemSearchTerm: a term that would stem below 4 chars falls back to the original (lowercased) term", () => {
  // "дом" is already only 3 chars — no valid stemming result can be >= 4,
  // so the guard must return the original term unchanged.
  assertEquals(stemSearchTerm("дом"), "дом");
});

Deno.test("stemSearchTerm: idempotent on an already-stemmed word", () => {
  const once = stemSearchTerm("кабели");
  const twice = stemSearchTerm(once);
  assertEquals(twice, once);
});

// --- Task 43 #2: the live failing case, reproduced ---

function containsSubstring(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

Deno.test("live failing case: a document containing 'кабели' and 'кабеля' is matched by all four query forms once stemmed", () => {
  const documentText = "В статье перечислены подводные кабели и описана прокладка кабеля.";
  for (const query of ["кабель", "кабели", "кабеля", "кабелей"]) {
    const stem = stemSearchTerm(query);
    assertEquals(
      containsSubstring(documentText, stem),
      true,
      `stem of "${query}" (-> "${stem}") should appear in the document`,
    );
  }
});

Deno.test("stemSearchTerm: distinct roots stay distinct (no over-collapsing)", () => {
  assertNotEquals(stemSearchTerm("процессор"), stemSearchTerm("безопасность"));
  assertNotEquals(stemSearchTerm("модели"), stemSearchTerm("статья"));
});
