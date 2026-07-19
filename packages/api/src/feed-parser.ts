import "./env.d.ts";
import type { Candidate, SourceConfig } from "./agent-types.ts";
import { sourceFromUrl } from "./validation.ts";

export interface FeedItem {
  title: string;
  link: string;
  publishedAt: string | null;
  snippet: string;
}

const SNIPPET_MAX_CHARS = 500;

// Hand-written, tolerant RSS2/Atom parser — regex-based rather than a real
// XML/DOM parser. linkedom's HTML-mode parser was tried first and rejected:
// it treats a bare <link>URL</link> (RSS2's plain-text link element) as an
// HTML void element and silently drops its text content, which is fatal for
// RSS. Regex extraction sidesteps that entirely and handles the two shapes
// we actually need (RSS2 <item>, Atom <entry>) without pulling in a real XML
// parser dependency.
function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(re);
  return match ? match[1] : null;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSnippet(text: string): string {
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) : text;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = decodeEntities(raw);
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractAtomLink(block: string): string {
  // Atom entries can carry several <link> elements (alternate, via,
  // enclosure, ...) — prefer rel="alternate" (the actual article URL);
  // fall back to the first <link href="..."> found if none is marked.
  // Attribute order isn't guaranteed, so match each whole <link .../> tag
  // and inspect rel/href independently rather than assuming a fixed order.
  const linkTags = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  const hrefOf = (tag: string) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
  const isAlternate = (tag: string) => /\brel=["']alternate["']/i.test(tag);

  const alternateHref = linkTags.find(isAlternate);
  if (alternateHref) {
    const href = hrefOf(alternateHref);
    if (href) return href;
  }
  for (const tag of linkTags) {
    const href = hrefOf(tag);
    if (href) return href;
  }
  return "";
}

function parseRssItem(block: string): FeedItem {
  return {
    title: decodeEntities(extractTag(block, "title") ?? ""),
    link: decodeEntities(extractTag(block, "link") ?? ""),
    publishedAt: parseDate(extractTag(block, "pubDate")),
    snippet: truncateSnippet(decodeEntities(extractTag(block, "description") ?? "")),
  };
}

function parseAtomEntry(block: string): FeedItem {
  const snippetRaw = extractTag(block, "summary") ?? extractTag(block, "content") ?? "";
  return {
    title: decodeEntities(extractTag(block, "title") ?? ""),
    link: extractAtomLink(block).trim(),
    publishedAt: parseDate(extractTag(block, "updated") ?? extractTag(block, "published")),
    snippet: truncateSnippet(decodeEntities(snippetRaw)),
  };
}

// Never throws — a feed we can't make sense of just yields an empty (or
// partial) item list; the caller treats that the same as "nothing new",
// never as a reason to fail the whole agent run.
export function parseFeed(xml: string): FeedItem[] {
  const rssBlocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  if (rssBlocks.length > 0) {
    return rssBlocks.map(parseRssItem).filter((item) => item.title && item.link);
  }

  const atomBlocks = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? [];
  return atomBlocks.map(parseAtomEntry).filter((item) => item.title && item.link);
}

const RSS_TIMEOUT_MS = 10_000;
const RSS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Fetches and parses one RSS/Atom source, mapping items to the shared
// Candidate shape. Throws on network/HTTP failure — the caller (sources.ts)
// is responsible for catching and skipping the source, never failing the
// whole run over one bad feed.
export async function fetchRssCandidates(config: SourceConfig): Promise<Candidate[]> {
  if (!config.url) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RSS_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(config.url, {
      headers: {
        "User-Agent": RSS_USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`rss fetch failed: ${res.status}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const discoverySource = sourceFromUrl(config.url);
  return parseFeed(xml).map((item, i) => ({
    id: `${config.id}-${i}`,
    sourceId: config.id,
    discoverySource,
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    publishedAt: item.publishedAt,
  }));
}
