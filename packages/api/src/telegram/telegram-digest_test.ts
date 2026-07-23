import { assertEquals } from "@std/assert";
import { buildDigestMessages } from "./telegram-digest.ts";
import type { DigestArticleInput } from "../articles/db.ts";

Deno.test("buildDigestMessages: empty input returns null", () => {
  assertEquals(buildDigestMessages([], ""), null);
});

Deno.test("buildDigestMessages: single article, header + bullet, no footer when publicBaseUrl is empty", () => {
  const messages = buildDigestMessages(
    [{ title_ru: "Заголовок", tldr_ru: "Первое предложение. Второе предложение." }],
    "",
  );
  assertEquals(messages, [
    "ClipFeed — за сутки: 1 статей\n• Заголовок — Первое предложение.",
  ]);
});

Deno.test("buildDigestMessages: appends the feed URL as a footer when publicBaseUrl is set", () => {
  const messages = buildDigestMessages(
    [{ title_ru: "Заголовок", tldr_ru: "Кратко." }],
    "https://example.com",
  );
  assertEquals(messages, [
    "ClipFeed — за сутки: 1 статей\n• Заголовок — Кратко.\n\nhttps://example.com",
  ]);
});

Deno.test("buildDigestMessages: ignores a whitespace-only publicBaseUrl (no footer)", () => {
  const messages = buildDigestMessages([{ title_ru: "T", tldr_ru: "D." }], "   ");
  assertEquals(messages, ["ClipFeed — за сутки: 1 статей\n• T — D."]);
});

Deno.test("buildDigestMessages: only uses the first sentence of the tldr", () => {
  const messages = buildDigestMessages(
    [{ title_ru: "T", tldr_ru: "Первое. Второе. Третье." }],
    "",
  );
  assertEquals(messages![0].endsWith("T — Первое."), true);
});

Deno.test("buildDigestMessages: multiple articles produce one bullet each, in order", () => {
  const messages = buildDigestMessages(
    [
      { title_ru: "Первая", tldr_ru: "Раз." },
      { title_ru: "Вторая", tldr_ru: "Два." },
    ],
    "",
  );
  assertEquals(
    messages,
    ["ClipFeed — за сутки: 2 статей\n• Первая — Раз.\n• Вторая — Два."],
  );
});

Deno.test("buildDigestMessages: truncates a bullet line longer than ~200 chars", () => {
  const longTitle = "а".repeat(250);
  const messages = buildDigestMessages([{ title_ru: longTitle, tldr_ru: "Кратко." }], "");
  const lines = messages![0].split("\n");
  const bulletLine = lines[1];
  assertEquals(bulletLine.length, 200);
  assertEquals(bulletLine.endsWith("…"), true);
});

Deno.test("buildDigestMessages: splits into multiple messages on bullet boundaries when over 4096 chars, footer only on the last", () => {
  const articles: DigestArticleInput[] = Array.from({ length: 40 }, (_, i) => ({
    title_ru: `Заголовок статьи номер ${i} с некоторым текстом для длины строки`,
    tldr_ru: `Выжимка статьи номер ${i} с деталями и подробностями для длины строки.`,
  }));

  const messages = buildDigestMessages(articles, "https://example.com");
  assertEquals(messages !== null, true);
  const list = messages!;
  assertEquals(list.length > 1, true);

  for (const message of list) {
    assertEquals(message.length <= 4096, true);
  }

  // Every bullet line appears intact, whole, in exactly one message.
  const allBulletLines = list.flatMap((m) => m.split("\n").filter((l) => l.startsWith("• ")));
  assertEquals(allBulletLines.length, articles.length);

  // Footer only on the last message.
  assertEquals(list[list.length - 1].endsWith("https://example.com"), true);
  for (const message of list.slice(0, -1)) {
    assertEquals(message.includes("https://example.com"), false);
  }
});
