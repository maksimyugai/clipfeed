import type { AddedVia, CreateArticleRequest, PatchArticleRequest } from "@clipfeed/shared/types";

export const MAX_BODY_BYTES = 3 * 1024 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_TITLE_CHARS = 500;
export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 50;

const VALID_ADDED_VIA: readonly AddedVia[] = ["extension", "manual", "agent", "telegram"];

export interface ValidationError {
  status: 400 | 413;
  error: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function validateTags(tags: unknown): ValidationResult<string[]> {
  if (tags === undefined) return { ok: true, value: [] };
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_TAGS ||
    tags.some((t) => typeof t !== "string" || t.length > MAX_TAG_CHARS)
  ) {
    return {
      ok: false,
      error: {
        status: 400,
        error:
          `tags must be an array of up to ${MAX_TAGS} strings, each up to ${MAX_TAG_CHARS} chars`,
      },
    };
  }
  return { ok: true, value: tags as string[] };
}

export function validateHtml(html: unknown): ValidationResult<string | undefined> {
  if (html === undefined) return { ok: true, value: undefined };
  if (typeof html !== "string") {
    return { ok: false, error: { status: 400, error: "html must be a string" } };
  }
  if (byteLength(html) > MAX_HTML_BYTES) {
    return { ok: false, error: { status: 413, error: "html exceeds 2MB limit" } };
  }
  return { ok: true, value: html };
}

export function validateCreateArticleRequest(
  body: unknown,
): ValidationResult<CreateArticleRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: { status: 400, error: "body must be a JSON object" } };
  }
  const obj = body as Record<string, unknown>;

  if (typeof obj.url !== "string" || obj.url.length === 0) {
    return { ok: false, error: { status: 400, error: "url is required" } };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(obj.url);
  } catch {
    return { ok: false, error: { status: 400, error: "url is not a valid URL" } };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, error: { status: 400, error: "url must be http or https" } };
  }

  const htmlResult = validateHtml(obj.html);
  if (!htmlResult.ok) return htmlResult;

  if (
    obj.title !== undefined && (typeof obj.title !== "string" || obj.title.length > MAX_TITLE_CHARS)
  ) {
    return {
      ok: false,
      error: { status: 400, error: `title must be a string up to ${MAX_TITLE_CHARS} chars` },
    };
  }

  const tagsResult = validateTags(obj.tags);
  if (!tagsResult.ok) return tagsResult;

  let addedVia: AddedVia = "manual";
  if (obj.added_via !== undefined) {
    if (typeof obj.added_via !== "string" || !VALID_ADDED_VIA.includes(obj.added_via as AddedVia)) {
      return {
        ok: false,
        error: {
          status: 400,
          error: "added_via must be one of extension, manual, agent, telegram",
        },
      };
    }
    addedVia = obj.added_via as AddedVia;
  }

  return {
    ok: true,
    value: {
      url: obj.url,
      html: htmlResult.value,
      title: obj.title as string | undefined,
      tags: tagsResult.value,
      added_via: addedVia,
    },
  };
}

export function validatePatchArticleRequest(body: unknown): ValidationResult<PatchArticleRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: { status: 400, error: "body must be a JSON object" } };
  }
  const obj = body as Record<string, unknown>;
  const patch: PatchArticleRequest = {};

  if (obj.archived !== undefined) {
    if (typeof obj.archived !== "boolean") {
      return { ok: false, error: { status: 400, error: "archived must be a boolean" } };
    }
    patch.archived = obj.archived;
  }
  if (obj.tags !== undefined) {
    const tagsResult = validateTags(obj.tags);
    if (!tagsResult.ok) return tagsResult;
    patch.tags = tagsResult.value;
  }

  return { ok: true, value: patch };
}

export function sourceFromUrl(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}
