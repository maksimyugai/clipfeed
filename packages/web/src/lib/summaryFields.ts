import type { Lang } from "../i18n.ts";

export interface SummaryFields {
  title: string;
  tldr: string | null;
  bullets: string[];
}

// Structural subset of SummaryJson — avoids importing the shared type just
// for these six fields, and keeps this module trivially unit-testable.
export interface SummaryJsonLike {
  title_ru: string;
  title_en: string;
  tldr_ru: string;
  tldr_en: string;
  bullets_ru: string[];
  bullets_en: string[];
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined && v.trim() !== "");
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
    return { title: rawTitle, tldr: null, bullets: [] };
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

  return { title, tldr, bullets };
}
