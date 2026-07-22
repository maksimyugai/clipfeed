import "./env.d.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeQueue } from "./testing/fake_queue.ts";

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
    "Кратко. Компания повысила стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса по всему миру.",
  tldr_en:
    "Short summary. The company raised its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs. The change affects roughly 2 million subscribers worldwide.",
  body_ru: [
    "Компания объявила об изменении во вторник, уточнив, что новый тариф вступит в силу с 1 сентября. Рост стоимости составляет почти 60% по сравнению с текущей ценой. Затронутыми окажутся примерно 2 миллиона подписчиков сервиса, при этом клиенты, уже оформившие годовой план, не почувствуют изменения сразу.",
    "В компании ссылаются на растущие расходы на серверную инфраструктуру и сетевой трафик как на основную причину решения. Руководство отмечало, что откладывало повышение более года, опасаясь навредить клиентам из малого бизнеса, но в итоге пришло к выводу, что дальнейшая отсрочка невозможна из-за продолжающегося роста издержек.",
  ],
  body_en: [
    "The company announced the change on Tuesday, confirming the new rate takes effect September 1. The increase amounts to nearly 60% over the current price. Roughly 2 million subscribers are affected, though customers already on an annual plan won't see the new rate right away, since their existing terms carry over until renewal.",
    "Executives point to climbing server infrastructure and network costs as the primary driver behind the decision. Leadership has said it held off on the increase for over a year out of concern for small-business customers, but ultimately concluded further delay wasn't sustainable given the pace of rising expenses.",
  ],
  bullets_ru: [
    "Цена вырастет с $5 до $8 в месяц — рост почти на 60% для новых платежей.",
    "Годовые подписчики сохранят текущую цену до момента продления плана.",
    "Компания откладывала повышение полтора года, опасаясь навредить малому бизнесу.",
    "Рост издержек на серверы стал основной причиной, которую назвала компания.",
  ],
  bullets_en: [
    "Point 1 covers pricing: the new rate is nearly 60% higher than before.",
    "Point 2 covers rollout timing: annual subscribers get a grace period.",
    "Point 3 covers scope: the change applies to subscribers everywhere.",
    "Point 4 covers the stated reason: rising server and bandwidth costs.",
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

// A second, distinct compliant summary — used to prove a resummarize call
// actually produced NEW content, not just re-persisted the old one.
const RESUMMARIZED_SUMMARY = {
  title_ru: "Обновлённый заголовок",
  title_en: "Updated Title",
  tldr_ru:
    "Обновлённый пересказ. После повторного анализа компания уточнила детали повышения цены подписки и сроки перехода на новый тариф для всех категорий клиентов сервиса по всему миру, включая точную дату и условия перехода.",
  tldr_en:
    "Updated summary. After a fresh pass, the company clarified the pricing change details and the rollout timeline for the new tier across every customer segment it serves worldwide, including the exact effective date and terms.",
  body_ru: [
    "После повторного анализа компания опубликовала уточнённые детали изменения цены подписки, включая точную дату вступления в силу и переходные условия для уже действующих клиентов сервиса по всем регионам присутствия, где он предлагается пользователям на регулярной основе уже несколько лет подряд без существенных перерывов в обслуживании.",
    "Обновлённый список затронутых регионов и деталей переходного периода призван снять оставшиеся вопросы у подписчиков, которые ранее жаловались на нехватку конкретики в первом объявлении о повышении цены на сервис и его условиях, а также на отсутствие ясности по срокам вступления изменений в силу и по итоговой стоимости.",
  ],
  body_en: [
    "After a fresh pass over the announcement, the company published clarified details about the pricing change, including the exact effective date and transition terms for existing customers of the service across every region where it's regularly offered to users, some of whom have subscribed for several years already.",
    "The updated list of affected regions and transition-period details is meant to resolve the remaining questions subscribers had raised about the lack of specifics in the original price-increase announcement for the service and its terms, along with unclear timing on when changes would actually take effect.",
  ],
  bullets_ru: [
    "Уточнена дата вступления изменений в силу для всех регионов присутствия.",
    "Добавлены детали о переходном периоде для действующих клиентов сервиса.",
    "Обновлён список затронутых регионов с учётом обратной связи от подписчиков.",
    "Компания подтвердила, что тарифы для новых клиентов останутся без изменений.",
  ],
  bullets_en: [
    "The effective date was clarified across every region where the service operates.",
    "Added detail on the transition period for existing customers of the service.",
    "Updated the list of affected regions based on feedback from subscribers.",
    "The company confirmed pricing for brand-new customers remains unchanged.",
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
      delete(key: string): Promise<void> {
        kv.delete(key);
        return Promise.resolve();
      },
      list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
        return Promise.resolve({ keys: [], list_complete: true });
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
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
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

// --- Task 24 Part C: similar-title 409 for manual/extension adds (a
// DIFFERENT url whose normalized title exactly matches something added in
// the last 72h). JOBS is configured in every test below so the pipeline is
// only ENQUEUED, never run inline — running it inline would overwrite the
// first article's title with the real extracted page title (see
// pipeline.ts's markArticleReady call), which would make these title
// assertions meaningless. findRecentTitlesForDedup reads straight off the
// articles table regardless of pending/ready status, so a still-'pending'
// row with its originally-submitted title is exactly what's needed here. ---

Deno.test("POST /api/admin/articles: a different URL with a normalized-identical title is rejected with 409 reason 'similar_title'", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const { ctx } = makeExecutionContext();

  const first = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: "https://example.com/first-source",
        title: "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel",
      }),
    },
    env,
    ctx,
  );
  const { id } = await first.json();

  const second = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: "https://mirror.example.com/reposted-elsewhere",
        // Punctuation/case differ but normalize to the same exact form.
        title: "amd prepares zen 6 perf profiling in the linux kernel!",
      }),
    },
    env,
    ctx,
  );
  assertEquals(second.status, 409);
  const body = await second.json();
  assertEquals(body, { id, error: "duplicate", reason: "similar_title" });
});

Deno.test("POST /api/admin/articles: a merely-similar (Jaccard, not exact) title is NOT blocked — manual adds are exact-title-only", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const { ctx } = makeExecutionContext();

  await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: "https://example.com/kimi-source",
        title: "Moonshot AI releases Kimi K2 model with major reasoning gains",
      }),
    },
    env,
    ctx,
  );

  const paraphrased = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: "https://example.com/kimi-paraphrase",
        // Jaccard->=0.6 similar to the first title but not an exact
        // normalized match — owner intent overrides here, unlike the
        // scraper agent's pre-scrape pool dedup.
        title: "Kimi K2, the new Moonshot AI model, brings major reasoning gains",
      }),
    },
    env,
    ctx,
  );
  assertEquals(paraphrased.status, 202);
});

Deno.test("POST /api/admin/articles: the similar-title check is skipped entirely when no title is supplied", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const { ctx } = makeExecutionContext();

  await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        url: "https://example.com/titled-first",
        title: "A Distinct Headline About Something",
      }),
    },
    env,
    ctx,
  );

  const untitled = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ url: "https://example.com/untitled-second" }),
    },
    env,
    ctx,
  );
  assertEquals(untitled.status, 202);
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
  const items = body.items as { id: string; status: string; has_error: boolean }[];

  assertEquals(items.find((i) => i.id === "stale-1")?.status, "failed");
  // Public list — no raw `error` field (see the privacy-incident regression
  // test below); has_error is the public-safe signal instead.
  assertEquals(items.find((i) => i.id === "stale-1")?.has_error, true);
  assertEquals(items.find((i) => i.id === "fresh-1")?.status, "pending");
});

// Regression test for a live-confirmed privacy incident: the public list
// endpoint was including the raw `error` column verbatim — internal
// pipeline detail (upstream URLs, stack fragments) visible to any
// anonymous visitor on a failed card. GET /api/articles/:id (single item)
// was already correct; only the list endpoint leaked it. Fixed by mapping
// every row through toPublicListItem() before responding — see index.ts.
Deno.test("GET /api/articles: never includes the raw error field, even for a failed article (privacy incident regression)", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  try {
    const res = await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://leaky-error-test.example.com/article" }),
      },
      env,
      ctx,
    );
    const { id } = await res.json();
    await settle();

    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === id)!;
    row.status = "failed";
    row.error =
      "internal: fetch: upstream responded 500 at https://internal-upstream.example/secret-path";

    const listRes = await app.request("/api/articles", {}, env, ctx);
    const listBody = await listRes.json();
    const item = listBody.items.find((i: { id: string }) => i.id === id);

    assertEquals("error" in item, false);
    assertEquals(item.has_error, true);
    assertEquals(JSON.stringify(listBody).includes("internal-upstream.example"), false);

    const detailRes = await app.request(`/api/articles/${id}`, {}, env, ctx);
    const detailBody = await detailRes.json();
    assertEquals("error" in detailBody, false);
    assertEquals(detailBody.has_error, true);
  } finally {
    restoreFetch();
  }
});

// --- Task 32: multi-word keyword search (?q=) ---
// Live incident: GET /api/articles?q=<multi-word phrase> 500'd in
// production (D1_ERROR: LIKE or GLOB pattern too complex — see
// db_test.ts's buildListQuery regression test for the root cause). These
// exercise the fix at the route level, for both the public and the
// owner-only admin list endpoints (they share the same buildListQuery/
// listArticles code path — see index.ts).

function readyRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "row-1",
    url: `https://example.com/${overrides.id ?? "row-1"}`,
    canonical_url: null,
    title: "",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: new Date().toISOString(),
    added_via: "manual",
    lang_original: "en",
    full_text: null,
    summary_ru: "",
    summary_en: "",
    summary_json: null,
    tags: "[]",
    status: "ready",
    archived: 0,
    error: null,
    ...overrides,
  };
}

Deno.test("GET /api/articles: multi-word q is AND across terms — a row matching only one term is excluded", async () => {
  const { env, ctx } = { env: makeEnv(), ...makeExecutionContext() };
  const db = env.DB as unknown as FakeD1;
  db.rows.push(readyRow({ id: "both", title: "TypeScript on the Wikipedia page" }));
  db.rows.push(readyRow({ id: "one-only", title: "TypeScript news roundup" }));

  const res = await app.request("/api/articles?q=typescript%20wikipedia", {}, env, ctx);
  assertEquals(res.status, 200);
  const body = await res.json();
  const ids = body.items.map((i: { id: string }) => i.id);
  assertEquals(ids, ["both"]);
});

Deno.test("GET /api/admin/articles: same AND-across-terms semantics on the owner-only list endpoint", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();
  const db = env.DB as unknown as FakeD1;
  db.rows.push(readyRow({ id: "both", title: "TypeScript on the Wikipedia page" }));
  db.rows.push(readyRow({ id: "one-only", title: "TypeScript news roundup" }));

  const res = await app.request(
    "/api/admin/articles?q=typescript%20wikipedia",
    { headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  const ids = body.items.map((i: { id: string }) => i.id);
  assertEquals(ids, ["both"]);
});

Deno.test("GET /api/articles: a term can match in a different field than another term (AND is across title+summary_ru+summary_en combined)", async () => {
  const { env, ctx } = { env: makeEnv(), ...makeExecutionContext() };
  const db = env.DB as unknown as FakeD1;
  db.rows.push(
    readyRow({
      id: "split-match",
      title: "Deno release notes",
      summary_en: "Covers widget support",
    }),
  );

  const res = await app.request("/api/articles?q=deno%20widget", {}, env, ctx);
  const body = await res.json();
  assertEquals(body.items.map((i: { id: string }) => i.id), ["split-match"]);
});

Deno.test("GET /api/articles + GET /api/admin/articles: a long multi-word query (the exact live-incident phrase) no longer 500s", async () => {
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx } = makeExecutionContext();
  const failingQuery = "секьюрити проблемы у hugging face";

  const publicRes = await app.request(
    `/api/articles?q=${encodeURIComponent(failingQuery)}`,
    {},
    env,
    ctx,
  );
  assertEquals(publicRes.status, 200);
  await publicRes.json();

  const adminRes = await app.request(
    `/api/admin/articles?q=${encodeURIComponent(failingQuery)}`,
    { headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(adminRes.status, 200);
  await adminRes.json();
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

Deno.test("DELETE /api/admin/articles/:id: also removes the Vectorize embedding (no orphan vectors)", async () => {
  const restoreFetch = stubFetch();
  let deletedIds: string[] | undefined;
  const vectors: VectorizeIndex = {
    upsert: () => Promise.reject(new Error("not used")),
    query: () => Promise.reject(new Error("not used")),
    deleteByIds(ids) {
      deletedIds = ids;
      return Promise.resolve({ count: ids.length, ids });
    },
  };
  const { env, authHeaders } = await makeOwnerContext({ VECTORS: vectors });
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/deleteme-vector" }),
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
    assertEquals(deletedIds, [created.id]);
  } finally {
    restoreFetch();
  }
});

Deno.test("DELETE /api/admin/articles/:id: never crashes when VECTORS isn't configured (graceful degradation)", async () => {
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext({ VECTORS: undefined });
  const { ctx, settle } = makeExecutionContext();

  try {
    const created = await (
      await app.request(
        "/api/admin/articles",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ url: "https://example.com/deleteme-no-vectors" }),
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

// --- Queue producer: JOBS.send() called with the correct message when the
// binding is configured (see queue.ts's enqueueArticleJob; the JOBS-absent
// fallback path is exercised by every test above, since makeEnv() doesn't
// set JOBS by default). ---

Deno.test("POST /api/admin/articles: with JOBS configured, enqueues a 'process' message and does not run the pipeline inline", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const { ctx, settle } = makeExecutionContext();

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ url: "https://example.com/queued-create" }),
    },
    env,
    ctx,
  );
  assertEquals(res.status, 202);
  const created = await res.json();
  await settle();

  assertEquals(jobs.sent.length, 1);
  assertEquals(jobs.sent[0], { kind: "process", articleId: created.id });

  // Still 'pending' — a real consumer never ran; only the message was sent.
  const db = env.DB as unknown as FakeD1;
  assertEquals(db.rows.find((r) => r.id === created.id)!.status, "pending");
});

Deno.test("POST /api/admin/articles: with JOBS configured and html supplied, stashes it in CACHE for the consumer to pick up", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext({ JOBS: jobs });
  const { ctx } = makeExecutionContext();

  const res = await app.request(
    "/api/admin/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ url: "https://example.com/queued-with-html", html: ARTICLE_HTML }),
    },
    env,
    ctx,
  );
  const created = await res.json();

  const stashed = await env.CACHE.get(`pending-html:${created.id}`);
  assertEquals(stashed, ARTICLE_HTML);
});

Deno.test("POST /api/admin/articles/:id/retry: with JOBS configured, enqueues a 'process' message instead of running inline", async () => {
  const jobs = new FakeQueue();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  const restoreFetch = stubFetch({ anthropicStatus: 500 });
  const created = await (
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/retry-queued" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();
  restoreFetch();

  // JOBS only shows up now — the initial create above used the fallback
  // path so the article would actually reach 'failed' and be retryable.
  env.JOBS = jobs;
  const retryRes = await app.request(
    `/api/admin/articles/${created.id}/retry`,
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(retryRes.status, 202);
  await settle();

  assertEquals(jobs.sent, [{ kind: "process", articleId: created.id }]);
  const db = env.DB as unknown as FakeD1;
  assertEquals(db.rows.find((r) => r.id === created.id)!.status, "pending");
});

Deno.test("POST /api/admin/articles/:id/resummarize: with JOBS configured, enqueues a 'resummarize' message instead of running inline", async () => {
  const jobs = new FakeQueue();
  const restoreFetch = stubFetch();
  const { env, authHeaders } = await makeOwnerContext();
  const { ctx, settle } = makeExecutionContext();

  const created = await (
    await app.request(
      "/api/admin/articles",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ url: "https://example.com/resum-queued" }),
      },
      env,
      ctx,
    )
  ).json();
  await settle();

  env.JOBS = jobs;
  try {
    const res = await app.request(
      `/api/admin/articles/${created.id}/resummarize`,
      { method: "POST", headers: authHeaders },
      env,
      ctx,
    );
    assertEquals(res.status, 202);
    await settle();

    assertEquals(jobs.sent, [{ kind: "resummarize", articleId: created.id }]);
    const db = env.DB as unknown as FakeD1;
    assertEquals(db.rows.find((r) => r.id === created.id)!.status, "pending");
  } finally {
    restoreFetch();
  }
});
