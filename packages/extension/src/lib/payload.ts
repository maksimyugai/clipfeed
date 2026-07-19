export type HtmlSource = "full" | "readability" | "none";

export interface HtmlPayloadResult {
  html: string | null;
  source: HtmlSource;
}

// Preferred ceiling for sending the full page's outerHTML. Kept below the
// server's hard cap so there's room left for the JSON envelope around it.
export const FULL_PAGE_THRESHOLD_BYTES = 1.8 * 1024 * 1024;
// Server-enforced hard cap (packages/api/src/validation.ts MAX_HTML_BYTES).
export const HARD_CAP_BYTES = 2 * 1024 * 1024;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Picks what HTML to send for a captured page, downgrading full -> readability
// article -> none as the payload gets too large for the server to accept.
export function buildHtmlPayload(
  fullHtml: string,
  readabilityHtml: string | null,
  fullPageThresholdBytes: number = FULL_PAGE_THRESHOLD_BYTES,
  hardCapBytes: number = HARD_CAP_BYTES,
): HtmlPayloadResult {
  if (byteLength(fullHtml) <= fullPageThresholdBytes) {
    return { html: fullHtml, source: "full" };
  }
  if (readabilityHtml !== null && byteLength(readabilityHtml) <= hardCapBytes) {
    return { html: readabilityHtml, source: "readability" };
  }
  return { html: null, source: "none" };
}
