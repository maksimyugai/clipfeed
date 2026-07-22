// Task 32 Part B: per-article Open Graph / Twitter Card meta tags for the
// public GET /a/:id route (see index.ts). A link-preview crawler (Telegram,
// etc.) only ever fetches a URL's raw HTML — it never executes JS and never
// sees a hash fragment (never sent to the server at all) — so this is the
// only way to give a Telegram-posted card link its own preview instead of
// the generic app shell.

const OG_MARKER = "<!--OG-->";
const MAX_DESCRIPTION_CHARS = 200;

export interface OgArticle {
  title: string;
  tldr: string;
}

// Attribute-context escaping (content="...") — the four characters that
// can break out of a double-quoted HTML attribute.
function escapeHtmlAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// `cardUrl` is passed in fully formed (PUBLIC_BASE_URL + "/a/" + id) —
// this module only renders tags, it doesn't decide whether a URL is
// available (see index.ts's fallback-to-plain-shell when it isn't).
export function buildOgTags(article: OgArticle, cardUrl: string): string {
  const title = escapeHtmlAttr(article.title);
  const description = escapeHtmlAttr(truncate(article.tldr, MAX_DESCRIPTION_CHARS));
  const url = escapeHtmlAttr(cardUrl);
  return [
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:site_name" content="ClipFeed" />`,
    `<meta property="og:type" content="article" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");
}

// Replaces the `<!--OG-->` marker in index.html (see packages/web/index.html)
// with the rendered tags. A no-op (returns the input unchanged) if the
// marker is missing for some reason — never throws, never corrupts the
// shell.
export function injectOgTags(html: string, tags: string): string {
  return html.replace(OG_MARKER, tags);
}
