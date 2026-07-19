import { buildHtmlPayload, HARD_CAP_BYTES, type HtmlSource } from "../lib/payload.ts";

export interface CapturedSelection {
  url: string;
  title: string;
  html: string | null;
  htmlSource: HtmlSource;
}

function extractSelectionHtml(): string | null {
  const selection = globalThis.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const container = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }
  return container.innerHTML || null;
}

function captureSelection(): CapturedSelection | null {
  const selectionHtml = extractSelectionHtml();
  if (selectionHtml === null) {
    return null;
  }
  // A selection has only one HTML candidate (no readability fallback tier),
  // so both threshold args are the hard cap: within it sends as-is, over it
  // sends no html and the server falls back to its own fetch.
  const { html, source } = buildHtmlPayload(selectionHtml, null, HARD_CAP_BYTES, HARD_CAP_BYTES);
  return { url: location.href, title: document.title, html, htmlSource: source };
}

declare global {
  var __clipfeed_captureSelection: (() => CapturedSelection | null) | undefined;
}

globalThis.__clipfeed_captureSelection = captureSelection;
