import type { DigestArticleInput } from "../articles/db.ts";
import { digestHeader } from "./telegram-strings.ts";

const MAX_MESSAGE_CHARS = 4096;
const MAX_LINE_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]*[.!?]/);
  return match ? match[0] : trimmed;
}

function buildBulletLine(article: DigestArticleInput): string {
  const line = `• ${article.title_ru} — ${firstSentence(article.tldr_ru)}`;
  return truncate(line, MAX_LINE_CHARS);
}

// Packs a header + one bullet per ready article (+ an optional feed-link
// footer) into as few Telegram messages as possible, splitting only on
// bullet boundaries — a bullet is never cut mid-way. Returns null when
// there's nothing to report, so callers (cron) can skip sending entirely.
export function buildDigestMessages(
  articles: DigestArticleInput[],
  publicBaseUrl: string,
): string[] | null {
  if (articles.length === 0) return null;

  const messages: string[] = [];
  let current = digestHeader(articles.length);

  for (const article of articles) {
    const bullet = buildBulletLine(article);
    const candidate = `${current}\n${bullet}`;
    if (candidate.length > MAX_MESSAGE_CHARS) {
      messages.push(current);
      current = bullet;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  const footer = publicBaseUrl.trim();
  if (footer) {
    const last = messages[messages.length - 1];
    const withFooter = `${last}\n\n${footer}`;
    if (withFooter.length <= MAX_MESSAGE_CHARS) {
      messages[messages.length - 1] = withFooter;
    } else {
      messages.push(footer);
    }
  }

  return messages;
}
