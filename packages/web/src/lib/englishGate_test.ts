import { assertEquals } from "@std/assert";
import {
  hasEnglish,
  shouldForgetTranslationRequest,
  shouldRequestTranslation,
} from "./englishGate.ts";

// --- hasEnglish ---

Deno.test("hasEnglish: true when en_generated_at is set, regardless of summary_json", () => {
  assertEquals(
    hasEnglish({ en_generated_at: "2026-01-01T00:00:00.000Z", summary_json: null }),
    true,
  );
});

Deno.test("hasEnglish: true for a pre-Task-35 row — real _en fields but en_generated_at null", () => {
  assertEquals(
    hasEnglish({
      en_generated_at: null,
      summary_json: {
        title_ru: "Заголовок",
        title_en: "Title",
        tldr_ru: "Кратко",
        tldr_en: "TLDR",
        body_ru: [],
        bullets_ru: [],
        tags: [],
        lang_original: "en",
      },
    }),
    true,
  );
});

Deno.test("hasEnglish: true when only title_en is present (tldr_en absent)", () => {
  assertEquals(
    hasEnglish({
      en_generated_at: null,
      summary_json: {
        title_ru: "Заголовок",
        title_en: "Title",
        tldr_ru: "Кратко",
        body_ru: [],
        bullets_ru: [],
        tags: [],
        lang_original: "en",
      },
    }),
    true,
  );
});

Deno.test("hasEnglish: false for a fresh RU-only summary — no _en fields, en_generated_at null", () => {
  assertEquals(
    hasEnglish({
      en_generated_at: null,
      summary_json: {
        title_ru: "Заголовок",
        tldr_ru: "Кратко",
        body_ru: [],
        bullets_ru: [],
        tags: [],
        lang_original: "en",
      },
    }),
    false,
  );
});

Deno.test("hasEnglish: false when summary_json is null and en_generated_at is null", () => {
  assertEquals(hasEnglish({ en_generated_at: null, summary_json: null }), false);
});

Deno.test("hasEnglish: blank/whitespace-only _en fields don't count as having English", () => {
  assertEquals(
    hasEnglish({
      en_generated_at: null,
      summary_json: {
        title_ru: "Заголовок",
        title_en: "   ",
        tldr_ru: "Кратко",
        tldr_en: "",
        body_ru: [],
        bullets_ru: [],
        tags: [],
        lang_original: "en",
      },
    }),
    false,
  );
});

// --- shouldForgetTranslationRequest ---

Deno.test("shouldForgetTranslationRequest: forgets once the article actually has English", () => {
  assertEquals(shouldForgetTranslationRequest(true), true);
});

Deno.test("shouldForgetTranslationRequest: does not forget while the article still lacks English", () => {
  assertEquals(shouldForgetTranslationRequest(false), false);
});

// --- shouldRequestTranslation ---

Deno.test("shouldRequestTranslation: requests when English is needed and not already requested", () => {
  assertEquals(shouldRequestTranslation(true, false), true);
});

Deno.test("shouldRequestTranslation: never enqueues when the article doesn't need English", () => {
  assertEquals(shouldRequestTranslation(false, false), false);
});

Deno.test("shouldRequestTranslation: never enqueues a second time once already requested", () => {
  assertEquals(shouldRequestTranslation(true, true), false);
});

Deno.test("shouldRequestTranslation: repeated intersection events collapse to a single enqueue", () => {
  let alreadyRequested = false;
  let enqueues = 0;
  for (const needsEnglish of [true, true, true, true]) {
    if (shouldRequestTranslation(needsEnglish, alreadyRequested)) {
      enqueues++;
      alreadyRequested = true;
    }
  }
  assertEquals(enqueues, 1);
});

Deno.test("shouldRequestTranslation: mode toggling (needsEnglish false/true/false/true) doesn't re-enqueue a served id", () => {
  // Simulates RU -> EN -> RU -> EN: needsEnglish flips with lang, but
  // `alreadyRequested` only resets via shouldForgetTranslationRequest, which
  // is keyed on hasEnglish(article) — not on needsEnglish — so it stays
  // true across the toggle since the article still doesn't have English yet.
  let alreadyRequested = false;
  let enqueues = 0;
  const needsEnglishSequence = [true, false, true, false, true];
  for (const needsEnglish of needsEnglishSequence) {
    if (shouldRequestTranslation(needsEnglish, alreadyRequested)) {
      enqueues++;
      alreadyRequested = true;
    }
    // hasEnglish(article) is still false throughout — translation hasn't
    // completed — so shouldForgetTranslationRequest never fires here.
  }
  assertEquals(enqueues, 1);
});

Deno.test("shouldRequestTranslation: once the article has English, a later re-need (e.g. resummarize) can request again", () => {
  let alreadyRequested = true; // was already translated once
  if (shouldForgetTranslationRequest(true)) alreadyRequested = false; // hasEnglish was true, then resummarize clears it
  // After resummarize, hasEnglish(article) is false again (fresh RU-only
  // summary_json, en_generated_at reset to null) and needsEnglish is true.
  assertEquals(shouldRequestTranslation(true, alreadyRequested), true);
});
