import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { insertPendingArticle, markArticleReady } from "./db.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const JWKS_CACHE_KEY = `access:jwks:${TEAM_DOMAIN}`;

const MINIMAL_SUMMARY_JSON = {
  title_ru: "t",
  title_en: "t",
  tldr_ru: "t",
  tldr_en: "t",
  body_ru: [],
  body_en: [],
  bullets_ru: [],
  bullets_en: [],
  tags: [],
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
        throw new Error("AI.run should not be called for this branch");
      },
    },
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

async function seedReadyArticle(
  db: D1Database,
  overrides: { id: string; title: string; added_at: string },
): Promise<void> {
  await insertPendingArticle(db, {
    id: overrides.id,
    url: `https://example.com/${overrides.id}`,
    title: overrides.title,
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: overrides.added_at,
  });
  await markArticleReady(db, overrides.id, {
    full_text: "full text",
    title: overrides.title,
    author: null,
    lang_original: "en",
    summary_ru: overrides.title,
    summary_en: overrides.title,
    summary_json: { ...MINIMAL_SUMMARY_JSON, title_en: overrides.title },
    tags: [],
  });
}

function makeStubAi(vector: number[]): Ai {
  return { run: () => Promise.resolve({ shape: [1, vector.length], data: [vector] }) };
}

function makeStubVectors(matches: VectorizeMatch[]): VectorizeIndex {
  return {
    upsert: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
    query: () => Promise.resolve({ matches, count: matches.length }),
  };
}

// --- GET /api/search (public) ---

Deno.test("GET /api/search: empty/missing q returns {items: []} without touching the rate limiter", async () => {
  const env = makeEnv();
  const ctx = makeExecutionContext().ctx;
  const res = await app.request("/api/search", {}, env, ctx);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { items: [] });
});

Deno.test("GET /api/search: falls back to keyword search when VECTORS is absent, PublicArticle shape (no error field)", async () => {
  const env = makeEnv({ VECTORS: undefined });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "s1",
    title: "Widgets Are Great",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const res = await app.request("/api/search?q=Widgets", {}, env, ctx);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].article.id, "s1");
  assertEquals(body.items[0].score, 0);
  assertEquals("error" in body.items[0].article, false);
  assertEquals("full_text" in body.items[0].article, false);
});

Deno.test("GET /api/search: semantic path preserves Vectorize's score order", async () => {
  const env = makeEnv({
    AI: makeStubAi(new Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    VECTORS: makeStubVectors([
      { id: "s-b", score: 0.9 },
      { id: "s-a", score: 0.7 },
    ]),
  });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "s-a",
    title: "Article A",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await seedReadyArticle(env.DB, {
    id: "s-b",
    title: "Article B",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const res = await app.request("/api/search?q=something", {}, env, ctx);
  const body = await res.json();
  assertEquals(body.items.map((i: { article: { id: string } }) => i.article.id), ["s-b", "s-a"]);
  assertEquals(body.items.map((i: { score: number }) => i.score), [0.9, 0.7]);
});

Deno.test("GET /api/search: 429 rate_limited once SEARCH_RATE_PER_MIN is exceeded", async () => {
  const env = makeEnv({
    VECTORS: undefined, // keyword fallback still counts against the same limiter
    SEARCH_RATE_PER_MIN: "1",
  });
  const ctx = makeExecutionContext().ctx;

  const first = await app.request("/api/search?q=widget", {}, env, ctx);
  assertEquals(first.status, 200);

  const second = await app.request("/api/search?q=widget", {}, env, ctx);
  assertEquals(second.status, 429);
  assertEquals((await second.json()).error, "rate_limited");
});

// --- GET /api/admin/search (owner) ---

Deno.test("GET /api/admin/search: 200 for the owner, ArticleListItem shape (real error field present)", async () => {
  const { env, authHeaders } = await makeOwnerContext({ VECTORS: undefined });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "adm1",
    title: "Widgets Are Great",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const res = await app.request("/api/search?q=Widgets", {}, env, ctx); // sanity: public still works
  assertEquals(res.status, 200);

  const adminRes = await app.request(
    "/api/admin/search?q=Widgets",
    { headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(adminRes.status, 200);
  const body = await adminRes.json();
  assertEquals(body.items.length, 1);
  assertEquals("error" in body.items[0].article, true);
});

// --- POST /api/admin/embeddings/backfill ---

Deno.test("POST /api/admin/embeddings/backfill: embeds unembedded ready articles, upserts vectors, marks embedded_at", async () => {
  let upserted: VectorizeVector[] = [];
  const vectors: VectorizeIndex = {
    upsert(v) {
      upserted = v;
      return Promise.resolve({ count: v.length, ids: v.map((x) => x.id) });
    },
    query: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
  };
  const { env, authHeaders } = await makeOwnerContext({
    VECTORS: vectors,
    AI: {
      run: () =>
        Promise.resolve({
          shape: [1, EMBEDDING_DIMENSIONS],
          data: [new Array(EMBEDDING_DIMENSIONS).fill(0.2)],
        }),
    },
  });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "bf1",
    title: "Backfill Me",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const res = await app.request(
    "/api/admin/embeddings/backfill",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { processed: 1, remaining: 0 });
  assertEquals(upserted.length, 1);
  assertEquals(upserted[0].id, "bf1");

  const row = (env.DB as FakeD1).rows.find((r) => r.id === "bf1")!;
  assertEquals(typeof row.embedded_at, "string");
});

Deno.test("POST /api/admin/embeddings/backfill: reports processed=0 and the real remaining count when VECTORS isn't configured", async () => {
  const { env, authHeaders } = await makeOwnerContext({ VECTORS: undefined });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "bf2",
    title: "Backfill Me Too",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const res = await app.request(
    "/api/admin/embeddings/backfill",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { processed: 0, remaining: 1 });
});

Deno.test("POST /api/admin/embeddings/backfill: a per-row embed failure is logged and left unembedded, doesn't fail the batch", async () => {
  const { env, authHeaders } = await makeOwnerContext({
    VECTORS: {
      upsert: () => Promise.reject(new Error("not used")),
      query: () => Promise.reject(new Error("not used")),
      deleteByIds: () => Promise.reject(new Error("not used")),
    },
    AI: { run: () => Promise.reject(new Error("workers ai down")) },
  });
  const ctx = makeExecutionContext().ctx;
  await seedReadyArticle(env.DB, {
    id: "bf3",
    title: "Will Fail To Embed",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const res = await app.request(
    "/api/admin/embeddings/backfill",
    { method: "POST", headers: authHeaders },
    env,
    ctx,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { processed: 0, remaining: 1 });
});
