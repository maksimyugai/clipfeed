import { assertEquals } from "@std/assert";
import { selectSummaryFields, type SummaryJsonLike } from "./summaryFields.ts";

const FULL: SummaryJsonLike = {
  title_ru: "Заголовок RU",
  title_en: "Title EN",
  tldr_ru: "Кратко по-русски.",
  tldr_en: "Short in English.",
  bullets_ru: ["Пункт 1", "Пункт 2"],
  bullets_en: ["Point 1", "Point 2"],
};

Deno.test("selectSummaryFields: no summary_json falls back entirely to raw title, empty tldr/bullets", () => {
  const result = selectSummaryFields("Raw Title", null, "ru");
  assertEquals(result, { title: "Raw Title", tldr: null, bullets: [] });
});

Deno.test("selectSummaryFields: ru language picks ru fields", () => {
  const result = selectSummaryFields("Raw Title", FULL, "ru");
  assertEquals(result.title, "Заголовок RU");
  assertEquals(result.tldr, "Кратко по-русски.");
  assertEquals(result.bullets, ["Пункт 1", "Пункт 2"]);
});

Deno.test("selectSummaryFields: en language picks en fields", () => {
  const result = selectSummaryFields("Raw Title", FULL, "en");
  assertEquals(result.title, "Title EN");
  assertEquals(result.tldr, "Short in English.");
  assertEquals(result.bullets, ["Point 1", "Point 2"]);
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
