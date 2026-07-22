import "./env.d.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  buildAnthropicRequest,
  buildSystemPrompt,
  callLlm,
  DEFAULT_RELAXED_SPEC,
  DEFAULT_STRICT_SPEC,
  DEFAULT_SUMMARY_BODY_TARGET_CHARS,
  deriveSummarySpec,
  FEW_SHOT_EXAMPLE_SUMMARY,
  parseSummaryBodyTargetChars,
  parseSummaryJson,
  parseWorkersAiResult,
  renderSummaryMarkdown,
  repairDuplicateBullets,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
  type SummarySpec,
  validateSummary,
  withTimeout,
} from "./summarize.ts";
import type { SummaryJson } from "@clipfeed/shared/types";

function makeStubAi(handler: (model: string, input: Record<string, unknown>) => unknown): Ai {
  return {
    run(model: string, input: unknown): Promise<unknown> {
      return Promise.resolve(handler(model, input as Record<string, unknown>));
    },
  };
}

// Meets validateSummary's content bar at the DEFAULT spec (>=180 char
// tldrs, 4-7 bullets each 40-220 chars, 2-3 body paragraphs each 288-768
// chars, none duplicating the tldr, 1-6 tags) so it round-trips through
// both the shape-only parsers and the full summarizeArticle*
// validate-and-retry path used throughout this file.
const VALID_SUMMARY = {
  title_ru: "Компания подняла цену подписки на 60% с 1 сентября",
  title_en: "Company Raises Subscription Price 60% Starting September 1",
  tldr_ru:
    "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса, а годовые подписчики получат отсрочку до продления плана.",
  tldr_en:
    "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs. The change affects roughly 2 million subscribers, though annual-plan subscribers get a grace period until renewal.",
  body_ru: [
    "Компания объявила об изменении во вторник, уточнив, что новый тариф вступит в силу с 1 сентября. Рост стоимости составляет почти 60% по сравнению с текущей ценой. Затронутыми окажутся примерно 2 миллиона подписчиков сервиса, при этом клиенты, уже оформившие годовой план, не почувствуют изменения сразу.",
    "В компании ссылаются на растущие расходы на серверную инфраструктуру и сетевой трафик как на основную причину решения. Руководство отмечало, что откладывало повышение более года, опасаясь навредить клиентам из малого бизнеса, но в итоге пришло к выводу, что дальнейшая отсрочка невозможна из-за продолжающегося роста издержек.",
  ],
  body_en: [
    "The company announced the change on Tuesday, confirming the new rate takes effect September 1. The increase amounts to nearly 60% over the current price. Roughly 2 million subscribers are affected, though customers already on an annual plan won't see the new rate right away, since their existing terms carry over until renewal.",
    "Executives point to climbing server infrastructure and network costs as the primary driver behind the decision. Leadership has said it held off on the increase for over a year out of concern for small-business customers, but ultimately concluded further delay wasn't sustainable given the pace of rising expenses.",
  ],
  bullets_ru: [
    "Те, кто уже на годовом плане, сохранят старую цену до момента продления плана.",
    "Компания откладывала повышение цены более года из опасений навредить малому бизнесу.",
    "Решение было принято только после того, как расходы на инфраструктуру продолжили расти.",
    "Ни один из конкурентов пока не объявлял о похожем шаге.",
  ],
  bullets_en: [
    "Existing annual-plan subscribers keep their price until their plan comes up for renewal.",
    "The company delayed the increase for over a year out of concern for small businesses.",
    "Leadership only moved forward once infrastructure costs kept climbing regardless.",
    "No competitor has announced a comparable price change so far.",
  ],
  tags: ["технологии", "google"],
  lang_original: "en",
};

Deno.test("parseSummaryJson: valid plain JSON", () => {
  const result = parseSummaryJson(JSON.stringify(VALID_SUMMARY));
  assertEquals(result, VALID_SUMMARY);
});

Deno.test("parseSummaryJson: fenced JSON is unwrapped", () => {
  const fenced = "```json\n" + JSON.stringify(VALID_SUMMARY) + "\n```";
  const result = parseSummaryJson(fenced);
  assertEquals(result, VALID_SUMMARY);
});

Deno.test("parseSummaryJson: plain fence without language tag", () => {
  const fenced = "```\n" + JSON.stringify(VALID_SUMMARY) + "\n```";
  const result = parseSummaryJson(fenced);
  assertEquals(result, VALID_SUMMARY);
});

Deno.test("parseSummaryJson: broken JSON returns null", () => {
  assertEquals(parseSummaryJson("not json at all"), null);
});

Deno.test("parseSummaryJson: missing required field returns null", () => {
  const { tags: _tags, ...withoutTags } = VALID_SUMMARY;
  assertEquals(parseSummaryJson(JSON.stringify(withoutTags)), null);
});

Deno.test("parseSummaryJson: wrong field type returns null", () => {
  const broken = { ...VALID_SUMMARY, bullets_en: "not an array" };
  assertEquals(parseSummaryJson(JSON.stringify(broken)), null);
});

Deno.test("buildAnthropicRequest: direct mode targets api.anthropic.com with x-api-key", () => {
  const { url, headers } = buildAnthropicRequest({ apiKey: "sk-test", model: "test-model" });
  assertEquals(url, "https://api.anthropic.com/v1/messages");
  assertEquals(headers["x-api-key"], "sk-test");
  assertEquals(headers["cf-aig-authorization"], undefined);
  assertEquals(headers["anthropic-version"], "2023-06-01");
});

Deno.test("buildAnthropicRequest: direct mode with no apiKey sends an empty x-api-key", () => {
  const { headers } = buildAnthropicRequest({ model: "test-model" });
  assertEquals(headers["x-api-key"], "");
});

Deno.test("buildAnthropicRequest: gateway mode targets the gateway URL with cf-aig-authorization, no x-api-key", () => {
  const { url, headers } = buildAnthropicRequest({
    aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
    aiGatewayToken: "gw-token",
    model: "test-model",
  });
  assertEquals(url, "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic/v1/messages");
  assertEquals(headers["cf-aig-authorization"], "Bearer gw-token");
  assertEquals(headers["x-api-key"], undefined);
});

Deno.test("buildAnthropicRequest: gateway mode strips a trailing slash on the base URL", () => {
  const { url } = buildAnthropicRequest({
    aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic/",
    model: "test-model",
  });
  assertEquals(url, "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic/v1/messages");
});

Deno.test("buildAnthropicRequest: gateway mode also sends x-api-key when an apiKey is configured (BYOK passthrough)", () => {
  const { headers } = buildAnthropicRequest({
    aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
    apiKey: "sk-passthrough",
    model: "test-model",
  });
  assertEquals(headers["x-api-key"], "sk-passthrough");
});

Deno.test("buildAnthropicRequest: gateway mode without a token omits cf-aig-authorization (public gateway)", () => {
  const { headers } = buildAnthropicRequest({
    aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
    model: "test-model",
  });
  assertEquals(headers["cf-aig-authorization"], undefined);
});

Deno.test("summarizeArticle: gateway-shaped error body is surfaced distinctly from a provider error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10001, message: "Authentication error" }],
        }),
        { status: 401 },
      ),
    )) as typeof fetch;

  try {
    await assertRejects(
      () =>
        summarizeArticle(
          {
            aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
            aiGatewayToken: "bad-token",
            model: "test-model",
          },
          "Title",
          "Body text",
        ),
      Error,
      "ai gateway error (401): Authentication error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: provider error proxied through the gateway is not mislabeled as a gateway error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401 },
      ),
    )) as typeof fetch;

  try {
    await assertRejects(
      () =>
        summarizeArticle(
          {
            aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
            aiGatewayToken: "gw-token",
            apiKey: "bad-key",
            model: "test-model",
          },
          "Title",
          "Body text",
        ),
      Error,
      "anthropic api error (401): invalid x-api-key",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("renderSummaryMarkdown: formats tldr and bullets", () => {
  const md = renderSummaryMarkdown("Short summary.", ["First", "Second"]);
  assertEquals(md, "**TL;DR** Short summary.\n\n- First\n- Second");
});

Deno.test("summarizeArticle: succeeds on the first response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "test-key", model: "test-model" },
      "Title",
      "Body text",
    );
    assertEquals(result, VALID_SUMMARY);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- priorViolations: informed retry across separate pipeline runs (Task 26.5) ---

Deno.test("summarizeArticle: priorViolations reaches the FIRST attempt's user message", async () => {
  const originalFetch = globalThis.fetch;
  let capturedFirstBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    capturedFirstBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "test-key", model: "test-model" },
      "Title",
      "Body text",
      DEFAULT_SUMMARY_BODY_TARGET_CHARS,
      "bullets_ru[0] duplicates the tldr instead of adding new detail",
    );
    assertEquals(result, VALID_SUMMARY);
    const firstMessage = capturedFirstBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("A previous attempt failed validation with:"), true);
    assertEquals(
      firstMessage.includes("bullets_ru[0] duplicates the tldr instead of adding new detail"),
      true,
    );
    assertEquals(
      firstMessage.includes("replace it with a DIFFERENT concrete fact from the article"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: no priorViolations passed -> no corrective note on the first attempt", async () => {
  const originalFetch = globalThis.fetch;
  let capturedFirstBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    capturedFirstBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    await summarizeArticle({ apiKey: "test-key", model: "test-model" }, "Title", "Body text");
    const firstMessage = capturedFirstBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("A previous attempt failed validation"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: priorViolations longer than 300 chars is truncated before reaching the prompt", async () => {
  const originalFetch = globalThis.fetch;
  let capturedFirstBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    capturedFirstBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const longViolation = "x".repeat(500);
  try {
    await summarizeArticle(
      { apiKey: "test-key", model: "test-model" },
      "Title",
      "Body text",
      DEFAULT_SUMMARY_BODY_TARGET_CHARS,
      longViolation,
    );
    const firstMessage = capturedFirstBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("x".repeat(300)), true);
    assertEquals(firstMessage.includes("x".repeat(301)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticleWithWorkersAi: priorViolations reaches the FIRST attempt's user message", async () => {
  const ai = makeStubAi((_model, input) => {
    const userMessage = (input.messages as { role: string; content: string }[]).find(
      (m) => m.role === "user",
    )?.content ?? "";
    if (!userMessage.includes("A previous attempt failed validation with:")) {
      throw new Error("expected priorViolations note on the first attempt");
    }
    return { response: VALID_SUMMARY };
  });

  const result = await summarizeArticleWithWorkersAi(
    ai,
    "test-model",
    "Title",
    "Body text",
    DEFAULT_SUMMARY_BODY_TARGET_CHARS,
    "tldr_ru must be at least 150 characters (got 12)",
  );
  assertEquals(result, VALID_SUMMARY);
});

Deno.test("summarizeArticle: retries once on broken output, then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    const text = calls === 1 ? "not valid json" : JSON.stringify(VALID_SUMMARY);
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "test-key", model: "test-model" },
      "Title",
      "Body text",
    );
    assertEquals(result, VALID_SUMMARY);
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: fails after two broken responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "still not json" }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    await assertRejects(
      () => summarizeArticle({ apiKey: "test-key", model: "test-model" }, "Title", "Body text"),
      Error,
      "summary validation: response did not match the required JSON schema",
    );
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: retry-exhausted schema failure is reported the same way regardless of mode (gateway)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "still not json" }] }),
        { status: 200 },
      ),
    )) as typeof fetch;

  try {
    await assertRejects(
      () =>
        summarizeArticle(
          {
            aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
            aiGatewayToken: "gw-token",
            model: "test-model",
          },
          "Title",
          "Body text",
        ),
      Error,
      "summary validation: response did not match the required JSON schema",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: missing text content is prefixed per mode (direct)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    )) as typeof fetch;

  try {
    await assertRejects(
      () => summarizeArticle({ apiKey: "test-key", model: "test-model" }, "Title", "Body text"),
      Error,
      "anthropic api error: response had no text content",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: missing text content is prefixed per mode (gateway)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    )) as typeof fetch;

  try {
    await assertRejects(
      () =>
        summarizeArticle(
          {
            aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
            aiGatewayToken: "gw-token",
            model: "test-model",
          },
          "Title",
          "Body text",
        ),
      Error,
      "ai gateway error: response had no text content",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Workers AI mode ---

// Also meets validateSummary's content bar — see VALID_SUMMARY above for why.
const VALID_SUMMARY_2 = {
  title_ru: "Разработчики выпустили новую версию с поддержкой офлайн-режима",
  title_en: "Developers Ship New Version With Offline Mode Support",
  tldr_ru:
    "Команда выпустила версию 4.0 с поддержкой офлайн-режима, позволяющей работать без подключения к интернету. Синхронизация данных происходит автоматически при восстановлении сети, а конфликты правок разрешаются автоматически по времени сохранения.",
  tldr_en:
    "The team shipped version 4.0 with offline mode support, letting users work without an internet connection. Data syncs automatically once the connection is restored, and edit conflicts are resolved automatically by save time.",
  body_ru: [
    "Новая версия позволяет продолжать работу даже без подключения к интернету, сохраняя все изменения локально до восстановления связи. Как только соединение появляется снова, приложение автоматически синхронизирует накопленные изменения с сервером без участия пользователя, обычно в течение нескольких секунд после восстановления сети.",
    "Локальный кеш на устройстве ограничен объёмом в 500 мегабайт, чего разработчики считают достаточным для типичного сценария использования в течение нескольких дней офлайн-работы. Если во время автономной работы возникает конфликт правок между устройствами, система разрешает его в пользу версии с более поздней меткой сохранения.",
  ],
  body_en: [
    "The new version lets people keep working even without an internet connection, storing every change locally until connectivity returns. As soon as the connection comes back, the app automatically syncs the accumulated changes to the server without any user action required, usually within a few seconds of the network coming back online.",
    "The on-device local cache is capped at 500 megabytes, which the developers consider enough for a typical multi-day offline session. If an edit conflict arises between devices during offline work, the system resolves it in favor of whichever version has the later save timestamp. The update is available to all users at no cost and installs automatically.",
  ],
  bullets_ru: [
    "Локальный кеш ограничен объёмом 500 мегабайт на одно устройство.",
    "Конфликты правок разрешаются в пользу более поздней сохранённой версии.",
    "Синхронизация запускается автоматически сразу после восстановления связи.",
    "Обновление доступно всем пользователям бесплатно и без отдельной оплаты.",
  ],
  bullets_en: [
    "The local cache is capped at 500 megabytes per device.",
    "Edit conflicts resolve in favor of the most recently saved version.",
    "Syncing kicks off automatically as soon as connectivity returns.",
    "The update is available to every user at no additional cost.",
  ],
  tags: ["новости"],
  lang_original: "ru",
};

Deno.test("parseWorkersAiResult: plain string response", () => {
  assertEquals(parseWorkersAiResult(JSON.stringify(VALID_SUMMARY_2)), VALID_SUMMARY_2);
});

Deno.test("parseWorkersAiResult: { response: string } wrapper", () => {
  assertEquals(
    parseWorkersAiResult({ response: JSON.stringify(VALID_SUMMARY_2) }),
    VALID_SUMMARY_2,
  );
});

Deno.test("parseWorkersAiResult: { response: object } wrapper (json_schema honored)", () => {
  assertEquals(parseWorkersAiResult({ response: VALID_SUMMARY_2 }), VALID_SUMMARY_2);
});

Deno.test("parseWorkersAiResult: bare object with no response wrapper", () => {
  assertEquals(parseWorkersAiResult(VALID_SUMMARY_2), VALID_SUMMARY_2);
});

Deno.test("parseWorkersAiResult: broken string returns null", () => {
  assertEquals(parseWorkersAiResult("not json"), null);
});

Deno.test("parseWorkersAiResult: object missing a required field returns null", () => {
  const { tags: _tags, ...withoutTags } = VALID_SUMMARY_2;
  assertEquals(parseWorkersAiResult({ response: withoutTags }), null);
});

Deno.test("parseWorkersAiResult: non-object, non-string results are null", () => {
  assertEquals(parseWorkersAiResult(null), null);
  assertEquals(parseWorkersAiResult(undefined), null);
  assertEquals(parseWorkersAiResult(42), null);
});

Deno.test("summarizeArticleWithWorkersAi: succeeds with response_format honored (object response)", async () => {
  let calls = 0;
  const ai = makeStubAi((_model, input) => {
    calls += 1;
    assertEquals(typeof input.response_format, "object");
    return { response: VALID_SUMMARY_2 };
  });

  const result = await summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text");
  assertEquals(result, VALID_SUMMARY_2);
  assertEquals(calls, 1);
});

Deno.test("summarizeArticleWithWorkersAi: succeeds with a plain string response", async () => {
  const ai = makeStubAi(() => ({ response: JSON.stringify(VALID_SUMMARY_2) }));
  const result = await summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text");
  assertEquals(result, VALID_SUMMARY_2);
});

Deno.test("summarizeArticleWithWorkersAi: falls back to plain messages when response_format is rejected", async () => {
  let calls = 0;
  const ai = makeStubAi((_model, input) => {
    calls += 1;
    if (input.response_format) {
      throw new Error("response_format is not supported by this model");
    }
    return { response: JSON.stringify(VALID_SUMMARY_2) };
  });

  const result = await summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text");
  assertEquals(result, VALID_SUMMARY_2);
  assertEquals(calls, 2); // schema attempt (throws) + plain fallback (succeeds)
});

Deno.test("summarizeArticleWithWorkersAi: retries once on broken output, then succeeds", async () => {
  let calls = 0;
  const ai = makeStubAi(() => {
    calls += 1;
    if (calls === 1) return { response: "not valid json" };
    return { response: VALID_SUMMARY_2 };
  });

  const result = await summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text");
  assertEquals(result, VALID_SUMMARY_2);
  assertEquals(calls, 2);
});

Deno.test("summarizeArticleWithWorkersAi: fails after two broken responses with a schema violation", async () => {
  let calls = 0;
  const ai = makeStubAi(() => {
    calls += 1;
    return { response: "still not json" };
  });

  await assertRejects(
    () => summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text"),
    Error,
    "summary validation: response did not match the required JSON schema",
  );
  assertEquals(calls, 2);
});

Deno.test("summarizeArticleWithWorkersAi: a hard binding failure surfaces as a workers-ai-prefixed error", async () => {
  const ai = makeStubAi(() => {
    throw new Error("binding call failed: model not found");
  });

  await assertRejects(
    () => summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text"),
    Error,
    "workers ai error: Error: binding call failed: model not found",
  );
});

// --- callLlm: shared transport used by both summarization and ranking ---

function makeLlmEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called for this branch");
      },
    },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
    DIGEST_HOUR_UTC: "6",
    PUBLIC_BASE_URL: "",
    ...overrides,
  };
}

Deno.test("callLlm: gateway mode posts system/user/max_tokens to the gateway URL, returns raw text", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = input.toString();
    capturedBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: "text", text: '["a","b"]' }] }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  try {
    const env = makeLlmEnv({
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/clipfeed/anthropic",
      CF_AIG_TOKEN: "gw-token",
    });
    const text = await callLlm("gateway", env, "sys prompt", "user prompt", 200);
    assertEquals(text, '["a","b"]');
    assertEquals(
      capturedUrl,
      "https://gateway.ai.cloudflare.com/v1/acct/clipfeed/anthropic/v1/messages",
    );
    assertEquals(capturedBody.system, "sys prompt");
    assertEquals(capturedBody.max_tokens, 200);
    assertEquals(capturedBody.messages, [{ role: "user", content: "user prompt" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callLlm: direct mode posts to api.anthropic.com", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    capturedUrl = input.toString();
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    const env = makeLlmEnv({ ANTHROPIC_API_KEY: "sk-direct" });
    const text = await callLlm("direct", env, "sys", "user", 200);
    assertEquals(text, "ok");
    assertEquals(capturedUrl, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callLlm: workers-ai mode calls env.AI.run with messages+max_tokens (no response_format), returns raw text", async () => {
  let capturedInput: Record<string, unknown> = {};
  const env = makeLlmEnv({
    AI: {
      run(model: string, input: unknown): Promise<unknown> {
        capturedInput = input as Record<string, unknown>;
        assertEquals(model, "test-workers-ai-model");
        return Promise.resolve({ response: '["x"]' });
      },
    },
  });

  const text = await callLlm("workers-ai", env, "sys", "user", 200);
  assertEquals(text, '["x"]');
  assertEquals(capturedInput.max_tokens, 200);
  assertEquals("response_format" in capturedInput, false);
  assertEquals(capturedInput.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "user" },
  ]);
});

Deno.test("callLlm: workers-ai binding failure surfaces as a workers-ai-prefixed error", async () => {
  const env = makeLlmEnv({
    AI: {
      run(): Promise<unknown> {
        throw new Error("boom");
      },
    },
  });

  await assertRejects(
    () => callLlm("workers-ai", env, "sys", "user", 200),
    Error,
    "workers ai error: Error: boom",
  );
});

// --- withTimeout: the core timing/racing mechanism, unit-tested directly
// with small ms values so the suite doesn't have to wait out the real
// 90s LLM_CALL_TIMEOUT_MS to exercise it. ---

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

Deno.test("withTimeout: resolves with the inner promise's value when it settles first", async () => {
  const result = await withTimeout(Promise.resolve("done"), 50, "should not fire");
  assertEquals(result, "done");
});

Deno.test("withTimeout: rejects with the inner promise's error when it rejects first", async () => {
  await assertRejects(
    () => withTimeout(Promise.reject(new Error("inner failure")), 50, "should not fire"),
    Error,
    "inner failure",
  );
});

Deno.test("withTimeout: rejects with the given message once ms elapses without the inner promise settling", async () => {
  await assertRejects(
    () => withTimeout(neverResolves(), 10, "timed out after 10ms"),
    Error,
    "timed out after 10ms",
  );
});

Deno.test("withTimeout: a fast inner promise wins even when the race is close", async () => {
  const fast = new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 5));
  const result = await withTimeout(fast, 200, "should not fire");
  assertEquals(result, "fast");
});

// --- Timeout wiring at each call site — simulate what a real timeout
// produces (an AbortError for fetch, the withTimeout message for the AI
// binding) without waiting out the real 45s. ---

Deno.test("callAnthropic (via summarizeArticle): an aborted fetch is reported as a timeout, per-mode prefixed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }) as typeof fetch;

  try {
    await assertRejects(
      () => summarizeArticle({ apiKey: "sk-direct", model: "test-model" }, "Title", "Body"),
      Error,
      "anthropic api error: timed out after 90000ms",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callAnthropic (via summarizeArticle): gateway mode prefixes the timeout as 'ai gateway error'", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        summarizeArticle(
          {
            aiGatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/clipfeed/anthropic",
            model: "test-model",
          },
          "Title",
          "Body",
        ),
      Error,
      "ai gateway error: timed out after 90000ms",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callAnthropic: a non-abort fetch error is not mislabeled as a timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("DNS resolution failed"))) as typeof fetch;

  try {
    await assertRejects(
      () => summarizeArticle({ apiKey: "sk-direct", model: "test-model" }, "Title", "Body"),
      Error,
      "DNS resolution failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runWorkersAi (via summarizeArticleWithWorkersAi): a timeout-shaped rejection is reported as a workers-ai-prefixed timeout", async () => {
  // Stubs what withTimeout(ai.run(...), 90000, "timed out after 90000ms")
  // rejects with once the race actually loses (see the withTimeout tests
  // above for proof the race itself works) — checks that the resulting
  // message threads through runWorkersAi's error-wrapping the same way any
  // other ai.run() failure does, without waiting out the real 45s.
  const ai = makeStubAi(() => {
    throw new Error("timed out after 90000ms");
  });

  await assertRejects(
    () => summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text"),
    Error,
    "workers ai error: Error: timed out after 90000ms",
  );
});

// --- validateSummary: the content-quality bar applied after shape parsing ---

function makeValidSummary(overrides: Partial<SummaryJson> = {}): SummaryJson {
  return {
    title_ru: "Компания подняла цену подписки на 60% с 1 сентября",
    title_en: "Company Raises Subscription Price 60% Starting September 1",
    tldr_ru:
      "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса, а годовые подписчики получат отсрочку до продления плана.",
    tldr_en:
      "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs. The change affects roughly 2 million subscribers, though annual-plan subscribers get a grace period until renewal.",
    body_ru: [
      "Компания объявила об изменении во вторник, уточнив, что новый тариф вступит в силу с 1 сентября. Рост стоимости составляет почти 60% по сравнению с текущей ценой. Затронутыми окажутся примерно 2 миллиона подписчиков сервиса, при этом клиенты, уже оформившие годовой план, не почувствуют изменения сразу.",
      "В компании ссылаются на растущие расходы на серверную инфраструктуру и сетевой трафик как на основную причину решения. Руководство отмечало, что откладывало повышение более года, опасаясь навредить клиентам из малого бизнеса, но в итоге пришло к выводу, что дальнейшая отсрочка невозможна из-за продолжающегося роста издержек.",
    ],
    body_en: [
      "The company announced the change on Tuesday, confirming the new rate takes effect September 1. The increase amounts to nearly 60% over the current price. Roughly 2 million subscribers are affected, though customers already on an annual plan won't see the new rate right away, since their existing terms carry over until renewal.",
      "Executives point to climbing server infrastructure and network costs as the primary driver behind the decision. Leadership has said it held off on the increase for over a year out of concern for small-business customers, but ultimately concluded further delay wasn't sustainable given the pace of rising expenses.",
    ],
    bullets_ru: [
      "Те, кто уже на годовом плане, сохранят старую цену до момента продления плана.",
      "Компания откладывала повышение цены более года из опасений навредить малому бизнесу.",
      "Решение было принято только после того, как расходы на инфраструктуру продолжили расти.",
      "Ни один из конкурентов пока не объявлял о похожем шаге.",
    ],
    bullets_en: [
      "Existing annual-plan subscribers keep their price until their plan comes up for renewal.",
      "The company delayed the increase for over a year out of concern for small businesses.",
      "Leadership only moved forward once infrastructure costs kept climbing regardless.",
      "No competitor has announced a comparable price change so far.",
    ],
    tags: ["technology", "pricing"],
    lang_original: "en",
    ...overrides,
  };
}

Deno.test("validateSummary: a well-formed summary passes with no violations", () => {
  const result = validateSummary(makeValidSummary());
  assertEquals(result.ok, true);
});

Deno.test("validateSummary: null (shape failure) is reported as a single schema violation", () => {
  const result = validateSummary(null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations, ["response did not match the required JSON schema"]);
  }
});

Deno.test("validateSummary: empty title is a violation", () => {
  const result = validateSummary(makeValidSummary({ title_ru: "" }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.violations.some((v) => v.includes("title_ru")), true);
});

Deno.test("validateSummary: title over 120 chars is a violation", () => {
  const result = validateSummary(makeValidSummary({ title_en: "x".repeat(121) }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("title_en") && v.includes("120")),
      true,
    );
  }
});

Deno.test("validateSummary: title at exactly 120 chars is fine (boundary)", () => {
  const result = validateSummary(makeValidSummary({ title_en: "x".repeat(120) }));
  assertEquals(result.ok, true);
});

Deno.test("validateSummary: tldr under the default STRICT minimum (150 chars) is a violation", () => {
  const result = validateSummary(makeValidSummary({ tldr_ru: "Слишком коротко." }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("tldr_ru") && v.includes("150")),
      true,
    );
  }
});

Deno.test("validateSummary: tldr at exactly 150 chars is fine, 149 is a violation (boundary)", () => {
  const at150 = validateSummary(makeValidSummary({ tldr_en: "x".repeat(150) }));
  assertEquals(at150.ok, true);
  const at149 = validateSummary(makeValidSummary({ tldr_en: "x".repeat(149) }));
  assertEquals(at149.ok, false);
});

Deno.test("validateSummary: fewer than 4 bullets is a violation", () => {
  const result = validateSummary(
    makeValidSummary({
      bullets_ru: [
        "Один пункт длиннее сорока символов для проверки.",
        "Второй пункт тоже достаточно длинный для правил.",
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("bullets_ru") && v.includes("4")), true);
  }
});

Deno.test("validateSummary: more than 7 bullets is a violation", () => {
  const bullets = Array.from(
    { length: 8 },
    (_, i) => `Пункт номер ${i} с вполне достаточной длиной текста для проверки.`,
  );
  const result = validateSummary(makeValidSummary({ bullets_ru: bullets }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("bullets_ru") && v.includes("7")), true);
  }
});

Deno.test("validateSummary: exactly 4 and exactly 7 bullets are both fine (boundaries)", () => {
  const four = validateSummary(
    makeValidSummary({
      bullets_en: [
        "First concrete fact goes here now for the reader.",
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(four.ok, true, JSON.stringify(!four.ok ? four.violations : []));

  const seven = validateSummary(
    makeValidSummary({
      bullets_en: Array.from(
        { length: 7 },
        (_, i) => `Concrete fact number ${i} in the list for the reader to scan quickly.`,
      ),
    }),
  );
  assertEquals(seven.ok, true, JSON.stringify(!seven.ok ? seven.violations : []));
});

Deno.test("validateSummary: a bullet under 40 chars is a violation", () => {
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        "Too short.",
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[0]") && v.includes("40")),
      true,
    );
  }
});

Deno.test("validateSummary: a bullet moderately over the 220-char soft max (221-330) PASSES, not a violation", () => {
  // Task 19 Part A: moderate overshoot no longer fails validation — only
  // undershoot is a real quality problem. 221 clears the soft max (220) but
  // stays within the hard max (330).
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        "x".repeat(221),
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("validateSummary: a bullet over the 330-char hard max (220 * 1.5) is a violation", () => {
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        "x".repeat(331),
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[0]") && v.includes("330")),
      true,
    );
  }
});

Deno.test("validateSummary: a bullet duplicating the tldr (>=80% word overlap) is a violation", () => {
  const tldr =
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon, according to a statement released to reporters on Tuesday afternoon this week.";
  const duplicateBullet =
    "The company is raising its subscription price from five dollars to eight.";
  const result = validateSummary(
    makeValidSummary({
      tldr_en: tldr,
      bullets_en: [
        duplicateBullet,
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[0]") && v.includes("duplicates")),
      true,
    );
  }
});

Deno.test("validateSummary: a bullet sharing only a few words with the tldr is NOT flagged as a duplicate", () => {
  const result = validateSummary(makeValidSummary());
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

// --- Task 34 Part A: deterministic bullet repair (repairDuplicateBullets) ---
// See summarize.ts's doc comment on repairDuplicateBullets for the full
// history/rationale: prompt-level enforcement of this nit isn't achievable,
// so it's fixed deterministically instead of failing an otherwise-correct
// summary.

Deno.test("repairDuplicateBullets: no duplicates -> unchanged, not repaired", () => {
  const bullets = [
    "First distinct fact about the story with its own vocabulary.",
    "Second distinct fact about the story with its own vocabulary.",
  ];
  const result = repairDuplicateBullets(bullets, "An unrelated tldr sentence entirely.", 2);
  assertEquals(result, { bullets, droppedIndexes: [], repaired: false });
});

Deno.test("repairDuplicateBullets: drops a duplicate and keeps first-occurrence order when the remaining count meets the minimum", () => {
  const tldr =
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon.";
  const duplicate = "The company is raising its subscription price from five dollars to eight.";
  const bullets = [
    "First distinct fact about servers and infrastructure spending growth.",
    duplicate,
    "Third distinct fact about small business customer concerns raised.",
    "Fourth distinct fact about competitor pricing moves this year.",
    "Fifth distinct fact about annual plan renewal timing details.",
  ];
  const result = repairDuplicateBullets(bullets, tldr, 4);
  assertEquals(result.repaired, true);
  assertEquals(result.droppedIndexes, [1]);
  assertEquals(result.bullets, [bullets[0], bullets[2], bullets[3], bullets[4]]);
});

Deno.test("repairDuplicateBullets: drops MULTIPLE duplicates, preserving the order of survivors", () => {
  const tldr =
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon.";
  const duplicate = "The company is raising its subscription price from five dollars to eight.";
  const bullets = [
    duplicate,
    "First distinct fact about servers and infrastructure spending growth.",
    duplicate,
    "Second distinct fact about small business customer concerns raised.",
  ];
  const result = repairDuplicateBullets(bullets, tldr, 2);
  assertEquals(result.repaired, true);
  assertEquals(result.droppedIndexes, [0, 2]);
  assertEquals(result.bullets, [bullets[1], bullets[3]]);
});

Deno.test("repairDuplicateBullets: gives up and returns the ORIGINAL bullets when dropping would go under the minimum", () => {
  const tldr =
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon.";
  const duplicate = "The company is raising its subscription price from five dollars to eight.";
  const bullets = [
    "First distinct fact about servers and infrastructure spending growth.",
    duplicate,
    "Third distinct fact about small business customer concerns raised.",
  ];
  // Dropping the one duplicate would leave 2, below the minimum of 3.
  const result = repairDuplicateBullets(bullets, tldr, 3);
  assertEquals(result, { bullets, droppedIndexes: [], repaired: false });
});

Deno.test("validateSummary: a repairable duplicate is dropped silently, summary PASSES with the trimmed bullet list", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => logs.push(args);
  try {
    const tldr = makeValidSummary().tldr_en;
    const duplicate = tldr.slice(0, 90); // well over the 80% overlap threshold
    const fiveBullets = [
      ...makeValidSummary().bullets_en, // 4 genuinely distinct bullets
      duplicate,
    ];
    const result = validateSummary(makeValidSummary({ bullets_en: fiveBullets }));
    assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
    if (result.ok) {
      assertEquals(result.value.bullets_en, makeValidSummary().bullets_en);
      assertEquals(result.value.bullets_en.length, 4);
    }

    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const repairLog = parsed.find((l) => l.event === "summary_repaired");
    assertEquals(repairLog?.field, "bullets_en");
    assertEquals(repairLog?.droppedIndexes, [4]);
    assertEquals(repairLog?.remaining, 4);
  } finally {
    console.log = original;
  }
});

Deno.test("validateSummary: repair is applied INDEPENDENTLY per language — counts may legitimately differ afterward", () => {
  const tldrEn = makeValidSummary().tldr_en;
  const duplicateEn = tldrEn.slice(0, 90);
  // bullets_ru: 7 distinct items, no duplicate at all -> untouched.
  const bulletsRu = [
    ...makeValidSummary().bullets_ru,
    "Пятый отдельный факт со своей собственной лексикой о продукте.",
    "Шестой отдельный факт со своей собственной лексикой о рынке.",
    "Седьмой отдельный факт со своей собственной лексикой о планах.",
  ];
  // bullets_en: 5 items, 1 duplicate -> repaired down to 4.
  const bulletsEn = [...makeValidSummary().bullets_en, duplicateEn];

  const result = validateSummary(
    makeValidSummary({ bullets_ru: bulletsRu, bullets_en: bulletsEn }),
  );
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
  if (result.ok) {
    assertEquals(result.value.bullets_ru.length, 7);
    assertEquals(result.value.bullets_en.length, 4);
  }
});

Deno.test("validateSummary: an UNREPAIRABLE duplicate (dropping would underflow the minimum) still reports the violation, unchanged from before this task", () => {
  // Exactly at the minimum (4) with one duplicate — dropping it would leave
  // 3, below STRICT's minBullets of 4 — repair must give up.
  const tldr = makeValidSummary().tldr_en;
  const duplicate = tldr.slice(0, 90);
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        makeValidSummary().bullets_en[0],
        makeValidSummary().bullets_en[1],
        makeValidSummary().bullets_en[2],
        duplicate,
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[3]") && v.includes("duplicates")),
      true,
    );
  }
});

// --- validateSummary: body paragraph rules ---

Deno.test("validateSummary: fewer than 2 body paragraphs is a violation", () => {
  const result = validateSummary(makeValidSummary({ body_en: [makeValidSummary().body_en[0]] }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("body_en") && v.includes("2")), true);
  }
});

Deno.test("validateSummary: more than 2 body paragraphs is a violation (default STRICT max at the 800 target)", () => {
  const paragraph = "x".repeat(400);
  const result = validateSummary(
    makeValidSummary({ body_en: [paragraph, paragraph, paragraph] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("body_en") && v.includes("2")), true);
  }
});

Deno.test("validateSummary: exactly 2 body paragraphs is fine, 3 is a violation (boundary; STRICT's tier at the 800 target is fixed at 2)", () => {
  const paragraph = (n: number) =>
    `Paragraph number ${n} with enough distinct words of its own to clear the minimum ` +
    `paragraph length threshold and avoid tripping the tldr-overlap duplicate check by ` +
    `bringing in genuinely new vocabulary that the short tldr sentence never mentions at all, ` +
    `padded out with a bit more filler text here so the whole thing comfortably clears the ` +
    `default minimum paragraph length with real headroom to spare for this boundary test case.`;

  const two = validateSummary(makeValidSummary({ body_en: [paragraph(1), paragraph(2)] }));
  assertEquals(two.ok, true, JSON.stringify(!two.ok ? two.violations : []));

  const three = validateSummary(
    makeValidSummary({ body_en: [paragraph(1), paragraph(2), paragraph(3)] }),
  );
  assertEquals(three.ok, false, JSON.stringify(three.ok ? "unexpectedly passed" : []));
});

Deno.test("validateSummary: a body paragraph under the default STRICT minimum (250 chars) is a violation", () => {
  const short = makeValidSummary().body_en[0].slice(0, 100);
  const result = validateSummary(
    makeValidSummary({ body_en: [short, makeValidSummary().body_en[1]] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("body_en[0]") && v.includes("250")),
      true,
    );
  }
});

Deno.test("validateSummary: a body paragraph moderately over the default STRICT soft max (640 at the 800 target) PASSES, not a violation", () => {
  // Task 19 Part A: the live incident this fixes — 854 chars failed outright
  // against the pre-Task-19 hard ceiling (768 at the old 1200 default target
  // this was originally observed against). At the new 800 default the soft
  // max is 640, but moderate overshoot up to the hard max (640 * 1.5 = 960)
  // still doesn't fail — 854 remains a real, still-relevant regression case.
  const moderatelyLong = "x".repeat(854);
  const result = validateSummary(
    makeValidSummary({ body_en: [moderatelyLong, makeValidSummary().body_en[1]] }),
  );
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("validateSummary: a body paragraph over the default STRICT hard maximum (960 = 640 * 1.5 at the 800 target) is a violation", () => {
  const tooLong = "x".repeat(961);
  const result = validateSummary(
    makeValidSummary({ body_en: [tooLong, makeValidSummary().body_en[1]] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) =>
        v.includes("body_en[0]") && v.includes("extremely long") && v.includes("960")
      ),
      true,
    );
  }
});

Deno.test("validateSummary: a body paragraph duplicating the tldr (>=80% word overlap) is a violation", () => {
  const tldr =
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon, according to a statement released to reporters on Tuesday afternoon this week.";
  // Same words as the tldr, padded past 300 chars with filler that repeats
  // short (<=2 char) tokens the overlap heuristic ignores, so the overlap
  // ratio over the counted words stays >=80%.
  const duplicateParagraph = `${tldr} ${tldr}`.slice(0, 380);
  const result = validateSummary(
    makeValidSummary({
      tldr_en: tldr,
      body_en: [duplicateParagraph, makeValidSummary().body_en[1]],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("body_en[0]") && v.includes("duplicates")),
      true,
    );
  }
});

Deno.test("validateSummary: zero tags is a violation", () => {
  const result = validateSummary(makeValidSummary({ tags: [] }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.violations.some((v) => v.includes("tags")), true);
});

Deno.test("validateSummary: more than 6 tags is a violation", () => {
  const result = validateSummary(makeValidSummary({ tags: ["a", "b", "c", "d", "e", "f", "g"] }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.violations.some((v) => v.includes("tags")), true);
});

Deno.test("validateSummary: 1 and 6 tags are both fine (boundaries)", () => {
  assertEquals(validateSummary(makeValidSummary({ tags: ["one"] })).ok, true);
  assertEquals(
    validateSummary(makeValidSummary({ tags: ["a", "b", "c", "d", "e", "f"] })).ok,
    true,
  );
});

Deno.test("validateSummary: RELAXED spec lowers the tldr bar relative to STRICT (same default target)", () => {
  // 130 chars: fails STRICT's default 150-char floor but clears RELAXED's 113.
  const midLengthTldr = "x".repeat(130);
  const summary = makeValidSummary({ tldr_ru: midLengthTldr, tldr_en: midLengthTldr });
  assertEquals(validateSummary(summary, DEFAULT_STRICT_SPEC).ok, false);
  assertEquals(validateSummary(summary, DEFAULT_RELAXED_SPEC).ok, true);
});

Deno.test("validateSummary: defaults to the default-target STRICT spec when omitted", () => {
  const midLengthTldr = "x".repeat(130);
  const summary = makeValidSummary({ tldr_ru: midLengthTldr, tldr_en: midLengthTldr });
  assertEquals(validateSummary(summary).ok, validateSummary(summary, DEFAULT_STRICT_SPEC).ok);
});

// --- RELAXED spec boundaries (workers-ai), at the default 800-char target ---

Deno.test("validateSummary (RELAXED): tldr at exactly 113 chars is fine, 112 is a violation (boundary)", () => {
  const tldr113 = "x".repeat(113);
  const at113 = validateSummary(
    makeValidSummary({ tldr_ru: tldr113, tldr_en: tldr113 }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(at113.ok, true);

  const tldr112 = "x".repeat(112);
  const at112 = validateSummary(
    makeValidSummary({ tldr_ru: tldr112, tldr_en: tldr112 }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(at112.ok, false);
});

Deno.test("validateSummary (RELAXED): 3 bullets is fine, 2 is a violation (boundary)", () => {
  const base = makeValidSummary();
  const threeBullets = validateSummary(
    makeValidSummary({ bullets_en: base.bullets_en.slice(0, 3) }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(threeBullets.ok, true);

  const twoBullets = validateSummary(
    makeValidSummary({ bullets_en: base.bullets_en.slice(0, 2) }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(twoBullets.ok, false);
});

Deno.test("validateSummary (RELAXED): a 30-char bullet is fine, 29 chars is a violation (boundary)", () => {
  const base = makeValidSummary();
  const thirty = validateSummary(
    makeValidSummary({ bullets_en: ["x".repeat(30), ...base.bullets_en.slice(1)] }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(thirty.ok, true);

  const twentyNine = validateSummary(
    makeValidSummary({ bullets_en: ["x".repeat(29), ...base.bullets_en.slice(1)] }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(twentyNine.ok, false);
});

Deno.test("validateSummary (RELAXED): 3 body paragraphs is fine, 4 is a violation (boundary; RELAXED gets one more paragraph of headroom than STRICT at this target)", () => {
  const paragraph = (n: number) =>
    `Paragraph number ${n} with enough distinct filler content padded out well past the default ` +
    "target minimum paragraph length so this boundary test isn't accidentally failing on length instead of count.";
  const three = validateSummary(
    makeValidSummary({
      body_en: [paragraph(1), paragraph(2), paragraph(3)],
    }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(three.ok, true, JSON.stringify(!three.ok ? three.violations : []));

  const four = validateSummary(
    makeValidSummary({
      body_en: [paragraph(1), paragraph(2), paragraph(3), paragraph(4)],
    }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(four.ok, false);
});

Deno.test("validateSummary: RELAXED is genuinely more permissive than STRICT at every target — lower floor, wider paragraph range", () => {
  // Task 16.5: a profile-agnostic formula (Task 16) converged RELAXED onto
  // nearly the same bounds as STRICT at the default target, which is why
  // Llama failed 2/2 live runs on paragraphs the OLD (pre-Task-16) RELAXED
  // profile passed 4/4. This is the regression test for that: RELAXED's
  // effective-target scaling (see RELAXED_EFFECTIVE_TARGET_RATIO) and wider
  // paragraph-count range must produce a strictly lower minParagraphChars
  // and a paragraph-count range that's a proper superset of STRICT's, at
  // every target — not just the smallest one.
  for (const target of [400, 800, 1200, 2000, 4000] as const) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    assertEquals(relaxed.minParagraphChars < strict.minParagraphChars, true, `target=${target}`);
    assertEquals(relaxed.minBodyParagraphs, strict.minBodyParagraphs, `target=${target}`);
    assertEquals(relaxed.maxBodyParagraphs, strict.maxBodyParagraphs + 1, `target=${target}`);
  }
});

Deno.test("validateSummary: a paragraph sample that the OLD RELAXED profile passed (240-290 chars x3) passes the NEW RELAXED profile at the default target", () => {
  // The exact live-evidence shape from Task 16.5: Llama wrote 3 paragraphs
  // in the 241-287 char range and failed against Task 16's profile-agnostic
  // 288-char floor. The re-derived RELAXED profile must accept this again.
  const paragraphs = [241, 265, 287].map((len, i) =>
    `Paragraph ${i} content padded to an exact test length. `.padEnd(len, "x")
  );
  const result = validateSummary(
    makeValidSummary({ body_en: paragraphs }),
    DEFAULT_RELAXED_SPEC,
  );
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("validateSummary: multiple simultaneous violations are all reported, not just the first", () => {
  const result = validateSummary(
    makeValidSummary({ title_ru: "", tags: [], bullets_en: ["short"] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.length >= 3, true);
  }
});

Deno.test("validateSummary: the prompt's own few-shot example passes STRICT at the default target (guards against prompt/validator drift)", () => {
  const result = validateSummary(FEW_SHOT_EXAMPLE_SUMMARY, DEFAULT_STRICT_SPEC);
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("validateSummary: the prompt's own few-shot example ALSO passes RELAXED at the default target (same example serves both tiers)", () => {
  const result = validateSummary(FEW_SHOT_EXAMPLE_SUMMARY, DEFAULT_RELAXED_SPEC);
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

// --- Prompt parameterization: no drift between the prompt text and the spec it was built from ---

Deno.test("buildSystemPrompt: STRICT prompt at the default target states the spec's own numbers", () => {
  const prompt = buildSystemPrompt(DEFAULT_STRICT_SPEC);
  assertEquals(prompt.includes("at least 150 characters"), true);
  assertEquals(prompt.includes("2-2 self-contained"), true);
  assertEquals(prompt.includes("between 250 and 640"), true);
  assertEquals(prompt.includes("aim for 300-500"), true);
  assertEquals(prompt.includes("~800 characters across all paragraphs"), true);
  assertEquals(prompt.includes("4-7 items"), true);
  assertEquals(prompt.includes("40-220 characters each"), true);
});

Deno.test("buildSystemPrompt: bullets section states the NEW-specifics contrast rule with a BAD/GOOD micro-example", () => {
  const prompt = buildSystemPrompt(DEFAULT_STRICT_SPEC);
  assertEquals(prompt.includes("Bullets MUST add NEW specifics not already in the TL;DR"), true);
  assertEquals(prompt.includes("NEVER restate the TL;DR in different"), true);
  assertEquals(prompt.includes("BAD bullet:"), true);
  assertEquals(prompt.includes("GOOD bullet:"), true);
});

Deno.test("buildSystemPrompt: RELAXED prompt at the default target states RELAXED's own tldr/bullet numbers, not STRICT's", () => {
  const prompt = buildSystemPrompt(DEFAULT_RELAXED_SPEC);
  assertEquals(prompt.includes("at least 113 characters"), true);
  assertEquals(prompt.includes("3-7 items"), true);
  assertEquals(prompt.includes("30-220 characters each"), true);
  assertEquals(prompt.includes("at least 150 characters"), false);
  assertEquals(prompt.includes("4-7 items"), false);
});

Deno.test("buildSystemPrompt: a custom spec's numbers all flow into the rendered text (no hardcoded fallback)", () => {
  const custom: SummarySpec = {
    profileKind: "strict",
    targetTotalChars: 4321,
    minBodyParagraphs: 5,
    maxBodyParagraphs: 6,
    paragraphTargetLow: 111,
    paragraphTargetHigh: 222,
    minParagraphChars: 333,
    softMaxParagraphChars: 444,
    hardMaxParagraphChars: 666,
    minTldrChars: 555,
    minBullets: 6,
    maxBullets: 8,
    minBulletChars: 77,
    softMaxBulletChars: 888,
    hardMaxBulletChars: 1332,
    maxTokens: 5555,
  };
  const prompt = buildSystemPrompt(custom);
  assertEquals(prompt.includes("at least 555 characters"), true);
  assertEquals(prompt.includes("5-6 self-contained"), true);
  assertEquals(prompt.includes("between 333 and 444"), true);
  assertEquals(prompt.includes("aim for 111-222"), true);
  assertEquals(prompt.includes("~4321 characters across all paragraphs"), true);
  assertEquals(prompt.includes("6-8 items"), true);
  assertEquals(prompt.includes("77-888 characters each"), true);
});

// --- Profile selection is fixed per summarize function, not a caller option ---

Deno.test("summarizeArticleWithWorkersAi accepts a summary that clears RELAXED but would fail STRICT", async () => {
  // 130-char tldr: fails STRICT's default 150-char floor, clears RELAXED's 113.
  const relaxedOnly = { ...makeValidSummary(), tldr_ru: "x".repeat(130), tldr_en: "x".repeat(130) };
  assertEquals(validateSummary(relaxedOnly, DEFAULT_STRICT_SPEC).ok, false);
  assertEquals(validateSummary(relaxedOnly, DEFAULT_RELAXED_SPEC).ok, true);

  const ai = makeStubAi(() => ({ response: relaxedOnly }));
  const result = await summarizeArticleWithWorkersAi(ai, "model", "Title", "text");
  assertEquals(result, relaxedOnly);
});

Deno.test("summarizeArticle (gateway/direct) rejects a summary that only clears RELAXED, not STRICT", async () => {
  const relaxedOnly = { ...makeValidSummary(), tldr_ru: "x".repeat(130), tldr_en: "x".repeat(130) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(relaxedOnly) }] }),
        { status: 200 },
      ),
    )) as typeof fetch;
  try {
    await assertRejects(
      () => summarizeArticle({ apiKey: "key", model: "model" }, "Title", "text"),
      Error,
      "summary validation",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Corrective retry: the second attempt gets the specific violations ---

Deno.test("summarizeArticle: a content-quality failure retries with the violations named, not the generic message", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSecondBody: { messages: { content: string }[] } | undefined;
  let calls = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      const tooShort = { ...makeValidSummary(), tldr_ru: "Коротко.", tldr_en: "Short." };
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(tooShort) }] }),
          { status: 200 },
        ),
      );
    }
    capturedSecondBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(makeValidSummary()) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "sk-direct", model: "test-model" },
      "Title",
      "Body",
    );
    assertEquals(result, makeValidSummary());
    assertEquals(calls, 2);
    const secondMessage = capturedSecondBody?.messages[0]?.content ?? "";
    assertEquals(secondMessage.includes("tldr_ru must be at least 150 characters"), true);
    assertEquals(secondMessage.includes("tldr_en must be at least 150 characters"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: a body-paragraph OVERSHOOT retries with a 'rewrite paragraph N' instruction, not the generic message", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSecondBody: { messages: { content: string }[] } | undefined;
  let calls = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      // body_en[0] overshoots DEFAULT_STRICT_SPEC's 960-char HARD max
      // (640 soft max * 1.5) — moderate overshoot alone no longer triggers a
      // retry at all after Task 19 Part A.
      const tooLong = {
        ...makeValidSummary(),
        body_en: ["x".repeat(961), makeValidSummary().body_en[1]],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(tooLong) }] }),
          { status: 200 },
        ),
      );
    }
    capturedSecondBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(makeValidSummary()) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "sk-direct", model: "test-model" },
      "Title",
      "Body",
    );
    assertEquals(result, makeValidSummary());
    assertEquals(calls, 2);
    const secondMessage = capturedSecondBody?.messages[0]?.content ?? "";
    assertEquals(
      secondMessage.includes(
        "rewrite body_en paragraph 1 to 300-500 characters; keep the most important facts, cut examples first",
      ),
      true,
    );
    // Not the generic "is extremely long: must be at most X (got Y)" phrasing
    // repeated verbatim for this violation — the specific rewrite instruction
    // replaces it entirely.
    assertEquals(secondMessage.includes("body_en[0] is extremely long"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: a body-paragraph UNDERSHOOT still gets the generic phrasing (only overshoots get the rewrite instruction)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSecondBody: { messages: { content: string }[] } | undefined;
  let calls = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      const tooShort = {
        ...makeValidSummary(),
        body_en: ["x".repeat(50), makeValidSummary().body_en[1]],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(tooShort) }] }),
          { status: 200 },
        ),
      );
    }
    capturedSecondBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(makeValidSummary()) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    await summarizeArticle({ apiKey: "sk-direct", model: "test-model" }, "Title", "Body");
    const secondMessage = capturedSecondBody?.messages[0]?.content ?? "";
    assertEquals(secondMessage.includes("body_en[0] must be at least 250 characters"), true);
    assertEquals(secondMessage.includes("rewrite body_en paragraph"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: a bullet duplicating the tldr retries with a 'replace bullet N' instruction, not the generic message", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSecondBody: { messages: { content: string }[] } | undefined;
  let calls = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      // bullets_en[1] literally restates tldr_en — well over the 80% overlap
      // threshold textDuplicatesTldr checks.
      const duplicateBullet = {
        ...makeValidSummary(),
        bullets_en: [makeValidSummary().bullets_en[0], makeValidSummary().tldr_en],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(duplicateBullet) }] }),
          { status: 200 },
        ),
      );
    }
    capturedSecondBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(makeValidSummary()) }] }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await summarizeArticle(
      { apiKey: "sk-direct", model: "test-model" },
      "Title",
      "Body",
    );
    assertEquals(result, makeValidSummary());
    assertEquals(calls, 2);
    const secondMessage = capturedSecondBody?.messages[0]?.content ?? "";
    assertEquals(
      secondMessage.includes(
        "replace bullet 2 (bullets_en[1]) with a NEW fact from the article not mentioned in the TL;DR",
      ),
      true,
    );
    // Not the generic "duplicates the tldr instead of adding new detail"
    // phrasing repeated verbatim — the specific replace instruction replaces
    // it entirely, same convention as the body-paragraph overshoot message.
    assertEquals(secondMessage.includes("duplicates the tldr instead of adding new detail"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- deriveSummarySpec: single source of truth for both the prompt's sizing
// block and validateSummary()'s hard bounds ---

const TEST_TARGETS = [400, 800, 1200, 2000, 4000] as const;

Deno.test("deriveSummarySpec: paragraph/tldr/max_tokens numbers are monotonically non-decreasing as the target grows (both profiles)", () => {
  for (const profileKind of ["strict", "relaxed"] as const) {
    let prevMaxParagraph = 0;
    let prevTldr = 0;
    let prevMaxTokens = 0;
    for (const target of TEST_TARGETS) {
      const spec = deriveSummarySpec(target, profileKind);
      assertEquals(
        spec.softMaxParagraphChars >= prevMaxParagraph,
        true,
        `${profileKind}@${target}`,
      );
      assertEquals(spec.minTldrChars >= prevTldr, true, `${profileKind}@${target}`);
      assertEquals(spec.maxTokens >= prevMaxTokens, true, `${profileKind}@${target}`);
      prevMaxParagraph = spec.softMaxParagraphChars;
      prevTldr = spec.minTldrChars;
      prevMaxTokens = spec.maxTokens;
    }
  }
});

Deno.test("deriveSummarySpec: minParagraphChars <= softMaxParagraphChars and the target band sits at/under the hard ceiling, for every target x profile", () => {
  for (const profileKind of ["strict", "relaxed"] as const) {
    for (const target of TEST_TARGETS) {
      const spec = deriveSummarySpec(target, profileKind);
      assertEquals(
        spec.minParagraphChars <= spec.softMaxParagraphChars,
        true,
        `${profileKind}@${target}`,
      );
      assertEquals(
        spec.paragraphTargetHigh <= spec.softMaxParagraphChars,
        true,
        `${profileKind}@${target}`,
      );
      assertEquals(
        spec.paragraphTargetLow <= spec.paragraphTargetHigh,
        true,
        `${profileKind}@${target}`,
      );
    }
  }
});

Deno.test("deriveSummarySpec: STRICT's 250-char paragraph floor binds only at the smallest allowed target (400) — an accepted edge case, see README", () => {
  const spec400 = deriveSummarySpec(400, "strict");
  // At this one boundary, the floor (250) sits ABOVE the natural "aim for"
  // low end (150) — the model is told to aim for 150-250 but the enforced
  // minimum is 250; still self-consistent (250 <= max 280), just a narrow
  // band. Every other target in the table doesn't hit this case.
  assertEquals(spec400.minParagraphChars, 250);
  assertEquals(spec400.paragraphTargetLow, 150);
  assertEquals(spec400.minParagraphChars > spec400.paragraphTargetLow, true);

  for (const target of [800, 1200, 2000, 4000] as const) {
    const spec = deriveSummarySpec(target, "strict");
    assertEquals(spec.minParagraphChars <= spec.paragraphTargetLow, true, `strict@${target}`);
  }
});

Deno.test("deriveSummarySpec: tldr floor clamp (150) and cap (350) both apply on the STRICT side", () => {
  // 400 * 0.15 = 60, below the 150 floor.
  assertEquals(deriveSummarySpec(400, "strict").minTldrChars, 150);
  // 4000 * 0.15 = 600, above the 350 cap.
  assertEquals(deriveSummarySpec(4000, "strict").minTldrChars, 350);
});

Deno.test("deriveSummarySpec: RELAXED's tldr minimum is always 75% of STRICT's, at every target", () => {
  for (const target of TEST_TARGETS) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    assertEquals(relaxed.minTldrChars, Math.round(strict.minTldrChars * 0.75), `target=${target}`);
  }
});

Deno.test("deriveSummarySpec: max_tokens is clamped to [2500, 6000] regardless of target", () => {
  assertEquals(deriveSummarySpec(400, "strict").maxTokens >= 2500, true);
  assertEquals(deriveSummarySpec(4000, "strict").maxTokens, 6000);
});

Deno.test("deriveSummarySpec: bullet ranges are fixed per profile, independent of target", () => {
  for (const target of TEST_TARGETS) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    assertEquals(strict.minBullets, 4);
    assertEquals(strict.maxBullets, 7);
    assertEquals(strict.minBulletChars, 40);
    assertEquals(strict.softMaxBulletChars, 220);
    assertEquals(relaxed.minBullets, 3);
    assertEquals(relaxed.maxBullets, 7);
    assertEquals(relaxed.minBulletChars, 30);
    assertEquals(relaxed.softMaxBulletChars, 220);
  }
});

Deno.test("deriveSummarySpec: paragraph count widens in three steps as the target grows", () => {
  assertEquals(deriveSummarySpec(400, "strict").maxBodyParagraphs, 2);
  assertEquals(deriveSummarySpec(900, "strict").maxBodyParagraphs, 2);
  assertEquals(deriveSummarySpec(901, "strict").maxBodyParagraphs, 3);
  assertEquals(deriveSummarySpec(2000, "strict").maxBodyParagraphs, 3);
  assertEquals(deriveSummarySpec(2001, "strict").maxBodyParagraphs, 4);
  assertEquals(deriveSummarySpec(4000, "strict").maxBodyParagraphs, 4);
});

Deno.test("deriveSummarySpec: the exact spec table for the required test targets, both profiles (documents the derivation)", () => {
  const expected: Record<number, { strict: Partial<SummarySpec>; relaxed: Partial<SummarySpec> }> =
    {
      400: {
        strict: {
          minParagraphChars: 250,
          softMaxParagraphChars: 320,
          hardMaxParagraphChars: 480,
          minTldrChars: 150,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 2,
        },
        relaxed: {
          minParagraphChars: 120,
          softMaxParagraphChars: 157,
          hardMaxParagraphChars: 236,
          minTldrChars: 113,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 3,
        },
      },
      800: {
        strict: {
          minParagraphChars: 250,
          softMaxParagraphChars: 640,
          hardMaxParagraphChars: 960,
          minTldrChars: 150,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 2,
        },
        relaxed: {
          minParagraphChars: 120,
          softMaxParagraphChars: 314,
          hardMaxParagraphChars: 471,
          minTldrChars: 113,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 3,
        },
      },
      1200: {
        strict: {
          minParagraphChars: 288,
          softMaxParagraphChars: 768,
          hardMaxParagraphChars: 1152,
          minTldrChars: 180,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 3,
        },
        relaxed: {
          minParagraphChars: 126,
          softMaxParagraphChars: 392,
          hardMaxParagraphChars: 588,
          minTldrChars: 135,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 4,
        },
      },
      2000: {
        strict: {
          minParagraphChars: 480,
          softMaxParagraphChars: 1280,
          hardMaxParagraphChars: 1920,
          minTldrChars: 300,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 3,
        },
        relaxed: {
          minParagraphChars: 210,
          softMaxParagraphChars: 653,
          hardMaxParagraphChars: 980,
          minTldrChars: 225,
          minBodyParagraphs: 2,
          maxBodyParagraphs: 4,
        },
      },
      4000: {
        strict: {
          minParagraphChars: 686,
          softMaxParagraphChars: 1829,
          hardMaxParagraphChars: 2744,
          minTldrChars: 350,
          minBodyParagraphs: 3,
          maxBodyParagraphs: 4,
        },
        relaxed: {
          minParagraphChars: 315,
          softMaxParagraphChars: 980,
          hardMaxParagraphChars: 1470,
          minTldrChars: 263,
          minBodyParagraphs: 3,
          maxBodyParagraphs: 5,
        },
      },
    };

  for (const target of TEST_TARGETS) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    for (const [key, value] of Object.entries(expected[target].strict)) {
      assertEquals(
        (strict as unknown as Record<string, unknown>)[key],
        value,
        `strict@${target}.${key}`,
      );
    }
    for (const [key, value] of Object.entries(expected[target].relaxed)) {
      assertEquals(
        (relaxed as unknown as Record<string, unknown>)[key],
        value,
        `relaxed@${target}.${key}`,
      );
    }
  }
});

// --- Task 19 Part A: asymmetric validation — moderate overshoot passes,
// only undershoot and EXTREME overshoot (past hardMax) fail ---

Deno.test("deriveSummarySpec: hardMax is always exactly 1.5x softMax, for both paragraphs and bullets, both profiles, every target", () => {
  for (const target of TEST_TARGETS) {
    for (const profileKind of ["strict", "relaxed"] as const) {
      const spec = deriveSummarySpec(target, profileKind);
      assertEquals(
        spec.hardMaxParagraphChars,
        Math.round(spec.softMaxParagraphChars * 1.5),
        `${profileKind}@${target}.hardMaxParagraphChars`,
      );
      assertEquals(
        spec.hardMaxBulletChars,
        Math.round(spec.softMaxBulletChars * 1.5),
        `${profileKind}@${target}.hardMaxBulletChars`,
      );
    }
  }
});

// Boundary table: min-1, min, softMax, softMax+1, hardMax, hardMax+1 — for
// both body paragraphs and bullets, both profiles, at the default target.
// Only min-1 (undershoot) and hardMax+1 (extreme overshoot) are violations;
// everything else, including softMax+1 through hardMax, passes.
Deno.test("validateSummary: body-paragraph length boundary table (min-1/min/softMax/softMax+1/hardMax/hardMax+1), both profiles", () => {
  for (const spec of [DEFAULT_STRICT_SPEC, DEFAULT_RELAXED_SPEC]) {
    // A second paragraph exactly at this spec's own min — already verified
    // as a passing boundary on its own, and an all-"x" string can never
    // trip the tldr-duplication heuristic (single token, no real words).
    const other = "x".repeat(spec.minParagraphChars);
    const boundaries: [number, boolean][] = [
      [spec.minParagraphChars - 1, false],
      [spec.minParagraphChars, true],
      [spec.softMaxParagraphChars, true],
      [spec.softMaxParagraphChars + 1, true],
      [spec.hardMaxParagraphChars, true],
      [spec.hardMaxParagraphChars + 1, false],
    ];
    for (const [len, expectOk] of boundaries) {
      const result = validateSummary(
        makeValidSummary({ body_en: ["x".repeat(len), other] }),
        spec,
      );
      assertEquals(
        result.ok,
        expectOk,
        `${spec.profileKind}@len=${len}: ${
          !result.ok ? JSON.stringify(result.violations) : "unexpectedly failed to pass"
        }`,
      );
    }
  }
});

Deno.test("validateSummary: bullet length boundary table (min-1/min/softMax/softMax+1/hardMax/hardMax+1), both profiles", () => {
  for (const spec of [DEFAULT_STRICT_SPEC, DEFAULT_RELAXED_SPEC]) {
    const filler = [
      "Second concrete fact goes here now for the reader today.",
      "Third concrete fact goes here now for the reader today.",
      "Fourth concrete fact goes here now for the reader today.",
    ];
    const boundaries: [number, boolean][] = [
      [spec.minBulletChars - 1, false],
      [spec.minBulletChars, true],
      [spec.softMaxBulletChars, true],
      [spec.softMaxBulletChars + 1, true],
      [spec.hardMaxBulletChars, true],
      [spec.hardMaxBulletChars + 1, false],
    ];
    for (const [len, expectOk] of boundaries) {
      const result = validateSummary(
        makeValidSummary({ bullets_en: ["x".repeat(len), ...filler] }),
        spec,
      );
      assertEquals(
        result.ok,
        expectOk,
        `${spec.profileKind}@len=${len}: ${
          !result.ok ? JSON.stringify(result.violations) : "unexpectedly failed to pass"
        }`,
      );
    }
  }
});

Deno.test("validateSummary: a soft body-paragraph overshoot logs 'validation_soft_overshoot' with field/got/softMax, and does not add a violation", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const len = DEFAULT_STRICT_SPEC.softMaxParagraphChars + 10;
    const result = validateSummary(
      makeValidSummary({ body_en: ["x".repeat(len), makeValidSummary().body_en[1]] }),
    );
    assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const softOvershootLog = parsed.find((l) => l.event === "validation_soft_overshoot");
    assertEquals(softOvershootLog?.field, "body_en[0]");
    assertEquals(softOvershootLog?.got, len);
    assertEquals(softOvershootLog?.softMax, DEFAULT_STRICT_SPEC.softMaxParagraphChars);
  } finally {
    console.log = original;
  }
});

Deno.test("validateSummary: a soft bullet overshoot logs 'validation_soft_overshoot', does not add a violation", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const len = DEFAULT_STRICT_SPEC.softMaxBulletChars + 9;
    const result = validateSummary(
      makeValidSummary({
        bullets_en: [
          "x".repeat(len),
          "Second concrete fact goes here now for the reader.",
          "Third concrete fact goes here now for the reader.",
          "Fourth concrete fact goes here now for the reader.",
        ],
      }),
    );
    assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const softOvershootLog = parsed.find((l) => l.event === "validation_soft_overshoot");
    assertEquals(softOvershootLog?.field, "bullets_en[0]");
    assertEquals(softOvershootLog?.got, len);
    assertEquals(softOvershootLog?.softMax, DEFAULT_STRICT_SPEC.softMaxBulletChars);
  } finally {
    console.log = original;
  }
});

Deno.test("validateSummary: the exact live-recorded failures (body_en 854, bullets_en 229 at the default target) now PASS", () => {
  // The live incident motivating Part A, named exactly: a 3rd ceiling chase
  // where body_en hit 854 (old hard max 768) and bullets_en hit 229 (old
  // hard max 220) both failed validation over moderate, harmless overshoot.
  const result = validateSummary(
    makeValidSummary({
      body_en: ["x".repeat(854), makeValidSummary().body_en[1]],
      bullets_en: [
        "x".repeat(229),
        "Second concrete fact goes here now for the reader.",
        "Third concrete fact goes here now for the reader.",
        "Fourth concrete fact goes here now for the reader.",
      ],
    }),
  );
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("deriveSummarySpec: STRICT widens its ceiling more than its floor; RELAXED widens its floor more than its ceiling (the asymmetry is intentional and opposite per profile)", () => {
  // Task 17: live Claude output overshot STRICT's old symmetric +-40%
  // ceiling (709-716 chars vs a 672 max at the default target) — Claude
  // overshoots, so STRICT now gets extra headroom on the high end (+60%)
  // instead of the low end. Llama (RELAXED) undershoots instead, so its
  // ceiling was never the problem and stays at +40%; it keeps the wider
  // floor discount (-55%) from Task 16.5.
  for (const target of TEST_TARGETS) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    const strictLowWidening = 1 - strict.minParagraphChars / strict.paragraphTargetLow;
    const strictHighWidening = strict.softMaxParagraphChars / strict.paragraphTargetHigh - 1;
    // Only checked where the floor clamp doesn't dominate (see the 400-char
    // boundary test above) — at every other target STRICT's high-side
    // widening (+60%) is strictly greater than its low-side widening (40%).
    if (strict.minParagraphChars <= strict.paragraphTargetLow) {
      assertEquals(strictHighWidening > strictLowWidening, true, `strict@${target}`);
    }
    const relaxedLowWidening = 1 - relaxed.minParagraphChars / relaxed.paragraphTargetLow;
    const relaxedHighWidening = relaxed.softMaxParagraphChars / relaxed.paragraphTargetHigh - 1;
    if (relaxed.minParagraphChars <= relaxed.paragraphTargetLow) {
      assertEquals(relaxedLowWidening > relaxedHighWidening, true, `relaxed@${target}`);
    }
  }
});

Deno.test("deriveSummarySpec: RELAXED's absolute paragraph ceiling can be LOWER than STRICT's at the same target — each profile's bounds fit its own model, not a blanket 'RELAXED is always wider' rule", () => {
  // The "RELAXED is more permissive" invariant above is about the FLOOR and
  // the paragraph COUNT range, not the ceiling — RELAXED derives its ceiling
  // from a smaller effective target (RELAXED_EFFECTIVE_TARGET_RATIO) AND a
  // smaller high-side widening factor (+40% vs STRICT's +60%), so it ends up
  // with a lower absolute ceiling despite being the "more forgiving" profile
  // overall. Documented here so this isn't mistaken for a regression.
  for (const target of TEST_TARGETS) {
    const strict = deriveSummarySpec(target, "strict");
    const relaxed = deriveSummarySpec(target, "relaxed");
    assertEquals(
      relaxed.softMaxParagraphChars < strict.softMaxParagraphChars,
      true,
      `target=${target}`,
    );
  }
});

Deno.test("deriveSummarySpec: STRICT's ceiling at target 1200 (768) covers the live-observed Claude overshoot (709-716 chars) with margin", () => {
  // The exact live evidence motivating this task: real Claude output hit
  // 709-716 char paragraphs (WITH this prompt's sizing block already in
  // place) against the old, symmetric-widening ceiling of 672 — a genuine
  // overshoot the old formula didn't cover. The new +60% ceiling must clear
  // it. (Earlier live observations of 796/857 chars predate the sizing block
  // and are not what this specific fix targets — see README.) This was
  // captured at the 1200 target specifically (the default at the time) —
  // fixed here rather than "the default" since Task 20 later moved the
  // default to 800, which shouldn't invalidate this historical calibration
  // data point.
  const spec = deriveSummarySpec(1200, "strict");
  assertEquals(spec.softMaxParagraphChars, 768);
  assertEquals(spec.softMaxParagraphChars > 716, true);
});

// --- parseSummaryBodyTargetChars: defensive [vars] parsing ---

function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: unknown[][] } {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("parseSummaryBodyTargetChars: undefined/empty falls back to the default, no warning", () => {
  const { result: undef, warnings: w1 } = withCapturedWarnings(() =>
    parseSummaryBodyTargetChars(undefined)
  );
  assertEquals(undef, DEFAULT_SUMMARY_BODY_TARGET_CHARS);
  assertEquals(w1.length, 0);

  const { result: empty, warnings: w2 } = withCapturedWarnings(() =>
    parseSummaryBodyTargetChars("  ")
  );
  assertEquals(empty, DEFAULT_SUMMARY_BODY_TARGET_CHARS);
  assertEquals(w2.length, 0);
});

Deno.test("parseSummaryBodyTargetChars: a valid in-range value is used as-is, no warning", () => {
  const { result, warnings } = withCapturedWarnings(() => parseSummaryBodyTargetChars("800"));
  assertEquals(result, 800);
  assertEquals(warnings.length, 0);
});

Deno.test("parseSummaryBodyTargetChars: non-numeric, below-min, and above-max all fall back WITH a warning", () => {
  for (const bad of ["not a number", "399", "4001", "-100"]) {
    const { result, warnings } = withCapturedWarnings(() => parseSummaryBodyTargetChars(bad));
    assertEquals(result, DEFAULT_SUMMARY_BODY_TARGET_CHARS, bad);
    assertEquals(warnings.length, 1, bad);
  }
});

Deno.test("parseSummaryBodyTargetChars: the boundary values 400 and 4000 are both accepted", () => {
  assertEquals(parseSummaryBodyTargetChars("400"), 400);
  assertEquals(parseSummaryBodyTargetChars("4000"), 4000);
});
