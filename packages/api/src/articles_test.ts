import "./env.d.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import app from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Example Title",
  tldr_ru: "Кратко.",
  tldr_en: "Short summary.",
  bullets_ru: ["П1", "П2", "П3"],
  bullets_en: ["Point 1", "Point 2", "Point 3"],
  tags: ["technology"],
  lang_original: "en",
};

const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content.</p>" +
  "<p>Here is a second paragraph with more detail to summarize.</p></article></body></html>";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    DB: new FakeD1(),
    CACHE: {
      get(key: string): Promise<string | null> {
        return Promise.resolve(kv.get(key) ?? null);
      },
      put(key: string, value: string): Promise<void> {
        kv.set(key, value);
        return Promise.resolve();
      },
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("not used")) },
    SUMMARY_MODEL: "test-model",
    DAILY_SUMMARY_LIMIT: 50,
    ANTHROPIC_API_KEY: "test-key",
    ...overrides,
  };
}

function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      props: {},
      waitUntil(promise: Promise<unknown>): void {
        pending.push(promise);
      },
      passThroughOnException(): void {},
    },
    settle: () => Promise.all(pending),
  };
}

function stubFetch(opts: { anthropicText?: string; anthropicStatus?: number } = {}): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input.toString();
    if (url.startsWith("https://api.anthropic.com")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{
              type: "text",
              text: opts.anthropicText ?? JSON.stringify(VALID_SUMMARY),
            }],
          }),
          { status: opts.anthropicStatus ?? 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test("POST /api/articles: 202 immediately, then row becomes ready with summaries", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  try {
    const res = await app.request(
      "/api/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/article", tags: ["reading"] }),
      },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    const created = await res.json();
    assertEquals(created.status, "pending");
    assertNotEquals(created.id, undefined);

    await settle();

    const getRes = await app.request(`/api/articles/${created.id}`, {}, env, ctx);
    assertEquals(getRes.status, 200);
    const article = await getRes.json();
    assertEquals(article.status, "ready");
    assertEquals(article.summary_en.includes("Short summary."), true);
    assertEquals(article.summary_ru.includes("Кратко."), true);
    assertEquals(article.summary_json.tags[0], "technology");
    assertEquals(article.tags.includes("reading"), true);
    assertEquals(article.tags.includes("technology"), true);
    assertEquals(article.full_text.length > 0, true);
    assertEquals(article.source, "example.com");
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/articles: rejects duplicate url with 409 and the existing id", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  try {
    const first = await app.request(
      "/api/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      },
      env,
      ctx,
    );
    const { id } = await first.json();
    await settle();

    const second = await app.request(
      "/api/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      },
      env,
      ctx,
    );
    assertEquals(second.status, 409);
    const body = await second.json();
    assertEquals(body.id, id);
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/articles: rejects oversized html with 413", async () => {
  const env = makeEnv();
  const { ctx } = makeExecutionContext();
  const oversizedHtml = "a".repeat(2 * 1024 * 1024 + 1);

  const res = await app.request(
    "/api/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/big", html: oversizedHtml }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 413);
});

Deno.test("POST /api/articles: rejects a request body over the overall size cap", async () => {
  const env = makeEnv();
  const { ctx } = makeExecutionContext();
  const hugeBody = JSON.stringify({
    url: "https://example.com/huge",
    title: "a".repeat(3 * 1024 * 1024 + 1),
  });

  const res = await app.request(
    "/api/articles",
    { method: "POST", headers: { "content-type": "application/json" }, body: hugeBody },
    env,
    ctx,
  );
  assertEquals(res.status, 413);
});

Deno.test("POST /api/articles: rejects non-http(s) url with 400", async () => {
  const env = makeEnv();
  const { ctx } = makeExecutionContext();

  const res = await app.request(
    "/api/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com/file" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /api/articles: over the daily limit fails the pipeline with 'daily-limit'", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv({ DAILY_SUMMARY_LIMIT: 0 });
  const { ctx, settle } = makeExecutionContext();

  try {
    const res = await app.request(
      "/api/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.org/limited" }),
      },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    const { id } = await res.json();

    await settle();

    const getRes = await app.request(`/api/articles/${id}`, {}, env, ctx);
    const article = await getRes.json();
    assertEquals(article.status, "failed");
    assertEquals(article.error, "daily-limit");
  } finally {
    restoreFetch();
  }
});

Deno.test("GET /api/articles: cursor pagination walks the full list", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  try {
    for (const path of ["/a", "/b", "/c"]) {
      const res = await app.request(
        "/api/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `https://example.com${path}` }),
        },
        env,
        ctx,
      );
      await res.json();
    }
    await settle();

    const page1 = await (await app.request("/api/articles?limit=2", {}, env, ctx)).json();
    assertEquals(page1.items.length, 2);
    assertNotEquals(page1.next_cursor, null);

    const page2 = await (
      await app.request(`/api/articles?limit=2&cursor=${page1.next_cursor}`, {}, env, ctx)
    ).json();
    assertEquals(page2.items.length, 1);
    assertEquals(page2.next_cursor, null);

    const allIds = [...page1.items, ...page2.items].map((item: { id: string }) => item.id);
    assertEquals(new Set(allIds).size, 3);
    assertEquals("full_text" in page1.items[0], false);
  } finally {
    restoreFetch();
  }
});

Deno.test("PATCH /api/articles/:id: updates archived and tags", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/patchme" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const patched = await (
      await app.request(
        `/api/articles/${created.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true, tags: ["saved"] }),
        },
        env,
        ctx,
      )
    ).json();
    assertEquals(patched.archived, true);
    assertEquals(patched.tags, ["saved"]);
  } finally {
    restoreFetch();
  }
});

Deno.test("DELETE /api/articles/:id: 204 then 404 on subsequent get", async () => {
  const restoreFetch = stubFetch();
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/deleteme" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const deleteRes = await app.request(
      `/api/articles/${created.id}`,
      { method: "DELETE" },
      env,
      ctx,
    );
    assertEquals(deleteRes.status, 204);

    const getRes = await app.request(`/api/articles/${created.id}`, {}, env, ctx);
    assertEquals(getRes.status, 404);
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/articles/:id/retry: re-runs the pipeline for a failed article", async () => {
  const env = makeEnv();
  const { ctx, settle } = makeExecutionContext();

  let restoreFetch = stubFetch({ anthropicStatus: 500 });
  const created = await (
    await app.request(
      "/api/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/retry-me" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();
  restoreFetch();

  const failed = await (await app.request(`/api/articles/${created.id}`, {}, env, ctx)).json();
  assertEquals(failed.status, "failed");

  restoreFetch = stubFetch();
  try {
    const retryRes = await app.request(
      `/api/articles/${created.id}/retry`,
      { method: "POST" },
      env,
      ctx,
    );
    assertEquals(retryRes.status, 202);
    await settle();

    const ready = await (await app.request(`/api/articles/${created.id}`, {}, env, ctx)).json();
    assertEquals(ready.status, "ready");
  } finally {
    restoreFetch();
  }
});
