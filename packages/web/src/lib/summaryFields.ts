import type { Lang } from "../i18n.ts";

export interface SummaryFields {
  title: string;
  tldr: string | null;
  bullets: string[];
  body: string[];
}

// Structural subset of SummaryJson — avoids importing the shared type just
// for these fields, and keeps this module trivially unit-testable.
// body_ru/body_en are optional (not just possibly-empty arrays): rows saved
// before the body-paragraph schema existed have no such keys at all in
// their stored JSON, so a naive `summary.body_ru.map(...)` would throw on
// those old rows even though the shared SummaryJson type claims the field
// is always a string[] — see asStringArray() below, which is what actually
// guards against that at runtime.
export interface SummaryJsonLike {
  title_ru: string;
  title_en: string;
  tldr_ru: string;
  tldr_en: string;
  bullets_ru: string[];
  bullets_en: string[];
  body_ru?: string[];
  body_en?: string[];
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined && v.trim() !== "");
}

// Defensive read for a field the type says is always string[] but an
// old, pre-body-schema stored row may not actually have.
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// Picks the per-language summary fields to render, falling back to the
// other language, then to the article's own (extracted) title, if the
// preferred language's field is missing or blank.
export function selectSummaryFields(
  rawTitle: string,
  summaryJson: SummaryJsonLike | null,
  lang: Lang,
): SummaryFields {
  if (!summaryJson) {
    return { title: rawTitle, tldr: null, bullets: [], body: [] };
  }

  const primaryTitle = lang === "ru" ? summaryJson.title_ru : summaryJson.title_en;
  const fallbackTitle = lang === "ru" ? summaryJson.title_en : summaryJson.title_ru;
  const title = firstNonEmpty(primaryTitle, fallbackTitle, rawTitle) ?? rawTitle;

  const primaryTldr = lang === "ru" ? summaryJson.tldr_ru : summaryJson.tldr_en;
  const fallbackTldr = lang === "ru" ? summaryJson.tldr_en : summaryJson.tldr_ru;
  const tldr = firstNonEmpty(primaryTldr, fallbackTldr) ?? null;

  const primaryBullets = lang === "ru" ? summaryJson.bullets_ru : summaryJson.bullets_en;
  const fallbackBullets = lang === "ru" ? summaryJson.bullets_en : summaryJson.bullets_ru;
  const bullets = primaryBullets.length > 0 ? primaryBullets : fallbackBullets;

  const primaryBody = asStringArray(lang === "ru" ? summaryJson.body_ru : summaryJson.body_en);
  const fallbackBody = asStringArray(lang === "ru" ? summaryJson.body_en : summaryJson.body_ru);
  const body = primaryBody.length > 0 ? primaryBody : fallbackBody;

  return { title, tldr, bullets, body };
}
