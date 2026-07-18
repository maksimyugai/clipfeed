import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  textContent: string;
}

const MAX_TEXT_CHARS = 30_000;

// Parses raw HTML server-side and returns plain text only — the caller must
// never forward the original HTML to a client.
export function extractArticle(html: string, fallbackTitle?: string): ExtractedArticle {
  const { document } = parseHTML(html);

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
