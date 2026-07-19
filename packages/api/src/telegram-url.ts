import type { TelegramMessage, TelegramMessageEntity } from "./telegram-client.ts";

const URL_REGEX = /https?:\/\/\S+/;

// Entities take priority over the regex fallback: a "text_link" entity's
// visible text might not even look like a URL (e.g. a hyperlinked word),
// so scanning raw text alone would miss it — and Telegram already tells us
// exactly where a "url" entity's plain-text URL sits.
function urlFromEntities(
  text: string,
  entities: TelegramMessageEntity[] | undefined,
): string | null {
  if (!entities || entities.length === 0) return null;

  const candidates = entities
    .filter((e) => e.type === "url" || (e.type === "text_link" && e.url))
    .sort((a, b) => a.offset - b.offset);

  const first = candidates[0];
  if (!first) return null;
  if (first.type === "text_link") return first.url ?? null;
  return text.slice(first.offset, first.offset + first.length);
}

// Finds the first URL in a message: entities first (in text position
// order), falling back to a plain regex scan of the raw text.
export function extractFirstUrl(
  message: Pick<TelegramMessage, "text" | "entities">,
): string | null {
  const text = message.text ?? "";

  const fromEntities = urlFromEntities(text, message.entities);
  if (fromEntities) return fromEntities;

  const match = text.match(URL_REGEX);
  return match ? match[0] : null;
}
