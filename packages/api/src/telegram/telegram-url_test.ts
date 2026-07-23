import { assertEquals } from "@std/assert";
import { extractFirstUrl } from "./telegram-url.ts";
import type { TelegramMessageEntity } from "./telegram-client.ts";

// Builds a "url" entity by locating `url` inside `text`, rather than
// hand-counting offsets — far less error-prone for multi-byte/emoji-free
// ASCII test fixtures like these.
function urlEntity(text: string, url: string): TelegramMessageEntity {
  const offset = text.indexOf(url);
  if (offset === -1) throw new Error(`fixture error: ${JSON.stringify(url)} not found in text`);
  return { type: "url", offset, length: url.length };
}

Deno.test("extractFirstUrl: null when there's no text at all", () => {
  assertEquals(extractFirstUrl({}), null);
});

Deno.test("extractFirstUrl: null for plain text with no URL", () => {
  assertEquals(extractFirstUrl({ text: "just saying hi" }), null);
});

Deno.test("extractFirstUrl: regex fallback finds a bare URL with no entities", () => {
  assertEquals(
    extractFirstUrl({ text: "check this out: https://example.com/article" }),
    "https://example.com/article",
  );
});

Deno.test("extractFirstUrl: a 'url' entity is read from its offset/length", () => {
  const text = "see https://example.com/a for details";
  assertEquals(
    extractFirstUrl({ text, entities: [urlEntity(text, "https://example.com/a")] }),
    "https://example.com/a",
  );
});

Deno.test("extractFirstUrl: a 'text_link' entity uses its hidden url field, not the visible text", () => {
  assertEquals(
    extractFirstUrl({
      text: "click here",
      entities: [{ type: "text_link", offset: 0, length: 10, url: "https://example.com/hidden" }],
    }),
    "https://example.com/hidden",
  );
});

Deno.test("extractFirstUrl: first URL wins when multiple entities are present, regardless of array order", () => {
  const text = "first https://a.example/1 then https://b.example/2";
  const first = urlEntity(text, "https://a.example/1");
  const second = urlEntity(text, "https://b.example/2");
  assertEquals(
    // Deliberately out of text order — offset must decide, not array index.
    extractFirstUrl({ text, entities: [second, first] }),
    "https://a.example/1",
  );
});

Deno.test("extractFirstUrl: first URL wins in the regex fallback when multiple bare URLs appear", () => {
  assertEquals(
    extractFirstUrl({ text: "https://a.example/1 and also https://b.example/2" }),
    "https://a.example/1",
  );
});

Deno.test("extractFirstUrl: entities take priority over the regex fallback", () => {
  const text = "https://regex-would-find.example/x but really https://entity-says.example/y";
  assertEquals(
    extractFirstUrl({
      text,
      entities: [urlEntity(text, "https://entity-says.example/y")],
    }),
    "https://entity-says.example/y",
  );
});

Deno.test("extractFirstUrl: ignores non-url/text_link entities (e.g. bold)", () => {
  const text = "bold word then https://example.com/z";
  assertEquals(
    extractFirstUrl({
      text,
      entities: [{ type: "bold", offset: 0, length: 4 }],
    }),
    "https://example.com/z",
  );
});
