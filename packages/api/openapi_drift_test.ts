import { assertEquals } from "@std/assert";
import type {
  ArticleListItem,
  PublicArticle,
  SearchResultItem,
  SummaryJson,
} from "@clipfeed/shared/types";
import openApiSpec from "./openapi.json" with { type: "json" };

// Task 39: a lightweight, CI-independent drift check between
// packages/api/openapi.json (hand-maintained) and packages/shared/src/types.ts
// (the actual wire types). This does NOT do full schema validation and does
// NOT check field TYPES — only that every field the spec's `required` array
// names for a representative subset of schemas actually exists as a key on
// a real, TypeScript-checked sample of the corresponding shared type.
//
// The mechanism: each sample below is annotated with its real shared type
// (e.g. `: PublicArticle`). If shared/types.ts ever adds/renames/removes a
// required field, one of two things happens — either this file fails to
// compile (`deno check`/`deno task test` both run type-checking first), or
// the sample compiles fine but the runtime key-set check below fails
// because the sample's own keys no longer line up with what openapi.json
// still claims is required. Either failure is the signal this test exists
// to catch; neither requires adopting a schema/validation library just for
// this test (see the task's own note on why that's out of scope here).
//
// Limits (explicit, not accidental): only the schemas below are checked
// (not every schema in the spec); only `required` field PRESENCE is
// checked, never types, formats, or optional-field shapes; nested $ref
// schemas (e.g. SummaryJson embedded in PublicArticle) are checked
// separately, not recursively from the parent. This is a drift smoke test,
// not a contract test suite.

interface Schema {
  required?: string[];
  properties?: Record<string, unknown>;
}

function schemaFor(name: string): Schema {
  const schema = (openApiSpec.components.schemas as Record<string, Schema>)[name];
  if (!schema) throw new Error(`openapi.json has no components.schemas.${name}`);
  return schema;
}

function assertRequiredFieldsExist(schemaName: string, sample: object): void {
  const schema = schemaFor(schemaName);
  const sampleKeys = new Set(Object.keys(sample));
  for (const field of schema.required ?? []) {
    assertEquals(
      sampleKeys.has(field),
      true,
      `openapi.json's ${schemaName}.required names "${field}", but it's missing from the real ${schemaName} sample below`,
    );
  }
}

const sampleSummaryJson: SummaryJson = {
  title_ru: "Заголовок",
  tldr_ru: "Краткое содержание.",
  body_ru: ["Абзац."],
  bullets_ru: ["Пункт."],
  tags: ["tech"],
  lang_original: "en",
};

Deno.test("openapi drift: SummaryJson required fields match the real shared type", () => {
  assertRequiredFieldsExist("SummaryJson", sampleSummaryJson);
});

const samplePublicArticle: PublicArticle = {
  id: "a1",
  url: "https://example.com/a1",
  canonical_url: null,
  title: "Example",
  source: "example.com",
  author: null,
  published_at: null,
  added_at: "2026-01-01T00:00:00.000Z",
  added_via: "manual",
  lang_original: "en",
  summary_ru: "summary",
  summary_en: null,
  summary_json: sampleSummaryJson,
  tags: [],
  status: "ready",
  archived: false,
  fail_class: null,
  heal_attempts: 0,
  faithfulness_verdict: null,
  faithfulness_checked_at: null,
  embedded_at: null,
  telegram_published_at: null,
  en_generated_at: null,
  image_key: null,
  image_source_url: null,
  processing_started_at: null,
  has_error: false,
};

Deno.test("openapi drift: PublicArticle required fields match the real shared type", () => {
  assertRequiredFieldsExist("PublicArticle", samplePublicArticle);
});

const sampleArticleListItem: ArticleListItem = {
  ...samplePublicArticle,
  error: null,
  faithfulness_json: null,
  faithfulness_enforced_at: null,
};
// PublicArticle's owner-only counterpart drops has_error and adds error/faithfulness_json —
// strip has_error explicitly so the ArticleListItem sample doesn't carry a field that isn't
// actually part of that type (TypeScript wouldn't catch the extra key via object spread here).
delete (sampleArticleListItem as { has_error?: boolean }).has_error;

Deno.test("openapi drift: ArticleListItem required fields match the real shared type", () => {
  assertRequiredFieldsExist("ArticleListItem", sampleArticleListItem);
});

const sampleSearchResultItem: SearchResultItem = {
  article: samplePublicArticle,
  score: 0.87,
};

Deno.test("openapi drift: SearchResultItem required fields match the real shared type", () => {
  assertRequiredFieldsExist("SearchResultItem", sampleSearchResultItem);
});

// ErrorResponse has no corresponding shared/src/types.ts interface — every
// route just returns an ad-hoc `c.json({ error: "..." }, status)` inline, so
// there's no real type to tie this sample to. Checked structurally only
// (against openapi.json's own declared shape), same field-presence-only
// mechanism as the others above.
const sampleErrorResponse = { error: "not found" };

Deno.test("openapi drift: ErrorResponse required fields match the real (ad-hoc) error shape", () => {
  assertRequiredFieldsExist("ErrorResponse", sampleErrorResponse);
});

Deno.test("openapi drift: every path in the spec starts with / and every operation has a tag", () => {
  for (const [path, methods] of Object.entries(openApiSpec.paths as Record<string, unknown>)) {
    assertEquals(path.startsWith("/"), true, `path "${path}" should start with /`);
    for (const [method, op] of Object.entries(methods as Record<string, { tags?: string[] }>)) {
      if (method === "parameters") continue;
      assertEquals(
        Array.isArray(op.tags) && op.tags.length > 0,
        true,
        `${method.toUpperCase()} ${path} has no tags`,
      );
    }
  }
});
