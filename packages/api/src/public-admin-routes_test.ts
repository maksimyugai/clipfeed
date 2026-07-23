import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { insertPendingArticle, markArticleFailed } from "./db.ts";
import { FakeQueue } from "./testing/fake_queue.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const JWKS_CACHE_KEY = `access:jwks:${TEAM_DOMAIN}`;

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) — see summarize.ts.
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
    "Price rises from $5 to $8 per month, a nearly 60% increase for new payments.",
    "Existing annual-plan subscribers keep their price until their plan renews.",
    "The company delayed the increase for over a year and a half before acting.",
    "No competitor has announced a comparable price change so far this year.",
  ],
  tags: ["technology"],
  lang_original: "en",
};

// Long enough that extraction clears pipeline.ts's MIN_EXTRACTED_TEXT_CHARS
// (300) guard.
const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content, with enough extra words to " +
  "comfortably clear the minimum extraction length used by the pipeline's insufficient-text " +
  "guard in tests.</p>" +
  "<p>Here is a second paragraph with more detail to summarize, padded a little further so the " +
  "combined extracted text safely stays well above that threshold even after Readability trims " +
  "whitespace.</p></article></body></html>";

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
      delete(key: string): Promise<void> {
        kv.delete(key);
        return Promise.resolve();
      },
      list(
        options?: { prefix?: string },
      ): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
        const prefix = options?.prefix ?? "";
        const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return Promise.resolve({ keys, list_complete: true });
      },
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("<html>spa shell</html>")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    PUBLIC_BASE_URL: "",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
    DIGEST_HOUR_UTC: "6",
    ANTHROPIC_API_KEY: "test-key",
    ...overrides,
  };
}

async function makeOwnerContext(
  overrides: Partial<Env> = {},
): Promise<{ env: Env; authHeaders: Record<string, string> }> {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, ...overrides });
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

function stubFetch(opts: { anthropicStatus?: number } = {}): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input.toString();
    if (url.startsWith("https://api.anthropic.com")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
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

// --- Public reads: reachable with zero auth, in every Access state ---

Deno.test("public reads: /api/health, /api/config, /api/articles, /api/articles/:id all 200 w/o auth (Access unconfigured)", async () => {
  const env = makeEnv();
  const ctx = makeExecutionContext().ctx;

  assertEquals((await app.request("/api/health", {}, env, ctx)).status, 200);
  assertEquals((await app.request("/api/config", {}, env, ctx)).status, 200);
  assertEquals((await app.request("/api/articles", {}, env, ctx)).status, 200);
  assertEquals((await app.request("/api/articles/does-not-exist", {}, env, ctx)).status, 404); // reached the handler
  assertEquals((await app.request("/api/search?q=widget", {}, env, ctx)).status, 200);
});

Deno.test("public reads: still 200 w/o auth even when Access IS configured", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  assertEquals((await app.request("/api/health", {}, env, ctx)).status, 200);
  assertEquals((await app.request("/api/articles", {}, env, ctx)).status, 200);
});

// --- GET /api/admin/articles vs GET /api/articles: owner sees the real
// error, a visitor never does (see articles_test.ts's dedicated privacy
// regression test for the incident this fixes) ---

Deno.test("GET /api/admin/articles: 200 for the owner, includes the real error field; GET /api/articles omits it for the same row", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  await insertPendingArticle(env.DB, {
    id: "al1",
    url: "https://example.com/al1",
    title: "al1",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, "al1", "internal: fetch: upstream responded 500");

  const adminRes = await app.request("/api/admin/articles", { headers: authHeaders }, env, ctx);
  assertEquals(adminRes.status, 200);
  const adminBody = await adminRes.json();
  const adminItem = adminBody.items.find((i: { id: string }) => i.id === "al1");
  assertEquals(adminItem.error, "internal: fetch: upstream responded 500");
  assertEquals("full_text" in adminItem, false);

  const publicRes = await app.request("/api/articles", {}, env, ctx);
  const publicBody = await publicRes.json();
  const publicItem = publicBody.items.find((i: { id: string }) => i.id === "al1");
  assertEquals("error" in publicItem, false);
  assertEquals(publicItem.has_error, true);
});

// --- Admin routes: 401 without a token, both configured and unconfigured ---

Deno.test("admin routes: 401 auth_not_configured on every mutating route when Access isn't set up", async () => {
  const env = makeEnv();
  const ctx = makeExecutionContext().ctx;
  const cases: Array<[string, string]> = [
    ["GET", "/api/admin/me"],
    ["GET", "/api/admin/articles"],
    ["GET", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles"],
    ["PATCH", "/api/admin/articles/some-id"],
    ["DELETE", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles/some-id/retry"],
    ["POST", "/api/admin/articles/some-id/resummarize"],
    ["POST", "/api/admin/articles/some-id/translate"],
    ["POST", "/api/admin/articles/some-id/reverify"],
    ["POST", "/api/admin/agent/run"],
    ["GET", "/api/admin/health-report"],
    ["POST", "/api/admin/heal/revalidate-failed"],
    ["POST", "/api/admin/tags/normalize"],
    ["GET", "/api/admin/search?q=widget"],
    ["POST", "/api/admin/embeddings/backfill"],
    ["GET", "/api/admin/curation/blocked"],
    ["DELETE", "/api/admin/curation/autoblock"],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(path, { method }, env, ctx);
    assertEquals(res.status, 401, `${method} ${path}`);
    const body = await res.json();
    assertEquals(body.error, "auth_not_configured", `${method} ${path}`);
  }
});

Deno.test("admin routes: 401 unauthorized on every mutating route when configured but no token is sent", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const cases: Array<[string, string]> = [
    ["GET", "/api/admin/me"],
    ["GET", "/api/admin/articles"],
    ["GET", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles"],
    ["PATCH", "/api/admin/articles/some-id"],
    ["DELETE", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles/some-id/retry"],
    ["POST", "/api/admin/articles/some-id/resummarize"],
    ["POST", "/api/admin/articles/some-id/translate"],
    ["POST", "/api/admin/articles/some-id/reverify"],
    ["POST", "/api/admin/agent/run"],
    ["GET", "/api/admin/health-report"],
    ["POST", "/api/admin/heal/revalidate-failed"],
    ["POST", "/api/admin/tags/normalize"],
    ["GET", "/api/admin/search?q=widget"],
    ["POST", "/api/admin/embeddings/backfill"],
    ["GET", "/api/admin/curation/blocked"],
    ["DELETE", "/api/admin/curation/autoblock"],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(path, { method }, env, ctx);
    assertEquals(res.status, 401, `${method} ${path}`);
    const body = await res.json();
    assertEquals(body.error, "unauthorized", `${method} ${path}`);
  }
});

Deno.test("GET /api/admin/health-report: 200 for the owner, returns the self-healing summary", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  await insertPendingArticle(env.DB, {
    id: "h1",
    url: "https://example.com/h1",
    title: "h1",
    source: "example.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, "h1", "daily-limit"); // transient

  await insertPendingArticle(env.DB, {
    id: "h2",
    url: "https://thin.example.com/h2",
    title: "h2",
    source: "thin.example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-02T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, "h2", "extraction: insufficient text (3 chars)"); // permanent

  await env.CACHE.put("thinhost:learned.example.com", "3");
  const today = new Date().toISOString().slice(0, 10);
  await env.CACHE.put(`llm_calls:${today}`, "7");
  await env.CACHE.put(`faithfulness_calls:${today}`, "4");

  const res = await app.request("/api/admin/health-report", { headers: authHeaders }, env, ctx);
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.failed_by_class.transient, 1);
  assertEquals(body.failed_by_class.permanent, 1);
  assertEquals(body.heal_attempts_totals.transient, 0);
  assertEquals(body.learned_thinhosts, [{ host: "learned.example.com", count: 3 }]);
  assertEquals(body.last_agent_run.last_added_at, "2026-01-01T00:00:00.000Z");
  assertEquals(body.llm_calls, { used: 7, limit: env.DAILY_SUMMARY_LIMIT });
  // h1/h2 never had a faithfulness check run — both land in the null bucket.
  assertEquals(body.faithfulness, { pass: 0, weak: 0, fail: 0, null: 2, judge_calls_today: 4 });

  // Task 33 §8: the curation section — config blocklist (from the real
  // committed blocklist.json), auto-learned entries, per-source stats, and
  // preferred-but-blocked conflicts, all in one response.
  assertEquals(body.curation.blocked.config.includes("wsj.com"), true);
  assertEquals(body.curation.sources, []); // no agent-added rows in this test
});

// --- Task 33: GET /api/admin/curation/blocked, DELETE .../autoblock ---

Deno.test("GET /api/admin/curation/blocked: 200 for the owner, includes config blocklist + auto entries + conflicts", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  // "phoronix.com" is both a real preferredDomains entry (curation.json)
  // AND, here, deliberately also autoblocked — a live conflict.
  await env.CACHE.put(
    "autoblock:phoronix.com",
    JSON.stringify({
      firstSeen: "2026-01-01T00:00:00.000Z",
      score: 5,
      lastReason: "page has no substantive article text",
    }),
  );

  const res = await app.request("/api/admin/curation/blocked", { headers: authHeaders }, env, ctx);
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.config.includes("wsj.com"), true);
  assertEquals(body.auto.length, 1);
  assertEquals(body.auto[0].domain, "phoronix.com");
  assertEquals(body.auto[0].score, 5);
  assertEquals(body.conflicts, [{ domain: "phoronix.com", layer: "auto" }]);
});

Deno.test("DELETE /api/admin/curation/autoblock: clears the entry, normalizes free-form input, 400 on an invalid hostname", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  await env.CACHE.put(
    "autoblock:flaky.example",
    JSON.stringify({ firstSeen: "2026-01-01T00:00:00.000Z", score: 3, lastReason: "x" }),
  );
  await env.CACHE.put("autostat:flaky.example", "3");

  const res = await app.request(
    "/api/admin/curation/autoblock",
    {
      method: "DELETE",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "https://www.Flaky.example/some/path" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, {
    domain: "flaky.example",
    cleared: true,
    note: "config-file blocklist entries require editing blocklist.json in your fork",
  });
  assertEquals(await env.CACHE.get("autoblock:flaky.example"), null);
  assertEquals(await env.CACHE.get("autostat:flaky.example"), null);

  const badRes = await app.request(
    "/api/admin/curation/autoblock",
    {
      method: "DELETE",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "not a hostname" }),
    },
    env,
    ctx,
  );
  assertEquals(badRes.status, 400);
});

// Task 33 §2: manual/extension/telegram adds are NEVER blocked (owner
// intent overrides), but the 202 carries an advisory warning.
Deno.test("POST /api/admin/articles: a blocked domain still saves (202), but the response carries {warning:'blocked_domain'}", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  // wsj.com is in the real, committed blocklist.json.
  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.wsj.com/articles/some-story" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(body.status, "pending");
  assertEquals(body.warning, "blocked_domain");
});

Deno.test("POST /api/admin/articles: a non-blocked domain saves with no warning field at all", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/some-story" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals("warning" in body, false);
});

// --- POST /api/admin/articles/:id/reverify (Task 23) ---

Deno.test("POST /api/admin/articles/:id/reverify: 404 for a missing id", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request(
    "/api/admin/articles/does-not-exist/reverify",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 404);
});

Deno.test("POST /api/admin/articles/:id/reverify: 409 for an article with no stored summary yet", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  await insertPendingArticle(env.DB, {
    id: "rv-pending",
    url: "https://example.com/rv-pending",
    title: "rv-pending",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const res = await app.request(
    "/api/admin/articles/rv-pending/reverify",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 409);
});

Deno.test("POST /api/admin/articles/:id/reverify: 202 for a ready article, re-runs the judge and writes only the faithfulness columns", async () => {
  const { env, authHeaders } = await makeOwnerContext({
    AI: {
      run: () =>
        Promise.resolve({
          response: JSON.stringify({
            claims: [{ i: 1, verdict: "supported", evidence: "x" }],
            notes: "",
          }),
        }),
    },
  });
  const ctx = makeExecutionContext();

  const stopFetch = stubFetch();
  try {
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/rv-ready" }),
      },
      env,
      ctx.ctx,
    );
    await ctx.settle();
  } finally {
    stopFetch();
  }

  const rowsOf = () => (env.DB as unknown as { rows: Record<string, unknown>[] }).rows;
  const readyId = rowsOf().find((r) => r.url === "https://example.com/rv-ready")!.id as string;
  const beforeSummaryJson = rowsOf().find((r) => r.id === readyId)!.summary_json;

  const res = await app.request(
    `/api/admin/articles/${readyId}/reverify`,
    { method: "POST", headers: authHeaders },
    env,
    ctx.ctx,
  );
  assertEquals(res.status, 202);
  await ctx.settle();

  const row = rowsOf().find((r) => r.id === readyId)!;
  assertEquals(row.faithfulness_verdict, "pass");
  assertEquals(row.status, "ready"); // reverify never changes status
  assertEquals(row.summary_json, beforeSummaryJson); // nor the summary itself
});

Deno.test("POST /api/admin/articles/:id/reverify: 401 without auth even for an existing article (covered by the auth-matrix test above, spot-checked here too)", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  await insertPendingArticle(env.DB, {
    id: "rv-noauth",
    url: "https://example.com/rv-noauth",
    title: "rv-noauth",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const res = await app.request(
    "/api/admin/articles/rv-noauth/reverify",
    { method: "POST" },
    env,
    ctx,
  );
  assertEquals(res.status, 401);
});

// --- POST /api/admin/articles/:id/translate (Task 35 Part A §3) ---

Deno.test("POST /api/admin/articles/:id/translate: 404 for a missing id", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request(
    "/api/admin/articles/does-not-exist/translate",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 404);
});

Deno.test("POST /api/admin/articles/:id/translate: 409 for a pending article (not ready yet)", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  await insertPendingArticle(env.DB, {
    id: "tr-pending",
    url: "https://example.com/tr-pending",
    title: "tr-pending",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const res = await app.request(
    "/api/admin/articles/tr-pending/translate",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 409);
});

Deno.test("POST /api/admin/articles/:id/translate: 202 for a ready article, generates EN fields from full_text and merges them without touching RU content", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext();

  const stopFetch = stubFetch();
  let created: { id: string };
  try {
    created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/tr-ready" }),
        },
        env,
        ctx.ctx,
      )
    ).json();
    await ctx.settle();
  } finally {
    stopFetch();
  }

  const beforeReady = await (
    await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx.ctx)
  ).json();
  assertEquals(beforeReady.status, "ready");
  assertEquals(beforeReady.en_generated_at, null);
  assertEquals(beforeReady.summary_json.title_en, undefined);

  // A second stub, so a failure to skip re-fetching would be visible: this
  // one serves different HTML than the first, but generateEnglishFields
  // reads the ALREADY-STORED full_text (see runEnglishTranslation), never
  // re-fetching the article's URL — so the EN fields below being the
  // stubbed VALID_SUMMARY's EN content, not derived from this HTML, proves
  // the generation path used the stored text.
  let anthropicCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const urlText = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    let parsed: URL;
    try {
      parsed = new URL(urlText);
    } catch {
      throw new Error("translate must not re-fetch the article's own URL");
    }

    if (parsed.protocol === "https:" && parsed.hostname === "api.anthropic.com") {
      anthropicCallCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
          { status: 200 },
        ),
      );
    }
    throw new Error("translate must not re-fetch the article's own URL");
  }) as typeof fetch;

  try {
    const res = await app.request(
      `/api/admin/articles/${created.id}/translate`,
      { method: "POST", headers: authHeaders },
      env,
      ctx.ctx,
    );
    assertEquals(res.status, 202);
    const body = await res.json();
    assertEquals(body.status, "pending");
    await ctx.settle();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(anthropicCallCount, 1);

  const translated = await (
    await app.request(`/api/admin/articles/${created.id}`, { headers: authHeaders }, env, ctx.ctx)
  ).json();
  assertEquals(typeof translated.en_generated_at, "string");
  assertEquals(translated.summary_json.title_en, VALID_SUMMARY.title_en);
  assertEquals(translated.summary_json.tldr_en, VALID_SUMMARY.tldr_en);
  // RU content and status are untouched by the translate job.
  assertEquals(translated.summary_json.title_ru, beforeReady.summary_json.title_ru);
  assertEquals(translated.status, "ready");
});

Deno.test("POST /api/admin/articles/:id/translate: idempotent — a second call after en_generated_at is set is a 200 no-op, no new queue job", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const ctx = makeExecutionContext().ctx;

  await insertPendingArticle(env.DB, {
    id: "tr-done",
    url: "https://example.com/tr-done",
    title: "tr-done",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const db = env.DB as unknown as FakeD1;
  const row = db.rows.find((r) => r.id === "tr-done")!;
  row.status = "ready";
  row.full_text = "Enough stored text to translate from.";
  row.summary_json = JSON.stringify({ title_ru: "Заголовок", tags: [], lang_original: "en" });
  row.en_generated_at = "2026-01-01T12:00:00.000Z";

  const res = await app.request(
    "/api/admin/articles/tr-done/translate",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "already-translated");
  assertEquals(jobs.sent.length, 0);
});

Deno.test("POST /api/admin/articles/:id/translate: 401 without auth even for an existing article (covered by the auth-matrix test above, spot-checked here too)", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  await insertPendingArticle(env.DB, {
    id: "tr-noauth",
    url: "https://example.com/tr-noauth",
    title: "tr-noauth",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const res = await app.request(
    "/api/admin/articles/tr-noauth/translate",
    { method: "POST" },
    env,
    ctx,
  );
  assertEquals(res.status, 401);
});

Deno.test("POST /api/admin/heal/revalidate-failed: re-enqueues every summary-validation failure regardless of heal_attempts, resets the count first", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const ctx = makeExecutionContext().ctx;

  // Already at its heal cap (unknown class -> cap 1) — the normal healing
  // sweep would never retry this again, but the rescue endpoint ignores
  // the cap entirely for exactly this failure shape.
  await insertPendingArticle(env.DB, {
    id: "sv1",
    url: "https://example.com/sv1",
    title: "sv1",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(
    env.DB,
    "sv1",
    "internal: summarize: summary validation: body_en[0] must be between 300 and 700 characters (got 737)",
  );
  const rowsOf = () => (env.DB as unknown as { rows: Record<string, unknown>[] }).rows;
  rowsOf().find((r) => r.id === "sv1")!.heal_attempts = 1;

  // A different failure shape — must be left alone.
  await insertPendingArticle(env.DB, {
    id: "other-fail",
    url: "https://example.com/other-fail",
    title: "other-fail",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, "other-fail", "daily-limit");

  const res = await app.request(
    "/api/admin/heal/revalidate-failed",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(body.count, 1);

  assertEquals(jobs.sent, [{ kind: "process", articleId: "sv1" }]);
  const sv1 = rowsOf().find((r) => r.id === "sv1")!;
  assertEquals(sv1.heal_attempts, 0);
  assertEquals(sv1.status, "pending");
});

Deno.test("POST /api/admin/heal/revalidate-failed: no-op (count 0) when there's nothing to rescue", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const ctx = makeExecutionContext().ctx;

  const res = await app.request(
    "/api/admin/heal/revalidate-failed",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { count: 0 });
  assertEquals(jobs.sent, []);
});

Deno.test("POST /api/admin/tags/normalize: backfills existing rows, returns {updated: n}, idempotent second run", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  await insertPendingArticle(env.DB, {
    id: "tn1",
    url: "https://example.com/tn1",
    title: "tn1",
    source: "example.com",
    tags: [], // normalized on insert already — bypass that by writing raw below
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const rowsOf = () => (env.DB as unknown as { rows: Record<string, unknown>[] }).rows;
  rowsOf().find((r) => r.id === "tn1")!.tags = JSON.stringify(["ИИ", "ai", "таймаут"]);

  const first = await app.request(
    "/api/admin/tags/normalize",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(first.status, 200);
  assertEquals(await first.json(), { updated: 1 });
  assertEquals(JSON.parse(rowsOf().find((r) => r.id === "tn1")!.tags as string), ["ai"]);

  const second = await app.request(
    "/api/admin/tags/normalize",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(await second.json(), { updated: 0 });
});

Deno.test("POST /api/admin/agent/run: 202 for the owner, runs the agent job via waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  // All six real sources.json URLs fail — the job still completes cleanly
  // with zero picks, since fetchAllCandidates isolates per-source errors.
  globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch;
  try {
    const { env, authHeaders } = await makeOwnerContext();
    const { ctx, settle } = makeExecutionContext();

    const res = await app.request(
      "/api/admin/agent/run",
      { method: "POST", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    const body = await res.json();
    assertEquals(body.ok, true);

    await settle();
    // No candidates -> no rows written; the important assertion is that
    // waitUntil resolved without throwing.
    const db = env.DB as unknown as FakeD1;
    assertEquals(db.rows.filter((r) => r.added_via === "agent").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("admin routes: 401 unauthorized with a bad token", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request(
    "/api/admin/articles/some-id",
    { headers: { "Cf-Access-Jwt-Assertion": "not-a-real-jwt" } },
    env,
    ctx,
  );
  assertEquals(res.status, 401);
});

// --- GET /api/admin/me: both modes ---

Deno.test("GET /api/admin/me: 200 with sub/email when authenticated", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request("/api/admin/me", { headers: authHeaders }, env, ctx);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.sub, "owner-1");
  assertEquals(body.email, "owner@example.com");
});

Deno.test("GET /api/admin/me: 401 when not authenticated", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request("/api/admin/me", {}, env, ctx);
  assertEquals(res.status, 401);
});

// --- Public vs admin data hygiene on the same article ---

Deno.test("public GET /api/articles/:id excludes full_text/error, has_error reflects failure state", async () => {
  const { env, authHeaders } = await makeOwnerContext({ DAILY_SUMMARY_LIMIT: 0 });
  const { ctx, settle } = makeExecutionContext();
  const restoreFetch = stubFetch();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/hygiene-failed" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const publicRes = await app.request(`/api/articles/${created.id}`, {}, env, ctx);
    assertEquals(publicRes.status, 200);
    const publicArticle = await publicRes.json();
    assertEquals("full_text" in publicArticle, false);
    assertEquals("error" in publicArticle, false);
    assertEquals(publicArticle.has_error, true);
    assertEquals(publicArticle.status, "failed");

    const adminRes = await app.request(
      `/api/admin/articles/${created.id}`,
      { headers: authHeaders },
      env,
      ctx,
    );
    const adminArticle = await adminRes.json();
    assertEquals(adminArticle.error, "daily-limit");
    assertEquals(adminArticle.status, "failed");
  } finally {
    restoreFetch();
  }
});

Deno.test("public GET /api/articles/:id: has_error is false and full_text/error are absent for a ready article", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();
  const restoreFetch = stubFetch();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/hygiene-ready" }),
        },
        env,
        ctx,
      )
    ).json();
    await settle();

    const publicRes = await app.request(`/api/articles/${created.id}`, {}, env, ctx);
    const publicArticle = await publicRes.json();
    assertEquals("full_text" in publicArticle, false);
    assertEquals("error" in publicArticle, false);
    assertEquals(publicArticle.has_error, false);
    assertEquals(publicArticle.status, "ready");

    const adminRes = await app.request(
      `/api/admin/articles/${created.id}`,
      { headers: authHeaders },
      env,
      ctx,
    );
    const adminArticle = await adminRes.json();
    assertEquals(typeof adminArticle.full_text, "string");
    assertEquals(adminArticle.full_text.length > 0, true);
    assertEquals(adminArticle.error, null);
  } finally {
    restoreFetch();
  }
});

Deno.test("GET /api/admin/articles/:id: 404 for a missing id (not confused with 401)", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request(
    "/api/admin/articles/does-not-exist",
    { headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 404);
});
