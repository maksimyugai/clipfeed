import { assertEquals } from "@std/assert";
import { selectSummaryFields, type SummaryJsonLike } from "./summaryFields.ts";

const FULL: SummaryJsonLike = {
  title_ru: "Заголовок RU",
  title_en: "Title EN",
  tldr_ru: "Кратко по-русски.",
  tldr_en: "Short in English.",
  bullets_ru: ["Пункт 1", "Пункт 2"],
  bullets_en: ["Point 1", "Point 2"],
  body_ru: ["Абзац 1 по-русски.", "Абзац 2 по-русски."],
  body_en: ["Paragraph 1 in English.", "Paragraph 2 in English."],
};

Deno.test("selectSummaryFields: no summary_json falls back entirely to raw title, empty tldr/bullets/body", () => {
  const result = selectSummaryFields("Raw Title", null, "ru");
  assertEquals(result, { title: "Raw Title", tldr: null, bullets: [], body: [] });
});

Deno.test("selectSummaryFields: ru language picks ru fields", () => {
  const result = selectSummaryFields("Raw Title", FULL, "ru");
  assertEquals(result.title, "Заголовок RU");
  assertEquals(result.tldr, "Кратко по-русски.");
  assertEquals(result.bullets, ["Пункт 1", "Пункт 2"]);
  assertEquals(result.body, ["Абзац 1 по-русски.", "Абзац 2 по-русски."]);
});

Deno.test("selectSummaryFields: en language picks en fields", () => {
  const result = selectSummaryFields("Raw Title", FULL, "en");
  assertEquals(result.title, "Title EN");
  assertEquals(result.tldr, "Short in English.");
  assertEquals(result.bullets, ["Point 1", "Point 2"]);
  assertEquals(result.body, ["Paragraph 1 in English.", "Paragraph 2 in English."]);
});

Deno.test("selectSummaryFields: missing ru title falls back to en title", () => {
  const partial: SummaryJsonLike = { ...FULL, title_ru: "" };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.title, "Title EN");
});

Deno.test("selectSummaryFields: missing both titles falls back to raw title", () => {
  const partial: SummaryJsonLike = { ...FULL, title_ru: "", title_en: "  " };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.title, "Raw Title");
});

Deno.test("selectSummaryFields: missing ru tldr falls back to en tldr", () => {
  const partial: SummaryJsonLike = { ...FULL, tldr_ru: "" };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.tldr, "Short in English.");
});

Deno.test("selectSummaryFields: missing both tldrs is null", () => {
  const partial: SummaryJsonLike = { ...FULL, tldr_ru: "", tldr_en: "" };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.tldr, null);
});

Deno.test("selectSummaryFields: empty ru bullets falls back to en bullets", () => {
  const partial: SummaryJsonLike = { ...FULL, bullets_ru: [] };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.bullets, ["Point 1", "Point 2"]);
});

Deno.test("selectSummaryFields: both bullet lists empty yields empty array", () => {
  const partial: SummaryJsonLike = { ...FULL, bullets_ru: [], bullets_en: [] };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.bullets, []);
});

// --- body: backward compatibility with rows saved before this field existed ---

Deno.test("selectSummaryFields: body_ru/body_en entirely absent (pre-body-schema row) yields an empty body array, no throw", () => {
  const { body_ru: _ru, body_en: _en, ...withoutBody } = FULL;
  const result = selectSummaryFields("Raw Title", withoutBody, "ru");
  assertEquals(result.body, []);
  // The rest of the summary still renders normally.
  assertEquals(result.tldr, "Кратко по-русски.");
});

Deno.test("selectSummaryFields: empty ru body falls back to en body", () => {
  const partial: SummaryJsonLike = { ...FULL, body_ru: [] };
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.body, ["Paragraph 1 in English.", "Paragraph 2 in English."]);
});

Deno.test("selectSummaryFields: body present only in the other language is still picked up (mixed old/new content)", () => {
  const { body_ru: _ru, ...partial } = FULL;
  const result = selectSummaryFields("Raw Title", partial, "ru");
  assertEquals(result.body, ["Paragraph 1 in English.", "Paragraph 2 in English."]);
});
