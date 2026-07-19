import "./env.d.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const JWKS_CACHE_KEY = `access:jwks:${TEAM_DOMAIN}`;

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) — see summarize.ts.
// Keeps the "Кратко."/"Short summary." lead-ins and "technology" tag the
// assertions below check for.
const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Example Title",
  tldr_ru:
    "Кратко. Компания повысила стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик.",
  tldr_en:
    "Short summary. The company raised its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs.",
  bullets_ru: [
    "Цена вырастет с $5 до $8 в месяц — рост на 60%.",
    "Годовые подписчики сохранят текущую цену до продления.",
    "Компания откладывала повышение полтора года.",
  ],
  bullets_en: [
    "Point 1 covers pricing.",
    "Point 2 covers rollout timing.",
    "Point 3 covers scope.",
  ],
  tags: ["technology"],
  lang_original: "en",
};

const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content.</p>" +
  "<p>Here is a second paragraph with more detail to summarize.</p></article></body></html>";

// A second, distinct compliant summary — used to prove a resummarize call
// actually produced NEW content, not just re-persisted the old one.
const RESUMMARIZED_SUMMARY = {
  title_ru: "Обновлённый заголовок",
  title_en: "Updated Title",
  tldr_ru:
    "Обновлённый пересказ. После повторного анализа компания уточнила детали повышения цены подписки и сроки перехода на новый тариф.",
  tldr_en:
    "Updated summary. After a fresh pass, the company clarified the pricing change details and the rollout timeline for the new tier.",
  bullets_ru: [
    "Уточнена дата вступления изменений в силу.",
    "Добавлены детали о переходном периоде для действующих клиентов.",
    "Обновлён список затронутых регионов.",
  ],
  bullets_en: [
    "The effective date was clarified.",
    "Added detail on the transition period for existing customers.",
    "Updated the list of affected regions.",
  ],
  tags: ["technology", "pricing"],
  lang_original: "en",
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

async function exportJwk(publicKey: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey) as Record<string, unknown>;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

async function signJwt(privateKey: CryptoKey, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    sub: "owner-1",
    email: "owner@example.com",
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    iat: now - 10,
    exp: now + 3600,
    nbf: now - 10,
  };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

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
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called — these tests configure direct/gateway mode");
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
    ANTHROPIC_API_KEY: "test-key",
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    ...overrides,
  };
}

// All mutating routes moved under /api/admin/* and now require a verified
// Access identity — every test in this file exercises the owner flow, so
// build one configured env + a valid token's auth header up front.
async function makeOwnerContext(
  overrides: Partial<Env> = {},
): Promise<{ env: Env; authHeaders: Record<string, string> }> {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const env = makeEnv(overrides);
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify({ keys: [jwk] }));
  const token = await signJwt(privateKey, "kid-1");
  return { env, authHeaders: { "Cf-Access-Jwt-Assertion": token } };
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

Deno.test("POST /api/admin/articles: 202 immediately, then row becomes ready with summaries", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    const res = await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
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

    const getRes = await app.request(
      `/api/admin/articles/${created.id}`,
      { headers: authHeaders },
      env,
      ctx,
    );
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

Deno.test("POST /api/admin/articles: rejects duplicate url with 409 and the existing id", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    const first = await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      },
      env,
      ctx,
    );
    const { id } = await first.json();
    await settle();

    const second = await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
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

Deno.test("POST /api/admin/articles: rejects oversized html with 413", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();
  const oversizedHtml = "a".repeat(2 * 1024 * 1024 + 1);

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ url: "https://example.com/big", html: oversizedHtml }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 413);
});

Deno.test("POST /api/admin/articles: rejects a request body over the overall size cap", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();
  const hugeBody = JSON.stringify({
    url: "https://example.com/huge",
    title: "a".repeat(3 * 1024 * 1024 + 1),
  });

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: hugeBody,
    },
    env,
    ctx,
  );
  assertEquals(res.status, 413);
});

Deno.test("POST /api/admin/articles: rejects non-http(s) url with 400", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ url: "ftp://example.com/file" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /api/admin/articles: rejects the request with 401 when no Access token is sent", async () => {
  const { env } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/no-auth" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 401);
});

Deno.test("POST /api/admin/articles: over the daily limit fails the pipeline with 'daily-limit'", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext({ DAILY_SUMMARY_LIMIT: 0 });
  const { ctx, settle } = makeExecutionContext();

  try {
    const res = await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.org/limited" }),
      },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    const { id } = await res.json();

    await settle();

    const getRes = await app.request(
      `/api/admin/articles/${id}`,
      { headers: authHeaders },
      env,
      ctx,
    );
    const article = await getRes.json();
    assertEquals(article.status, "failed");
    assertEquals(article.error, "daily-limit");
  } finally {
    restoreFetch();
  }
});

Deno.test("GET /api/articles: cursor pagination walks the full list (public, no auth needed)", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    for (const path of ["/a", "/b", "/c"]) {
      const res = await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
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

Deno.test("GET /api/articles: sweeps a stale pending row to failed before listing (env.PENDING_TIMEOUT_MIN honored)", async () => {
  const { env, ctx } = { env: makeEnv({ PENDING_TIMEOUT_MIN: 10 }), ...makeExecutionContext() };
  const db = env.DB as unknown as FakeD1;
  db.rows.push({
    id: "stale-1",
    url: "https://example.com/stale",
    canonical_url: null,
    title: "Stale",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    added_via: "manual",
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    tags: "[]",
    status: "pending",
    archived: 0,
    error: null,
  });
  db.rows.push({
    id: "fresh-1",
    url: "https://example.com/fresh",
    canonical_url: null,
    title: "Fresh",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: new Date().toISOString(),
    added_via: "manual",
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    tags: "[]",
    status: "pending",
    archived: 0,
    error: null,
  });

  const res = await app.request("/api/articles", {}, env, ctx);
  const body = await res.json();
  const items = body.items as { id: string; status: string; error: string | null }[];

  assertEquals(items.find((i) => i.id === "stale-1")?.status, "failed");
  assertEquals(
    items.find((i) => i.id === "stale-1")?.error,
    "timeout: processing did not complete",
  );
  assertEquals(items.find((i) => i.id === "fresh-1")?.status, "pending");
});

Deno.test("PATCH /api/admin/articles/:id: updates archived and tags", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/patchme" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const patched = await (
      await app.request(
        `/api/admin/articles/${created.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...authHeaders },
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

Deno.test("DELETE /api/admin/articles/:id: 204 then 404 on subsequent admin get", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/deleteme" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const deleteRes = await app.request(
      `/api/admin/articles/${created.id}`,
      { method: "DELETE", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(deleteRes.status, 204);

    const getRes = await app.request(
      `/api/admin/articles/${created.id}`,
      { headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(getRes.status, 404);
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/admin/articles/:id/retry: re-runs the pipeline for a failed article", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  let restoreFetch = stubFetch({ anthropicStatus: 500 });
  const created = await (
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/retry-me" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();
  restoreFetch();

  const failed = await (
    await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx)
  ).json();
  assertEquals(failed.status, "failed");

  restoreFetch = stubFetch();
  try {
    const retryRes = await app.request(
      `/api/admin/articles/${created.id}/retry`,
      { method: "POST", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(retryRes.status, 202);
    await settle();

    const ready = await (
      await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx)
    ).json();
    assertEquals(ready.status, "ready");
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/admin/articles/:id/resummarize: ready -> resummarize -> ready with NEW summary content, skipping re-fetch of the article", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  let articleFetchCount = 0;
  function isAnthropicUrl(input: string | URL | Request): boolean {
    try {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      return url.protocol === "https:" && url.hostname === "api.anthropic.com";
    } catch {
      return false;
    }
  }
  function stubFetchCounting(anthropicText: string): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      if (isAnthropicUrl(input)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ content: [{ type: "text", text: anthropicText }] }),
            { status: 200 },
          ),
        );
      }
      articleFetchCount += 1;
      return Promise.resolve(
        new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      );
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  let restoreFetch = stubFetchCounting(JSON.stringify(VALID_SUMMARY));
  const created = await (
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/resummarize-me" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();
  restoreFetch();
  assertEquals(articleFetchCount, 1);

  restoreFetch = stubFetchCounting(JSON.stringify(RESUMMARIZED_SUMMARY));
  try {
    const res = await app.request(
      `/api/admin/articles/${created.id}/resummarize`,
      { method: "POST", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    const body = await res.json();
    assertEquals(body.status, "pending");
    await settle();

    // The article's own HTML was never re-fetched — only the anthropic call
    // happened, proving fetch/extract were skipped in favor of the stored
    // full_text.
    assertEquals(articleFetchCount, 1);

    const updated = await (
      await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx)
    ).json();
    assertEquals(updated.status, "ready");
    assertEquals(updated.summary_ru.includes("Обновлённый пересказ"), true);
    assertEquals(updated.summary_json.title_en, "Updated Title");
    // full_text (extracted once, up front) is preserved across resummarize.
    assertEquals(updated.full_text.length > 0, true);
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/admin/articles/:id/resummarize: a failed article with no stored full_text falls back to the full pipeline", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  // Fails before extraction ever runs (network error), so full_text stays
  // null — the row never reaches markArticleReady.
  let restoreFetch = stubFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  const created = await (
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/never-fetched" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();
  globalThis.fetch = originalFetch;

  const failed = await (
    await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx)
  ).json();
  assertEquals(failed.status, "failed");
  assertEquals(failed.full_text, null);

  restoreFetch = stubFetch();
  try {
    const res = await app.request(
      `/api/admin/articles/${created.id}/resummarize`,
      { method: "POST", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    await settle();

    const ready = await (
      await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx)
    ).json();
    assertEquals(ready.status, "ready");
    assertEquals(ready.full_text.length > 0, true);
  } finally {
    restoreFetch();
  }
});

Deno.test("POST /api/admin/articles/:id/resummarize: 404 for a missing id, 409 for a pending article", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();

  const missing = await app.request(
    "/api/admin/articles/does-not-exist/resummarize",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(missing.status, 404);

  // Inserted directly (not via the real pipeline) so the row is
  // deterministically 'pending' — going through a real POST here would race
  // the mocked pipeline's completion against this test's own assertions.
  const db = env.DB as unknown as FakeD1;
  db.rows.push({
    id: "still-pending-1",
    url: "https://example.com/still-pending",
    canonical_url: null,
    title: "Pending",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: new Date().toISOString(),
    added_via: "manual",
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    tags: "[]",
    status: "pending",
    archived: 0,
    error: null,
  });

  const res = await app.request(
    "/api/admin/articles/still-pending-1/resummarize",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 409);
});
