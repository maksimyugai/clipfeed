// Builds the drip-publish post text (see telegram-publish.ts) — a proper
// standalone post per article, replacing the old wall-of-text digest.
// Separate module from telegram-digest.ts (which still formats the manual
// /digest command's output — a different shape entirely).
//
// Task 32 Part B: the post links to the ClipFeed card ONLY — the original
// article link already lives inside that card. Telegram's link-preview
// crawler builds its preview from whichever URL(s) appear in the message,
// so a message with two links (the card + the source) let Telegram pick
// the source link for its preview instead, defeating the whole point of
// GET /a/:id. The source attribution is now plain text (a domain name,
// no href) so the card link is the ONLY <a> in the message.

const MAX_MESSAGE_CHARS = 4096;

export interface PublishPostInput {
  id: string;
  url: string;
  source: string | null;
  title_ru: string;
  tldr_ru: string;
  bullets_ru: string[];
}

// Telegram's HTML parse_mode requires exactly these three entities escaped
// in text content — every dynamic value in the post (title, tldr, bullets,
// domain, URL) goes through this, so a title containing "<" (or "&"/">")
// can never break the message or get interpreted as a tag.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Attribute context needs stricter escaping than text nodes because quotes
// can terminate the attribute value — needed for the card link's href.
function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// Absolute path to the SPA's per-article route (see GET /a/:id in
// index.ts) — deliberately not the old "/#article-<id>" hash: a hash
// fragment is never sent to the server, so it can never produce a link
// preview (see the og.ts module GET /a/:id uses to inject one).
function cardUrl(publicBaseUrl: string, id: string): string {
  return `${publicBaseUrl}/a/${id}`;
}

function domainFor(input: Pick<PublishPostInput, "url" | "source">): string {
  if (input.source) return input.source;
  try {
    return new URL(input.url).hostname;
  } catch {
    return input.url;
  }
}

function renderMessage(
  input: PublishPostInput,
  publicBaseUrl: string,
  bullets: readonly string[],
  tldr: string,
): string {
  const lines = [
    `<b>${escapeHtml(input.title_ru)}</b>`,
    "",
    escapeHtml(tldr),
  ];
  if (bullets.length > 0) {
    lines.push("", bullets.map((b) => `• ${escapeHtml(b)}`).join("\n"));
  }
  // Task 31: an unset PUBLIC_BASE_URL used to still render this line via
  // cardUrl("", id) -> "/a/<id>" — a bare relative path with no
  // scheme/domain, posted as plain (non-linked) text. Omit the line
  // entirely rather than ever publish that.
  const trimmedBase = publicBaseUrl.trim();
  if (trimmedBase) {
    const url = cardUrl(trimmedBase, input.id);
    lines.push(
      "",
      `Читать полностью → <a href="${escapeHtmlAttr(url)}">${escapeHtml(url)}</a>`,
    );
  }
  // Plain text, no <a> — see the module doc comment above for why: this
  // message must contain at most one link (the card link), or Telegram's
  // crawler may preview the source instead of the ClipFeed card.
  lines.push("", `Источник: ${escapeHtml(domainFor(input))}`);
  return lines.join("\n");
}

// Respects Telegram's 4096-char cap by truncating bullets first (dropped
// one at a time from the end), then the TL;DR — title and link are never
// touched. Each step re-measures the FULL rendered (escaped) message rather
// than estimating, since HTML-escaping can grow a string's length
// non-linearly (a title full of "&" characters escapes to nearly 5x its
// raw length).
export function buildPublishPost(input: PublishPostInput, publicBaseUrl: string): string {
  let bullets = input.bullets_ru;
  let message = renderMessage(input, publicBaseUrl, bullets, input.tldr_ru);

  while (message.length > MAX_MESSAGE_CHARS && bullets.length > 0) {
    bullets = bullets.slice(0, -1);
    message = renderMessage(input, publicBaseUrl, bullets, input.tldr_ru);
  }

  let tldr = input.tldr_ru;
  while (message.length > MAX_MESSAGE_CHARS && tldr.length > 0) {
    const overshoot = message.length - MAX_MESSAGE_CHARS;
    const cut = Math.max(1, overshoot);
    tldr = tldr.length > cut ? `${tldr.slice(0, tldr.length - cut - 1)}…` : "";
    message = renderMessage(input, publicBaseUrl, bullets, tldr);
  }

  return message;
}
