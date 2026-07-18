import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { runSummarization } from "./pipeline.ts";

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Title",
  tldr_ru: "Кратко.",
  tldr_en: "Short.",
  bullets_ru: ["Пункт 1"],
  bullets_en: ["Point 1"],
  tags: ["tag"],
  lang_original: "en",
};

function anthropicSuccessResponse(): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
    { status: 200 },
  );
}

function makeEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called for this branch");
      },
    },
    SUMMARY_MODEL: "test-anthropic-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    ...overrides,
  };
}

Deno.test("runSummarization: AI_GATEWAY_URL set -> gateway mode (even if ANTHROPIC_API_KEY is also set)", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    calledUrl = input.toString();
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  try {
    const env = makeEnv({
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
      CF_AIG_TOKEN: "gw-token",
      ANTHROPIC_API_KEY: "sk-direct-should-not-matter",
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(
      calledUrl,
      "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic/v1/messages",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runSummarization: no AI_GATEWAY_URL, ANTHROPIC_API_KEY set -> direct mode", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    calledUrl = input.toString();
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  try {
    const env = makeEnv({ ANTHROPIC_API_KEY: "sk-direct" });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(calledUrl, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runSummarization: neither secret set -> Workers AI mode (zero-config default)", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  let aiCalledWithModel: string | undefined;
  try {
    const env = makeEnv({
      AI: {
        run(model: string): Promise<unknown> {
          aiCalledWithModel = model;
          return Promise.resolve({ response: VALID_SUMMARY });
        },
      },
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(aiCalledWithModel, "test-workers-ai-model");
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
