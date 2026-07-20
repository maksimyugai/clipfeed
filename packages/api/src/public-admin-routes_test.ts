import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

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
});

Deno.test("public reads: still 200 w/o auth even when Access IS configured", async () => {
  const { env } = await makeOwnerContext();
  const ctx = makeExecutionContext().ctx;

  assertEquals((await app.request("/api/health", {}, env, ctx)).status, 200);
  assertEquals((await app.request("/api/articles", {}, env, ctx)).status, 200);
});

// --- Admin routes: 401 without a token, both configured and unconfigured ---

Deno.test("admin routes: 401 auth_not_configured on every mutating route when Access isn't set up", async () => {
  const env = makeEnv();
  const ctx = makeExecutionContext().ctx;
  const cases: Array<[string, string]> = [
    ["GET", "/api/admin/me"],
    ["GET", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles"],
    ["PATCH", "/api/admin/articles/some-id"],
    ["DELETE", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles/some-id/retry"],
    ["POST", "/api/admin/articles/some-id/resummarize"],
    ["POST", "/api/admin/agent/run"],
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
    ["GET", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles"],
    ["PATCH", "/api/admin/articles/some-id"],
    ["DELETE", "/api/admin/articles/some-id"],
    ["POST", "/api/admin/articles/some-id/retry"],
    ["POST", "/api/admin/articles/some-id/resummarize"],
    ["POST", "/api/admin/agent/run"],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(path, { method }, env, ctx);
    assertEquals(res.status, 401, `${method} ${path}`);
    const body = await res.json();
    assertEquals(body.error, "unauthorized", `${method} ${path}`);
  }
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
