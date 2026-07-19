import "./env.d.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { accessAuth, type AppEnv } from "./access-middleware.ts";
import { readTurnstileConfig } from "./turnstile-middleware.ts";
import {
  deleteArticle,
  findArticleIdByUrl,
  getArticleById,
  insertPendingArticle,
  listArticles,
  markArticlePending,
  patchArticle,
  toPublicArticle,
} from "./db.ts";
import { runArticlePipeline } from "./pipeline.ts";
import {
  MAX_BODY_BYTES,
  sourceFromUrl,
  validateCreateArticleRequest,
  validateHtml,
  validatePatchArticleRequest,
} from "./validation.ts";
import { handleTelegramWebhook, sendMorningDigest } from "./telegram-webhook.ts";

const app = new Hono<AppEnv>();

// This instance is a public page: anyone may read the feed. Only mutations
// (below, under /api/admin/*) require a verified Cloudflare Access
// identity. Turnstile middleware exists (turnstile-middleware.ts) but is
// currently unmounted from every route — mutations are always
// Access-authenticated now, so there's no anonymous-mutation surface left
// for it to guard; the module, its tests, and /api/config stay in place
// dormant in case a public interaction (e.g. "suggest a link") shows up
// later.
app.get("/api/config", (c) => {
  const config = readTurnstileConfig(c.env);
  return c.json({ turnstile_site_key: config?.siteKey ?? null });
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

// Public by design, same as the routes above — Telegram delivers updates
// via webhook and can't present a Cloudflare Access identity, so this
// path authenticates itself via the X-Telegram-Bot-Api-Secret-Token
// header instead (see telegram-webhook.ts). 404s when the feature isn't
// configured, so its existence isn't even observable otherwise.
app.post("/api/telegram/webhook", handleTelegramWebhook);

// Reads the request body once, enforcing the overall size cap before
// attempting to parse it as JSON.
async function readJsonBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return { ok: false, response: c.json({ error: "request body too large" }, 413) };
  }
  if (raw.trim() === "") {
    return { ok: true, body: {} };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, 400) };
  }
}

app.get("/api/articles", async (c) => {
  const query = c.req.query();
  const limitRaw = query.limit ? Number(query.limit) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100
    ? Math.floor(limitRaw)
    : 20;

  let archived: boolean | undefined;
  if (query.archived === "1") archived = true;
  else if (query.archived === "0") archived = false;

  const result = await listArticles(c.env.DB, {
    cursor: query.cursor || undefined,
    limit,
    tag: query.tag || undefined,
    source: query.source || undefined,
    q: query.q || undefined,
    archived,
  });

  return c.json(result);
});

// Public — excludes full_text and the raw error string (see
// PublicArticle/toPublicArticle). The full row is only available to the
// owner, via GET /api/admin/articles/:id below.
app.get("/api/articles/:id", async (c) => {
  const article = await getArticleById(c.env.DB, c.req.param("id"));
  if (!article) return c.json({ error: "not found" }, 404);
  return c.json(toPublicArticle(article));
});

// Everything below requires a verified Cloudflare Access identity — see
// access-middleware.ts. Unlike the old whole-app mounting, this FAILS
// CLOSED (401 auth_not_configured) when Access isn't set up, rather than
// serving mutation routes openly.
app.use("/api/admin/*", accessAuth());

app.get("/api/admin/me", (c) => {
  return c.json({ sub: c.get("accessSub"), email: c.get("accessEmail") ?? null });
});

// Top-level navigation target for the SPA's "sign in" link. fetch() can't
// complete Cloudflare Access's own hosted-login redirect dance, but a real
// browser navigation can: Access intercepts this domain+path prefix at its
// edge, shows its login UI for an unauthenticated visitor, and only
// forwards the request to this Worker (with a valid session) once that's
// done — so by the time this handler runs, the visitor is already signed
// in and holds the Access cookie for this app.
app.get("/api/admin/login", (c) => {
  return c.html(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Signed in</title></head>
<body>
<p>Signed in — you can close this tab.</p>
<script>setTimeout(() => { location.href = "/"; }, 800);</script>
</body>
</html>
`,
  );
});

// Owner-only full row, including full_text and the raw error string.
app.get("/api/admin/articles/:id", async (c) => {
  const article = await getArticleById(c.env.DB, c.req.param("id"));
  if (!article) return c.json({ error: "not found" }, 404);
  return c.json(article);
});

app.post("/api/admin/articles", async (c) => {
  const bodyResult = await readJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;

  const validated = validateCreateArticleRequest(bodyResult.body);
  if (!validated.ok) {
    return c.json({ error: validated.error.error }, validated.error.status);
  }
  const { url, html, title, tags, added_via } = validated.value;

  const existingId = await findArticleIdByUrl(c.env.DB, url);
  if (existingId) {
    return c.json({ id: existingId, error: "duplicate" }, 409);
  }

  const id = crypto.randomUUID();

  await insertPendingArticle(c.env.DB, {
    id,
    url,
    title: title ?? url,
    source: sourceFromUrl(url),
    tags: tags ?? [],
    added_via: added_via ?? "manual",
    added_at: new Date().toISOString(),
  });

  c.executionCtx.waitUntil(
    runArticlePipeline(c.env, {
      id,
      url,
      html,
      requestTitle: title,
      requestTags: tags ?? [],
    }),
  );

  return c.json({ id, status: "pending" }, 202);
});

app.patch("/api/admin/articles/:id", async (c) => {
  const bodyResult = await readJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;

  const validated = validatePatchArticleRequest(bodyResult.body);
  if (!validated.ok) {
    return c.json({ error: validated.error.error }, validated.error.status);
  }

  const updated = await patchArticle(c.env.DB, c.req.param("id"), validated.value);
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated);
});

app.delete("/api/admin/articles/:id", async (c) => {
  const deleted = await deleteArticle(c.env.DB, c.req.param("id"));
  if (!deleted) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});

app.post("/api/admin/articles/:id/retry", async (c) => {
  const id = c.req.param("id");
  const article = await getArticleById(c.env.DB, id);
  if (!article) return c.json({ error: "not found" }, 404);
  if (article.status === "ready") {
    return c.json({ error: "article is already ready" }, 409);
  }

  const bodyResult = await readJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const rawHtml = typeof bodyResult.body === "object" && bodyResult.body !== null
    ? (bodyResult.body as Record<string, unknown>).html
    : undefined;
  const htmlResult = validateHtml(rawHtml);
  if (!htmlResult.ok) {
    return c.json({ error: htmlResult.error.error }, htmlResult.error.status);
  }

  await markArticlePending(c.env.DB, id);

  c.executionCtx.waitUntil(
    runArticlePipeline(c.env, {
      id,
      url: article.url,
      html: htmlResult.value,
      requestTitle: article.title,
      requestTags: article.tags,
    }),
  );

  return c.json({ id, status: "pending" }, 202);
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Named export for tests, which call `app.request(...)` directly — the
// default export below is the Workers-runtime handler shape
// ({fetch, scheduled}), which doesn't have that method.
export { app };

export default {
  fetch: app.fetch,
  // Morning digest (see wrangler.toml [triggers]); no-ops when the
  // Telegram feature isn't configured — see sendMorningDigest.
  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(sendMorningDigest(env));
  },
};
