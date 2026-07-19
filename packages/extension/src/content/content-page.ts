import { Readability } from "@mozilla/readability";
import { buildHtmlPayload, type HtmlSource } from "../lib/payload.ts";

export interface CapturedPage {
  url: string;
  title: string;
  html: string | null;
  htmlSource: HtmlSource;
}

// Readability mutates the document it's given, so it always runs on a clone
// — the real page must be left untouched.
function extractReadabilityHtml(): string | null {
  try {
    const clone = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    return article?.content ?? null;
  } catch {
    return null;
  }
}

function capturePage(): CapturedPage {
  const fullHtml = document.documentElement.outerHTML;
  const readabilityHtml = extractReadabilityHtml();
  const { html, source } = buildHtmlPayload(fullHtml, readabilityHtml);
  return { url: location.href, title: document.title, html, htmlSource: source };
}

declare global {
  var __clipfeed_capturePage: (() => CapturedPage) | undefined;
}

// This file is injected purely for its side effect (registering a page
// global); background.ts separately invokes it via a small closure-free
// `func:` injection, since chrome.scripting.executeScript's `func:` reliably
// captures a return value (including awaiting a Promise) while a bundled
// `files:` entry point's own completion value is not something to depend on.
globalThis.__clipfeed_capturePage = capturePage;
