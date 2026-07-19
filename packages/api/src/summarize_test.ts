import "./env.d.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  buildAnthropicRequest,
  parseSummaryJson,
  parseWorkersAiResult,
  renderSummaryMarkdown,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
} from "./summarize.ts";

function makeStubAi(handler: (model: string, input: Record<string, unknown>) => unknown): Ai {
  return {
    run(model: string, input: unknown): Promise<unknown> {
      return Promise.resolve(handler(model, input as Record<string, unknown>));
    },
  };
}

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Title",
  tldr_ru: "Кратко.",
  tldr_en: "Short.",
  bullets_ru: ["Пункт 1", "Пункт 2", "Пункт 3"],
  bullets_en: ["Point 1", "Point 2", "Point 3"],
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
      "anthropic api error: model output did not match the required schema after retry",
    );
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("summarizeArticle: retry-exhausted error is 'ai gateway error' prefixed in gateway mode", async () => {
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
      "ai gateway error: model output did not match the required schema after retry",
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

const VALID_SUMMARY_2 = {
  title_ru: "Заголовок 2",
  title_en: "Title 2",
  tldr_ru: "Кратко 2.",
  tldr_en: "Short 2.",
  bullets_ru: ["А", "Б", "В"],
  bullets_en: ["A", "B", "C"],
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

Deno.test("summarizeArticleWithWorkersAi: fails after two broken responses with a workers-ai-prefixed error", async () => {
  let calls = 0;
  const ai = makeStubAi(() => {
    calls += 1;
    return { response: "still not json" };
  });

  await assertRejects(
    () => summarizeArticleWithWorkersAi(ai, "test-model", "Title", "Body text"),
    Error,
    "workers ai error:",
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
    "workers ai error: binding call failed: model not found",
  );
});
