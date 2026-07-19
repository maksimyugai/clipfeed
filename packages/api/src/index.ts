import "./env.d.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { accessAuth, type AppEnv } from "./access-middleware.ts";
import {
  deleteArticle,
  findArticleIdByUrl,
  getArticleById,
  insertPendingArticle,
  listArticles,
  markArticlePending,
  patchArticle,
} from "./db.ts";
import { runArticlePipeline } from "./pipeline.ts";
import {
  MAX_BODY_BYTES,
  sourceFromUrl,
  validateCreateArticleRequest,
  validateHtml,
  validatePatchArticleRequest,
} from "./validation.ts";

const app = new Hono<AppEnv>();

// Auth: Cloudflare Access JWT, verified on every route below except
// /api/health — see access-middleware.ts. No-ops (open) until
// ACCESS_TEAM_DOMAIN + ACCESS_AUD are both configured.
app.use("*", accessAuth());

app.get("/api/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

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

app.post("/api/articles", async (c) => {
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

app.get("/api/articles/:id", async (c) => {
  const article = await getArticleById(c.env.DB, c.req.param("id"));
  if (!article) return c.json({ error: "not found" }, 404);
  return c.json(article);
});

app.patch("/api/articles/:id", async (c) => {
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

app.delete("/api/articles/:id", async (c) => {
  const deleted = await deleteArticle(c.env.DB, c.req.param("id"));
  if (!deleted) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});

app.post("/api/articles/:id/retry", async (c) => {
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

export default app;
