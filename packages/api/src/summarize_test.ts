import "./env.d.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  buildAnthropicRequest,
  buildSystemPrompt,
  callLlm,
  FEW_SHOT_EXAMPLE_SUMMARY,
  parseSummaryJson,
  parseWorkersAiResult,
  RELAXED_PROFILE,
  renderSummaryMarkdown,
  STRICT_PROFILE,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
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

// Meets validateSummary's content bar (>=200 char tldrs, 4-7 bullets each
// 40-220 chars, 2-4 body paragraphs each 300-700 chars, none duplicating the
// tldr, 1-6 tags) so it round-trips through both the shape-only parsers and
// the full summarizeArticle* validate-and-retry path used throughout this
// file.
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
    "Локальный кеш на устройстве ограничен объёмом в 500 мегабайт, чего разработчики считают достаточным для типичного сценария использования в течение нескольких дней офлайн-работы. Если во время автономной работы возникает конфликт правок между устройствами, система разрешает его в пользу версии с более поздней меткой сохранения. Обновление доступно всем пользователям бесплатно и устанавливается автоматически.",
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

Deno.test("validateSummary: tldr under 200 chars is a violation", () => {
  const result = validateSummary(makeValidSummary({ tldr_ru: "Слишком коротко." }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("tldr_ru") && v.includes("200")),
      true,
    );
  }
});

Deno.test("validateSummary: tldr at exactly 200 chars is fine (boundary)", () => {
  const result = validateSummary(makeValidSummary({ tldr_en: "x".repeat(200) }));
  assertEquals(result.ok, true);
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

Deno.test("validateSummary: a bullet over 220 chars is a violation", () => {
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
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[0]") && v.includes("220")),
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

// --- validateSummary: body paragraph rules ---

Deno.test("validateSummary: fewer than 2 body paragraphs is a violation", () => {
  const result = validateSummary(makeValidSummary({ body_en: [makeValidSummary().body_en[0]] }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("body_en") && v.includes("2")), true);
  }
});

Deno.test("validateSummary: more than 4 body paragraphs is a violation", () => {
  const paragraph = "x".repeat(400);
  const result = validateSummary(
    makeValidSummary({ body_en: [paragraph, paragraph, paragraph, paragraph, paragraph] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("body_en") && v.includes("4")), true);
  }
});

Deno.test("validateSummary: exactly 2 and exactly 4 body paragraphs are both fine (boundaries)", () => {
  const paragraph = (n: number) =>
    `Paragraph number ${n} with enough distinct words of its own to clear the minimum ` +
    `paragraph length threshold and avoid tripping the tldr-overlap duplicate check by ` +
    `bringing in genuinely new vocabulary that the short tldr sentence never mentions at all, ` +
    `padded out with a bit more filler text here so the whole thing comfortably clears three ` +
    `hundred characters with real headroom to spare for this specific boundary test case.`;

  const two = validateSummary(makeValidSummary({ body_en: [paragraph(1), paragraph(2)] }));
  assertEquals(two.ok, true, JSON.stringify(!two.ok ? two.violations : []));

  const four = validateSummary(
    makeValidSummary({ body_en: [paragraph(1), paragraph(2), paragraph(3), paragraph(4)] }),
  );
  assertEquals(four.ok, true, JSON.stringify(!four.ok ? four.violations : []));
});

Deno.test("validateSummary: a body paragraph under 300 chars is a violation", () => {
  const short = makeValidSummary().body_en[0].slice(0, 100);
  const result = validateSummary(
    makeValidSummary({ body_en: [short, makeValidSummary().body_en[1]] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("body_en[0]") && v.includes("300")),
      true,
    );
  }
});

Deno.test("validateSummary: a body paragraph over 700 chars is a violation", () => {
  const tooLong = "x".repeat(701);
  const result = validateSummary(
    makeValidSummary({ body_en: [tooLong, makeValidSummary().body_en[1]] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("body_en[0]") && v.includes("700")),
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

Deno.test("validateSummary: RELAXED profile lowers the tldr bar relative to STRICT", () => {
  // 150-199 chars: fails STRICT (>=200) but clears RELAXED (>=150).
  const midLengthTldr = "x".repeat(180);
  const summary = makeValidSummary({ tldr_ru: midLengthTldr, tldr_en: midLengthTldr });
  assertEquals(validateSummary(summary, STRICT_PROFILE).ok, false);
  assertEquals(validateSummary(summary, RELAXED_PROFILE).ok, true);
});

Deno.test("validateSummary: profile defaults to STRICT when omitted", () => {
  const midLengthTldr = "x".repeat(180);
  const summary = makeValidSummary({ tldr_ru: midLengthTldr, tldr_en: midLengthTldr });
  assertEquals(validateSummary(summary).ok, validateSummary(summary, STRICT_PROFILE).ok);
});

// --- RELAXED profile boundaries (workers-ai) ---

Deno.test("validateSummary (RELAXED): tldr at exactly 150 chars is fine (boundary)", () => {
  const tldr = "x".repeat(150);
  const result = validateSummary(
    makeValidSummary({ tldr_ru: tldr, tldr_en: tldr }),
    RELAXED_PROFILE,
  );
  assertEquals(result.ok, true);
});

Deno.test("validateSummary (RELAXED): tldr at 149 chars is a violation", () => {
  const tldr = "x".repeat(149);
  const result = validateSummary(
    makeValidSummary({ tldr_ru: tldr, tldr_en: tldr }),
    RELAXED_PROFILE,
  );
  assertEquals(result.ok, false);
});

Deno.test("validateSummary (RELAXED): 3 bullets is fine, 2 is a violation (boundary)", () => {
  const base = makeValidSummary();
  const threeBullets = validateSummary(
    makeValidSummary({ bullets_en: base.bullets_en.slice(0, 3) }),
    RELAXED_PROFILE,
  );
  assertEquals(threeBullets.ok, true);

  const twoBullets = validateSummary(
    makeValidSummary({ bullets_en: base.bullets_en.slice(0, 2) }),
    RELAXED_PROFILE,
  );
  assertEquals(twoBullets.ok, false);
});

Deno.test("validateSummary (RELAXED): a 30-char bullet is fine, 29 chars is a violation (boundary)", () => {
  const base = makeValidSummary();
  const thirty = validateSummary(
    makeValidSummary({ bullets_en: ["x".repeat(30), ...base.bullets_en.slice(1)] }),
    RELAXED_PROFILE,
  );
  assertEquals(thirty.ok, true);

  const twentyNine = validateSummary(
    makeValidSummary({ bullets_en: ["x".repeat(29), ...base.bullets_en.slice(1)] }),
    RELAXED_PROFILE,
  );
  assertEquals(twentyNine.ok, false);
});

Deno.test("validateSummary (RELAXED): 6 body paragraphs is fine, 7 is a violation (boundary)", () => {
  const paragraph = (n: number) =>
    `Paragraph number ${n} with enough distinct filler content padded out well past the RELAXED ` +
    "profile's 150-character minimum so this boundary test isn't accidentally failing on length instead of count.";
  const six = validateSummary(
    makeValidSummary({
      body_en: [paragraph(1), paragraph(2), paragraph(3), paragraph(4), paragraph(5), paragraph(6)],
    }),
    RELAXED_PROFILE,
  );
  assertEquals(six.ok, true);

  const seven = validateSummary(
    makeValidSummary({
      body_en: [
        paragraph(1),
        paragraph(2),
        paragraph(3),
        paragraph(4),
        paragraph(5),
        paragraph(6),
        paragraph(7),
      ],
    }),
    RELAXED_PROFILE,
  );
  assertEquals(seven.ok, false);
});

Deno.test("validateSummary (RELAXED): a 150-char paragraph is fine, 149 chars is a violation (boundary)", () => {
  const base = makeValidSummary();
  const at150 = validateSummary(
    makeValidSummary({ body_en: ["x".repeat(150), base.body_en[1]] }),
    RELAXED_PROFILE,
  );
  assertEquals(at150.ok, true);

  const at149 = validateSummary(
    makeValidSummary({ body_en: ["x".repeat(149), base.body_en[1]] }),
    RELAXED_PROFILE,
  );
  assertEquals(at149.ok, false);
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

Deno.test("validateSummary: the prompt's own few-shot example passes STRICT (guards against prompt/validator drift)", () => {
  const result = validateSummary(FEW_SHOT_EXAMPLE_SUMMARY, STRICT_PROFILE);
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

Deno.test("validateSummary: the prompt's own few-shot example ALSO passes RELAXED (same example serves both tiers)", () => {
  const result = validateSummary(FEW_SHOT_EXAMPLE_SUMMARY, RELAXED_PROFILE);
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
});

// --- Prompt parameterization: no drift between the prompt text and the profile it was built from ---

Deno.test("buildSystemPrompt: STRICT prompt states STRICT's own numbers", () => {
  const prompt = buildSystemPrompt(STRICT_PROFILE);
  assertEquals(prompt.includes("at least 200 characters"), true);
  assertEquals(prompt.includes("2-4 self-contained"), true);
  assertEquals(prompt.includes("300-700 characters"), true);
  assertEquals(prompt.includes("4-7 items"), true);
  assertEquals(prompt.includes("40-220 characters each"), true);
});

Deno.test("buildSystemPrompt: RELAXED prompt states RELAXED's own numbers, not STRICT's", () => {
  const prompt = buildSystemPrompt(RELAXED_PROFILE);
  assertEquals(prompt.includes("at least 150 characters"), true);
  assertEquals(prompt.includes("2-6 self-contained"), true);
  assertEquals(prompt.includes("150-700 characters"), true);
  assertEquals(prompt.includes("3-7 items"), true);
  assertEquals(prompt.includes("30-220 characters each"), true);
  assertEquals(prompt.includes("at least 200 characters"), false);
  assertEquals(prompt.includes("2-4 self-contained"), false);
});

// --- Profile selection is fixed per summarize function, not a caller option ---

Deno.test("summarizeArticleWithWorkersAi accepts a summary that clears RELAXED but would fail STRICT", async () => {
  // 160-char tldr: fails STRICT's 200-char floor, clears RELAXED's 150.
  const relaxedOnly = { ...makeValidSummary(), tldr_ru: "x".repeat(160), tldr_en: "x".repeat(160) };
  assertEquals(validateSummary(relaxedOnly, STRICT_PROFILE).ok, false);
  assertEquals(validateSummary(relaxedOnly, RELAXED_PROFILE).ok, true);

  const ai = makeStubAi(() => ({ response: relaxedOnly }));
  const result = await summarizeArticleWithWorkersAi(ai, "model", "Title", "text");
  assertEquals(result, relaxedOnly);
});

Deno.test("summarizeArticle (gateway/direct) rejects a summary that only clears RELAXED, not STRICT", async () => {
  const relaxedOnly = { ...makeValidSummary(), tldr_ru: "x".repeat(160), tldr_en: "x".repeat(160) };
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
    assertEquals(secondMessage.includes("tldr_ru must be at least 200 characters"), true);
    assertEquals(secondMessage.includes("tldr_en must be at least 200 characters"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
