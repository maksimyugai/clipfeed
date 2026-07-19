import "./env.d.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  buildAnthropicRequest,
  callLlm,
  FEW_SHOT_EXAMPLE_SUMMARY,
  parseSummaryJson,
  parseWorkersAiResult,
  renderSummaryMarkdown,
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

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) so it round-trips
// through both the shape-only parsers and the full summarizeArticle*
// validate-and-retry path used throughout this file.
const VALID_SUMMARY = {
  title_ru: "Компания подняла цену подписки на 60% с 1 сентября",
  title_en: "Company Raises Subscription Price 60% Starting September 1",
  tldr_ru:
    "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы. Изменение затронет около 2 миллионов подписчиков сервиса.",
  tldr_en:
    "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server costs. The change affects roughly 2 million subscribers.",
  bullets_ru: [
    "Цена вырастет с $5 до $8 в месяц — рост на 60%.",
    "Годовые подписчики сохранят текущую цену до продления.",
    "Компания откладывала повышение полтора года.",
  ],
  bullets_en: [
    "Price rises from $5 to $8 per month, a 60% increase.",
    "Existing annual-plan subscribers keep their price until renewal.",
    "The company delayed the increase for a year and a half.",
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
    "Команда выпустила версию 4.0 с поддержкой офлайн-режима, позволяющей работать без подключения к интернету. Синхронизация данных происходит автоматически при восстановлении сети.",
  tldr_en:
    "The team shipped version 4.0 with offline mode support, letting users work without an internet connection. Data syncs automatically once the connection is restored.",
  bullets_ru: [
    "Кеш ограничен 500 МБ на устройство.",
    "Конфликты правок разрешаются в пользу последней сохранённой версии.",
    "Обновление доступно всем пользователям бесплатно.",
  ],
  bullets_en: [
    "The local cache is capped at 500 MB per device.",
    "Edit conflicts resolve in favor of the most recently saved version.",
    "The update is available to all users at no cost.",
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
      "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы. Изменение затронет около 2 миллионов подписчиков сервиса.",
    tldr_en:
      "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server costs. The change affects roughly 2 million subscribers.",
    bullets_ru: [
      "Цена вырастет с $5 до $8 в месяц — рост на 60%.",
      "Годовые подписчики сохранят текущую цену до продления.",
      "Компания откладывала повышение полтора года.",
    ],
    bullets_en: [
      "Price rises from $5 to $8 per month, a 60% increase.",
      "Existing annual-plan subscribers keep their price until renewal.",
      "The company delayed the increase for a year and a half.",
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

Deno.test("validateSummary: tldr under 120 chars is a violation", () => {
  const result = validateSummary(makeValidSummary({ tldr_ru: "Слишком коротко." }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("tldr_ru") && v.includes("120")),
      true,
    );
  }
});

Deno.test("validateSummary: tldr at exactly 120 chars is fine (boundary)", () => {
  const result = validateSummary(makeValidSummary({ tldr_en: "x".repeat(120) }));
  assertEquals(result.ok, true);
});

Deno.test("validateSummary: fewer than 3 bullets is a violation", () => {
  const result = validateSummary(
    makeValidSummary({ bullets_ru: ["Один пункт длиннее двадцати символов."] }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("bullets_ru") && v.includes("3")), true);
  }
});

Deno.test("validateSummary: more than 6 bullets is a violation", () => {
  const bullets = Array.from(
    { length: 7 },
    (_, i) => `Пункт номер ${i} с достаточной длиной текста.`,
  );
  const result = validateSummary(makeValidSummary({ bullets_ru: bullets }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.violations.some((v) => v.includes("bullets_ru") && v.includes("6")), true);
  }
});

Deno.test("validateSummary: exactly 3 and exactly 6 bullets are both fine (boundaries)", () => {
  const three = validateSummary(
    makeValidSummary({
      bullets_en: [
        "First concrete fact goes here now.",
        "Second concrete fact goes here now.",
        "Third concrete fact goes here now.",
      ],
    }),
  );
  assertEquals(three.ok, true);

  const six = validateSummary(
    makeValidSummary({
      bullets_en: Array.from({ length: 6 }, (_, i) => `Concrete fact number ${i} in the list.`),
    }),
  );
  assertEquals(six.ok, true);
});

Deno.test("validateSummary: a bullet under 20 chars is a violation", () => {
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        "Too short.",
        "Second concrete fact goes here now.",
        "Third concrete fact goes here now.",
      ],
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.violations.some((v) => v.includes("bullets_en[0]") && v.includes("20")),
      true,
    );
  }
});

Deno.test("validateSummary: a bullet over 220 chars is a violation", () => {
  const result = validateSummary(
    makeValidSummary({
      bullets_en: [
        "x".repeat(221),
        "Second concrete fact goes here now.",
        "Third concrete fact goes here now.",
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
    "The company is raising its subscription price from five dollars to eight dollars a month starting soon.";
  const duplicateBullet =
    "The company is raising its subscription price from five dollars to eight.";
  const result = validateSummary(
    makeValidSummary({
      tldr_en: tldr,
      bullets_en: [
        duplicateBullet,
        "Second concrete fact goes here now.",
        "Third concrete fact goes here now.",
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
  assertEquals(result.ok, true);
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

Deno.test("validateSummary: minTldrChars option lowers the bar (mode-aware threshold)", () => {
  const shortTldrSummary = makeValidSummary({
    tldr_ru: "Компания подняла цену подписки с $5 до $8 в этом месяце.", // ~58 chars
    tldr_en: "The company raised its subscription price from $5 to $8.", // ~59 chars
  });
  assertEquals(validateSummary(shortTldrSummary).ok, false);
  assertEquals(validateSummary(shortTldrSummary, { minTldrChars: 50 }).ok, true);
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

Deno.test("validateSummary: the prompt's own few-shot example passes validation (guards against prompt/validator drift)", () => {
  const result = validateSummary(FEW_SHOT_EXAMPLE_SUMMARY);
  assertEquals(result.ok, true, JSON.stringify(!result.ok ? result.violations : []));
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
    assertEquals(secondMessage.includes("tldr_ru must be at least 120 characters"), true);
    assertEquals(secondMessage.includes("tldr_en must be at least 120 characters"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
