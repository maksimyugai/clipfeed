import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  textContent: string;
}

const MAX_TEXT_CHARS = 30_000;

// linkedom/Readability cost scales with total DOM node count, not just byte
// size — pages heavy in <script>/<svg>/<template> noise (seen in practice on
// a GitHub repo page: ~330 such tags) can burn disproportionate CPU time
// relative to their actual article content. Stripping that noise on the raw
// string before parseHTML() ever builds a DOM is far cheaper than letting
// Readability score-and-discard it node by node.
const NOISE_TAG_PATTERN = /<(script|style|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

function stripNoise(html: string): string {
  return html.replace(HTML_COMMENT_PATTERN, "").replace(NOISE_TAG_PATTERN, "");
}

// 1.5 MB — applied AFTER noise-stripping, so a legitimately large article
// isn't truncated just because it also carried a lot of stripped-out chrome.
const HTML_PARSE_CAP = 1.5 * 1024 * 1024;

function capBytes(input: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= maxBytes) return input;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
}

// Parses raw HTML server-side and returns plain text only — the caller must
// never forward the original HTML to a client.
export function extractArticle(html: string, fallbackTitle?: string): ExtractedArticle {
  const safeHtml = capBytes(stripNoise(html), HTML_PARSE_CAP);
  const { document } = parseHTML(safeHtml);

  let title: string | null = null;
  let byline: string | null = null;
  let textContent = "";

  try {
    const reader = new Readability(document as unknown as Document);
    const result = reader.parse();
    if (result?.textContent) {
      title = result.title ?? null;
      byline = result.byline ?? null;
      textContent = result.textContent;
    }
  } catch {
    // Readability failed on this markup — fall back to raw body text below.
  }

  if (!textContent) {
    textContent = document.body?.textContent ?? "";
  }
  if (!title) {
    title = fallbackTitle ?? document.querySelector("title")?.textContent ?? null;
  }

  return {
    title,
    byline,
    textContent: textContent.trim().slice(0, MAX_TEXT_CHARS),
  };
}
