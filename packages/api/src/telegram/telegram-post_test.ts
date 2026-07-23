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

// Counts every `<a href=` occurrence in the message — the Task 32 Part B
// invariant is that the message contains AT MOST one link (the ClipFeed
// card), so Telegram's crawler can only ever build its preview from that
// one URL, never the original source.
function linkCount(text: string): number {
  return (text.match(/<a href=/g) ?? []).length;
}

Deno.test("buildPublishPost: renders title (bold), tldr, bullets, a single card link, and a plain-text source line", () => {
  const text = buildPublishPost(baseInput(), "https://clipfeed.example.com");
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(text.includes("Краткое содержание статьи в двух предложениях."), true);
  assertEquals(text.includes("• Первый пункт."), true);
  assertEquals(text.includes("• Второй пункт."), true);
  assertEquals(text.includes("• Третий пункт."), true);
  assertEquals(
    text.includes(
      'Читать полностью → <a href="https://clipfeed.example.com/a/abc-123">https://clipfeed.example.com/a/abc-123</a>',
    ),
    true,
  );
  assertEquals(text.includes("Источник: example.com"), true);
  assertEquals(linkCount(text), 1);
});

Deno.test("buildPublishPost: the source line is plain text — no <a>, even though the original article URL is known", () => {
  const text = buildPublishPost(baseInput(), "https://clipfeed.example.com");
  assertEquals(text.includes("https://example.com/article"), false);
  assertEquals(text.includes(`Источник: <a`), false);
});

Deno.test("buildPublishPost: falls back to the URL's hostname when source is null", () => {
  const text = buildPublishPost(baseInput({ source: null }), "https://clipfeed.example.com");
  assertEquals(text.includes("Источник: example.com"), true);
  assertEquals(linkCount(text), 1);
});

Deno.test("buildPublishPost: every dynamic value is HTML-escaped, a '<' in the title can't break the message", () => {
  const text = buildPublishPost(
    baseInput({
      title_ru: "Cравнение <лучше> & хуже",
      tldr_ru: "Текст с & и < и >.",
      bullets_ru: ["Пункт с <тегом> внутри."],
      source: "example<.com",
    }),
    "https://clipfeed.example.com",
  );
  assertEquals(text.includes("<лучше>"), false);
  assertEquals(text.includes("Cравнение &lt;лучше&gt; &amp; хуже"), true);
  assertEquals(text.includes("Текст с &amp; и &lt; и &gt;."), true);
  assertEquals(text.includes("• Пункт с &lt;тегом&gt; внутри."), true);
  assertEquals(text.includes("Источник: example&lt;.com"), true);
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
    text.includes('<a href="https://clipfeed.example.com/a/abc-123">'),
    true,
  );
  assertEquals(text.includes("Источник: example.com"), true);
  // Not every bullet survived — that's the point of the truncation.
  assertEquals(text.includes("Пункт номер 29"), false);
});

// --- Task 31 (updated for the Task 32 Part B reformat): PUBLIC_BASE_URL
// unset must never produce a broken link ---

Deno.test("buildPublishPost: an empty publicBaseUrl omits the card link entirely, no broken relative href", () => {
  const text = buildPublishPost(baseInput(), "");
  assertEquals(text.includes("Читать полностью"), false);
  assertEquals(text.includes("/a/abc-123"), false);
  assertEquals(text.includes("/#"), false);
  assertEquals(linkCount(text), 0);
  // The rest of the post still renders normally.
  assertEquals(text.startsWith("<b>Заголовок статьи</b>\n\n"), true);
  assertEquals(text.includes("Источник: example.com"), true);
});

Deno.test("buildPublishPost: a whitespace-only publicBaseUrl is treated the same as empty", () => {
  const text = buildPublishPost(baseInput(), "   ");
  assertEquals(text.includes("Читать полностью"), false);
  assertEquals(text.includes("/a/abc-123"), false);
  assertEquals(linkCount(text), 0);
});

Deno.test("buildPublishPost: no published message can ever contain a bare '/#' hash-fragment reference", () => {
  // Regression guard for the pre-Task-32 format, which linked to
  // "/#article-<id>" — a hash fragment Telegram's crawler can never see.
  for (const publicBaseUrl of ["https://clipfeed.example.com", "", "   "]) {
    const text = buildPublishPost(baseInput(), publicBaseUrl);
    assertEquals(text.includes("/#"), false);
  }
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
    text.includes('<a href="https://clipfeed.example.com/a/abc-123">'),
    true,
  );
  assertEquals(text.endsWith("Источник: example.com"), true);
  assertEquals(linkCount(text), 1);
});
