import { assertEquals } from "@std/assert";
import { buildPublishPost, escapeHtml, type PublishPostInput } from "./telegram-post.ts";

Deno.test("escapeHtml: escapes &, <, > and only those three", () => {
  assertEquals(escapeHtml("A & B < C > D"), "A &amp; B &lt; C &gt; D");
  assertEquals(escapeHtml('quotes "stay" as-is'), 'quotes "stay" as-is');
  assertEquals(escapeHtml("plain text"), "plain text");
});

Deno.test("escapeHtml: a title containing '<' can't break the message", () => {
  const escaped = escapeHtml("Report: <script>alert(1)</script> found in the wild");
  assertEquals(escaped.includes("<script>"), false);
  assertEquals(escaped.includes("&lt;script&gt;"), true);
});

function baseInput(overrides: Partial<PublishPostInput> = {}): PublishPostInput {
  return {
    id: "abc-123",
    url: "https://example.com/article",
    source: "example.com",
    title_ru: "Заголовок статьи",
    tldr_ru: "Краткое содержание статьи в двух предложениях.",
    bullets_ru: ["Первый пункт.", "Второй пункт.", "Третий пункт."],
    ...overrides,
  };
}

Deno.test("buildPublishPost: renders title (bold), tldr, bullets, card link, and source line", () => {
  const text = buildPublishPost(baseInput(), "https://clipfeed.example.com");
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(text.includes("Краткое содержание статьи в двух предложениях."), true);
  assertEquals(text.includes("• Первый пункт."), true);
  assertEquals(text.includes("• Второй пункт."), true);
  assertEquals(text.includes("• Третий пункт."), true);
  assertEquals(
    text.includes("Читать полностью → https://clipfeed.example.com/#article-abc-123"),
    true,
  );
  assertEquals(
    text.includes('Источник: <a href="https://example.com/article">example.com</a>'),
    true,
  );
});

Deno.test("buildPublishPost: falls back to the URL's hostname when source is null", () => {
  const text = buildPublishPost(baseInput({ source: null }), "https://clipfeed.example.com");
  assertEquals(
    text.includes('Источник: <a href="https://example.com/article">example.com</a>'),
    true,
  );
});

Deno.test("buildPublishPost: every dynamic value is HTML-escaped, a '<' in the title can't break the message", () => {
  const text = buildPublishPost(
    baseInput({
      title_ru: "Cравнение <лучше> & хуже",
      tldr_ru: "Текст с & и < и >.",
      bullets_ru: ["Пункт с <тегом> внутри."],
    }),
    "https://clipfeed.example.com",
  );
  assertEquals(text.includes("<лучше>"), false);
  assertEquals(text.includes("Cравнение &lt;лучше&gt; &amp; хуже"), true);
  assertEquals(text.includes("Текст с &amp; и &lt; и &gt;."), true);
  assertEquals(text.includes("• Пункт с &lt;тегом&gt; внутри."), true);
});

Deno.test("buildPublishPost: stays within Telegram's 4096-char cap", () => {
  const text = buildPublishPost(
    baseInput({
      tldr_ru: "а".repeat(3000),
      bullets_ru: Array.from({ length: 20 }, (_, i) => `Пункт номер ${i}, довольно длинный.`),
    }),
    "https://clipfeed.example.com",
  );
  assertEquals(text.length <= 4096, true);
});

Deno.test("buildPublishPost: truncates bullets first, keeping the title and link untouched", () => {
  const input = baseInput({
    tldr_ru: "Короткое содержание.",
    bullets_ru: Array.from({ length: 30 }, (_, i) => `Пункт номер ${i} — ${"x".repeat(150)}`),
  });
  const text = buildPublishPost(input, "https://clipfeed.example.com");
  assertEquals(text.length <= 4096, true);
  // Title and link both survive intact — only bullets/tldr were candidates
  // for truncation.
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(text.includes("Короткое содержание."), true);
  assertEquals(
    text.includes("Читать полностью → https://clipfeed.example.com/#article-abc-123"),
    true,
  );
  assertEquals(
    text.includes('Источник: <a href="https://example.com/article">example.com</a>'),
    true,
  );
  // Not every bullet survived — that's the point of the truncation.
  assertEquals(text.includes("Пункт номер 29"), false);
});

// --- Task 31: PUBLIC_BASE_URL unset must never produce a broken link ---

Deno.test("buildPublishPost: an empty publicBaseUrl omits the card link entirely, no broken '/#article-x' text", () => {
  const text = buildPublishPost(baseInput(), "");
  assertEquals(text.includes("Читать полностью"), false);
  assertEquals(text.includes("/#article-abc-123"), false);
  // The rest of the post still renders normally.
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(
    text.includes('Источник: <a href="https://example.com/article">example.com</a>'),
    true,
  );
});

Deno.test("buildPublishPost: a whitespace-only publicBaseUrl is treated the same as empty", () => {
  const text = buildPublishPost(baseInput(), "   ");
  assertEquals(text.includes("Читать полностью"), false);
  assertEquals(text.includes("/#article-abc-123"), false);
});

Deno.test("buildPublishPost: truncates the TL;DR only once bullets are fully exhausted", () => {
  const input = baseInput({
    bullets_ru: [],
    tldr_ru: "я".repeat(4500),
  });
  const text = buildPublishPost(input, "https://clipfeed.example.com");
  assertEquals(text.length <= 4096, true);
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(
    text.includes("Читать полностью → https://clipfeed.example.com/#article-abc-123"),
    true,
  );
  assertEquals(text.endsWith("</a>"), true);
});
