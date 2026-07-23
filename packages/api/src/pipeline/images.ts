import "../env.d.ts";
import { parseHTML } from "linkedom";
import { safeFetchImageBytes, SsrfError } from "./ssrf.ts";

// Task 35 Part C: article preview images. Extraction reads ONLY the
// publisher's own og:image/twitter:image meta tag — the exact image a
// publisher already intends to be shown in a link preview (Telegram,
// Slack, etc.) — never anything scraped out of the article body itself.
// Images are strictly optional: any failure at any stage (no tag found,
// SSRF-blocked, wrong content-type, oversized, download error) means the
// article proceeds with no image, never a failed summary — see
// pipeline.ts's image stage, which always logs and continues.

// IMAGES_ENABLED default "true" (like FAITHFULNESS_CHECK's convention) —
// only the literal "false" turns the whole feature off; a missing/garbage
// value stays enabled, since a broken var should never silently disable a
// working feature the owner didn't mean to touch.
export function parseImagesEnabled(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "false";
}

function firstMetaContent(html: string, properties: string[]): string | null {
  const { document } = parseHTML(html);
  for (const property of properties) {
    const el = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
    const content = el?.getAttribute("content")?.trim();
    if (content) return content;
  }
  return null;
}

// og:image checked first (the more universally-supported tag), twitter:image
// as a fallback for pages that only set the Twitter Card tag. Relative URLs
// (rare but real — some pages emit a path-only og:image) are resolved
// against the article's own URL; a malformed absolute URL (neither the tag
// value nor the resolved-against-baseUrl attempt parses) yields null rather
// than throwing — this is a best-effort scrape of untrusted page markup.
export function extractOgImage(html: string, baseUrl: string): string | null {
  const raw = firstMetaContent(html, ["og:image", "twitter:image"]);
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

// SVG can carry <script> — explicitly rejected regardless of size/origin,
// never trusted as a "safe" image format the way raster formats are here.
const ALLOWED_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extensionForContentType(contentType: string): string | null {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_EXTENSION_BY_CONTENT_TYPE[normalized] ?? null;
}

export function r2ImageKey(articleId: string, extension: string): string {
  return `articles/${articleId}.${extension}`;
}

export interface StoredImage {
  key: string;
  sourceUrl: string;
}

// Downloads THROUGH the SSRF guard (safeFetchImageBytes — private ranges
// rejected, redirects re-validated, 10s timeout, 5MB cap, same network
// boundary as article-text fetching), validates the Content-Type is a
// non-SVG image/*, and stores the bytes in R2 under
// `articles/<id>.<ext>`. Returns null (logging why) on ANY failure —
// feature-disabled, no binding, SSRF rejection, wrong/missing content-type,
// oversized, or a raw R2 error — never throws, since an image is strictly
// optional and this must never affect the article's own success/failure.
export async function downloadAndStoreImage(
  env: Env,
  articleId: string,
  imageUrl: string,
): Promise<StoredImage | null> {
  if (!parseImagesEnabled(env.IMAGES_ENABLED)) return null;
  if (!env.IMAGES) {
    console.warn(JSON.stringify({ event: "image_store_skipped", reason: "no_images_binding" }));
    return null;
  }

  try {
    const { bytes, contentType } = await safeFetchImageBytes(imageUrl);
    const extension = extensionForContentType(contentType);
    if (!extension) {
      console.warn(JSON.stringify({
        event: "image_store_rejected",
        reason: "unsupported_content_type",
        contentType,
      }));
      return null;
    }

    const key = r2ImageKey(articleId, extension);
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
    return { key, sourceUrl: imageUrl };
  } catch (err) {
    const reason = err instanceof SsrfError
      ? `ssrf: ${err.message}`
      : err instanceof Error
      ? err.message
      : String(err);
    console.warn(JSON.stringify({ event: "image_store_failed", articleId, reason }));
    return null;
  }
}
