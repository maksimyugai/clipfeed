import { assertEquals } from "@std/assert";
import { digestHeader, failedText, readySuccessText } from "./telegram-strings.ts";

Deno.test("readySuccessText: formats title/tldr/feed link on separate lines", () => {
  assertEquals(
    readySuccessText("Заголовок", "Краткое содержание.", "https://example.com"),
    "✓ Заголовок\n\nКраткое содержание.\n\nhttps://example.com",
  );
});

Deno.test("readySuccessText: omits the feed link entirely when null", () => {
  assertEquals(
    readySuccessText("Заголовок", "Краткое содержание.", null),
    "✓ Заголовок\n\nКраткое содержание.",
  );
});

Deno.test("readySuccessText: truncates to the 4096-char Telegram message limit", () => {
  const longTldr = "а".repeat(5000);
  const text = readySuccessText("Заголовок", longTldr, null);
  assertEquals(text.length, 4096);
  assertEquals(text.endsWith("…"), true);
});

Deno.test("failedText: includes the reason and a retry hint", () => {
  assertEquals(
    failedText("daily-limit"),
    "✗ Не получилось: daily-limit. Retry: открой ленту.",
  );
});

Deno.test("failedText: truncates a very long reason to the message limit", () => {
  const text = failedText("x".repeat(5000));
  assertEquals(text.length, 4096);
});

Deno.test("digestHeader: includes the article count", () => {
  assertEquals(digestHeader(3), "ClipFeed — за сутки: 3 статей");
  assertEquals(digestHeader(1), "ClipFeed — за сутки: 1 статей");
});
