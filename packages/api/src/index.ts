import "./env.d.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  DuplicateArticleResponse,
  EmbeddingsBackfillResponse,
  QueueMessage,
} from "@clipfeed/shared/types";
import { accessAuth, type AppEnv } from "./auth/access-middleware.ts";
import { readTurnstileConfig } from "./auth/turnstile-middleware.ts";
import type { ListArticlesParams } from "./articles/db.ts";
import {
  backfillNormalizedTags,
  countUnembeddedArticles,
  deleteArticle,
  findArticleIdByUrl,
  findRecentTitlesForDedup,
  getArticleById,
  getFailureStats,
  getFaithfulnessStats,
  getLastAgentActivity,
  getSourceStats,
  insertPendingArticle,
  listArticles,
  listSummaryValidationFailures,
  listUnembeddedArticles,
  markArticlePending,
  markEmbedded,
  patchArticle,
  RECENT_TITLES_DEDUP_WINDOW_MS,
  resetHealAttempts,
  sweepStalePending,
  toPublicArticle,
  toPublicListItem,
  updateFaithfulnessOnly,
} from "./articles/db.ts";
import { normalizeTitleExact } from "./lib/title-similarity.ts";
import {
  DEAD_LETTER_QUEUE_NAME,
  enqueueArticleJob,
  processDeadLetterMessage,
  processQueueMessage,
  stashPendingHtml,
} from "./pipeline/queue.ts";
import {
  MAX_BODY_BYTES,
  sourceFromUrl,
  validateCreateArticleRequest,
  validateHtml,
  validatePatchArticleRequest,
} from "./articles/validation.ts";
import { handleTelegramWebhook } from "./telegram/telegram-webhook.ts";
import { runAgentJob } from "./agent/agent.ts";
import { formatUtcHourMinute, readAgentRunHistory } from "./agent/agent-run-tracker.ts";
import { agentAlreadyRanWarning } from "./telegram/telegram-strings.ts";
import { handleScheduled, parseHour } from "./scheduled/scheduled.ts";
import { parseAgentDailyPicks } from "./agent/ranking.ts";
import { listLearnedThinHosts } from "./agent/thin-host-learning.ts";
import { readSummaryBudgetUsage } from "./pipeline/cost-guard.ts";
import {
  readFaithfulnessCallCount,
  resolveFaithfulnessJudgeModel,
  runFaithfulnessCheck,
} from "./pipeline/faithfulness.ts";
import {
  buildEmbeddingText,
  deleteArticleEmbedding,
  embedText,
  resolveEmbeddingModel,
  upsertArticleEmbedding,
} from "./search/embeddings.ts";
import {
  parseSearchRatePerMin,
  searchArticles,
  tryConsumeSearchRateLimit,
} from "./search/search.ts";
import { buildOgTags, injectOgTags } from "./articles/og.ts";
import { SOURCES } from "./agent/sources.ts";
import { loadBlocklistConfig, loadCurationConfig } from "./agent/curation.ts";
import { normalizeDomainInput, resolveDomainPrecedence } from "./agent/domain-block.ts";
import { hostname } from "./lib/url-host.ts";
import { clearAutoBlock, isAutoBlocked, listAutoBlocks } from "./agent/autoblock.ts";
import openApiSpec from "../openapi.json" with { type: "json" };

const app = new Hono<AppEnv>();

// This instance is a public page: anyone may read the feed. Only mutations
// (below, under /api/admin/*) require a verified Cloudflare Access
// identity. Turnstile middleware exists (turnstile-middleware.ts) but is
// currently unmounted from every route — mutations are always
// Access-authenticated now, so there's no anonymous-mutation surface left
// for it to guard; the module, its tests, and /api/config stay in place
// dormant in case a public interaction (e.g. "suggest a link") shows up
// later.
//
// agent_hour_utc/agent_daily_picks (Task 24 Part D): exposed so the SPA can
// render a live "new articles in Xh Ym" countdown when today's section is
// empty, computed client-side from the browser's own local timezone (see
// packages/web/src/lib/agentSchedule.ts) — same parseHour() the scheduled
// dispatcher itself uses, so "disabled" here means exactly the same thing
// it means for the cron (an empty/invalid AGENT_HOUR_UTC), never null vs.
// some other silently-different definition of "off".
app.get("/api/config", (c) => {
  const config = readTurnstileConfig(c.env);
  return c.json({
    turnstile_site_key: config?.siteKey ?? null,
    agent_hour_utc: parseHour(c.env.AGENT_HOUR_UTC),
    agent_daily_picks: parseAgentDailyPicks(c.env.AGENT_DAILY_PICKS),
    // Task 30 Part D: single source of truth for the header's GitHub icon
    // link and the footer's license link (see repoConfig.ts) — "" when
    // unset, never a hardcoded owner-specific fallback.
    repo_url: c.env.REPO_URL ?? "",
  });
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

// Task 39: the hand-maintained OpenAPI 3.1 spec (packages/api/openapi.json,
// source of truth — MUST be updated in the same PR as any route change, see
// CLAUDE.md). Imported at build time (same static JSON-import convention as
// curation.json/sources.json/blocklist.json elsewhere in this file) rather
// than read from disk at request time. Short cache since the spec only
// changes on deploy, not at runtime.
app.get("/openapi.json", (c) => {
  return c.json(openApiSpec, 200, { "Cache-Control": "public, max-age=300" });
});

// Self-hosted Swagger UI (never a CDN — see packages/web/vendor/swagger-ui/
// VERSION for provenance). The vendored swagger-ui-bundle.js/swagger-ui.css
// are served by the ASSETS catch-all below like any other static file (see
// scripts/build.ts, which copies them into dist/web/docs-assets/); this
// route only needs to return the tiny HTML shell that loads them and points
// SwaggerUIBundle at GET /openapi.json above — same origin, so "Try it out"
// needs no CORS configuration for the public routes. Admin routes will
// simply 401 without a Cloudflare Access session, same as calling them any
// other way.
app.get("/docs", (c) => {
  return c.html(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ClipFeed API</title>
<link rel="icon" href="/favicon-32.png">
<link rel="stylesheet" href="/docs-assets/swagger-ui.css">
<style>body { margin: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs-assets/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    presets: [SwaggerUIBundle.presets.apis],
  });
</script>
</body>
</html>
`,
  );
});

// Public by design, same as the routes above — Telegram delivers updates
// via webhook and can't present a Cloudflare Access identity, so this
// path authenticates itself via the X-Telegram-Bot-Api-Secret-Token
// header instead (see telegram-webhook.ts). 404s when the feature isn't
// configured, so its existence isn't even observable otherwise.
app.post("/api/telegram/webhook", handleTelegramWebhook);

// Task 33 §2: checks a manually-added URL's host against the curation
// blocklist (config + KV auto-learned) purely for the advisory
// {warning:'blocked_domain'} response field — never blocks the save
// itself. A single isAutoBlocked() KV get (not the full listAutoBlocks()
// enumeration the agent pool/health-report use) since this only needs one
// host's membership, not the whole list.
async function checkBlockedDomainWarning(
  env: Env,
  url: string,
): Promise<"blocked_domain" | undefined> {
  const host = hostname(url);
  if (!host) return undefined;
  const blocklist = loadBlocklistConfig();
  const autoBlocked = await isAutoBlocked(env.CACHE, host);
  const precedence = resolveDomainPrecedence(
    host,
    blocklist.blockedDomains,
    autoBlocked ? new Set([host]) : new Set<string>(),
    [],
  );
  return precedence.blocked ? "blocked_domain" : undefined;
}

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

// Task 41 Part D: status=ready|pending|failed|all — 'all' (or anything else,
// including absent) means no filter at all, matching the historical
// default. Only the admin list route honors whatever this parses to; the
// public route always overrides it to 'ready' itself (see below), so an
// invalid or missing value here is never a security question, just a no-op.
function parseStatusParam(raw: string | undefined): "ready" | "pending" | "failed" | undefined {
  return raw === "ready" || raw === "pending" || raw === "failed" ? raw : undefined;
}

// Shared by the public and owner-only list routes below — same filters,
// same cursor pagination; only the returned row shape differs (see each
// route's own comment).
function parseArticleListParams(c: Context<AppEnv>): ListArticlesParams {
  const query = c.req.query();
  const limitRaw = query.limit ? Number(query.limit) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100
    ? Math.floor(limitRaw)
    : 20;

  let archived: boolean | undefined;
  if (query.archived === "1") archived = true;
  else if (query.archived === "0") archived = false;

  return {
    cursor: query.cursor || undefined,
    limit,
    tag: query.tag || undefined,
    source: query.source || undefined,
    q: query.q || undefined,
    archived,
    status: parseStatusParam(query.status),
  };
}

// Public — excludes the raw `error` string per row (see toPublicListItem):
// an anonymous visitor must never see internal pipeline error detail
// (upstream URLs, stack fragments) on a failed card. Only `has_error` and
// `fail_class` are exposed, which is enough for the SPA's localized
// failed-card copy in visitor mode. The owner-only equivalent, with the
// real `error` field, is GET /api/admin/articles below.
//
// Task 41 Part D: a visitor must only ever see finished, real content — a
// pending or failed row is internal pipeline state, not something a public
// feed should expose (a failed card reading "Ошибка: timeout: processing
// did not complete" made a public feed look broken). status is forced to
// 'ready' here regardless of any status= query param a caller sends — that
// param is honored only by the admin route below.
app.get("/api/articles", async (c) => {
  // Lazy stale-pending sweeper — see sweepStalePending() in db.ts.
  await sweepStalePending(c.env.DB, c.env.PENDING_TIMEOUT_MIN, c.env.QUEUE_WAIT_TIMEOUT_MIN);
  const result = await listArticles(c.env.DB, { ...parseArticleListParams(c), status: "ready" });
  return c.json({ items: result.items.map(toPublicListItem), next_cursor: result.next_cursor });
});

// Public — excludes full_text and the raw error string (see
// PublicArticle/toPublicArticle). The full row is only available to the
// owner, via GET /api/admin/articles/:id below. Task 41 Part D: a
// pending/failed row 404s here too, same reasoning as the list route above
// — a visitor fetching a specific id (e.g. a stale bookmark) must not learn
// that an article exists but hasn't finished (or failed) processing.
app.get("/api/articles/:id", async (c) => {
  const article = await getArticleById(c.env.DB, c.req.param("id"));
  if (!article || article.status !== "ready") return c.json({ error: "not found" }, 404);
  return c.json(toPublicArticle(article));
});

// Task 32 Part B: real-path per-article route, required for link
// previews — a crawler (Telegram, etc.) only ever fetches a URL's raw
// HTML, and a hash fragment ("#article-<id>", the SPA's existing deep-link
// shape — see lib/deepLink.ts) is never sent to the server at all, so
// there's no way to inject per-article Open Graph tags without a real
// path. Serves the identical SPA shell either way — the SPA's own
// client-side routing handles both this path and the legacy hash — only
// the injected <head> meta differs. Public: same publicly-readable
// summary-level data GET /api/articles already exposes, nothing new.
app.get("/a/:id", async (c) => {
  const id = c.req.param("id");
  const shellResponse = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
  const shell = await shellResponse.text();
  const plainShell = () =>
    new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });

  const article = await getArticleById(c.env.DB, id);
  const publicBaseUrl = (c.env.PUBLIC_BASE_URL ?? "").trim();
  // Unknown id, not yet summarized, or PUBLIC_BASE_URL unset (og:url has
  // nowhere valid to point) — the plain shell is never wrong, just less
  // informative; the SPA itself still handles the id once it boots.
  if (!article || article.status !== "ready" || !article.summary_json || !publicBaseUrl) {
    return plainShell();
  }

  const cardUrl = `${publicBaseUrl}/a/${id}`;
  // Task 35 Part C: absolute /img/:id URL (never the original source-page
  // image URL) — see og.ts's doc comment on OgArticle.imageUrl for why this
  // alone is enough for Telegram to render the image, no sendPhoto needed.
  const imageUrl = article.image_key ? `${publicBaseUrl}/img/${id}` : undefined;
  const tags = buildOgTags(
    {
      title: article.summary_json.title_ru || article.title,
      tldr: article.summary_json.tldr_ru,
      imageUrl,
    },
    cardUrl,
  );
  return new Response(injectOgTags(shell, tags), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
});

// Task 35 Part C: public image serving — the feed itself is public, so an
// article's preview image is too, same posture as GET /api/articles. R2
// key format is `articles/<id>.<ext>` (see images.ts's r2ImageKey) but this
// route is keyed by ARTICLE id, not the raw R2 key, so callers (the SPA,
// Telegram's link-preview crawler) never need to know the stored
// extension. 404 when the article has no image (never found, download/
// validation failed, or the feature was disabled at pipeline time) or when
// the IMAGES binding itself isn't configured (a fork that hasn't run
// `deno task setup` yet) — immutable, 1-year cache: the object at a given
// key never changes once stored (a resummarize doesn't re-fetch the image,
// and there's no image-replace endpoint).
app.get("/img/:id", async (c) => {
  if (!c.env.IMAGES) return c.notFound();
  const article = await getArticleById(c.env.DB, c.req.param("id"));
  if (!article?.image_key) return c.notFound();

  const object = await c.env.IMAGES.get(article.image_key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

// Clamp shared by both search routes below — same bounds as
// parseArticleListParams's limit, just a smaller default (semantic search
// results are meant to be a short, high-confidence list, not a page).
function parseSearchLimit(c: Context<AppEnv>): number {
  const raw = Number(c.req.query("limit") ?? "20");
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? Math.floor(raw) : 20;
}

// "Ask your feed" — semantic search over stored articles (Task 27), public
// same as the rest of the feed. Falls back to the pre-existing title/summary
// LIKE search when Vectorize isn't configured or the embed call fails (see
// search.ts's searchArticles) — never a dead end, just less precise.
// Rate-limited (not the LIKE-only GET /api/articles?q= above) because a hit
// here costs a Workers AI call once Vectorize IS configured; an empty/missing
// `q` short-circuits before that check even runs. Task 41 Part D: 'ready'
// forced same as the list/detail routes — a pending/failed article (or one
// mid-resummarize, still matching its OLD embedding) must never surface in
// a visitor's results.
app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ items: [] });

  const limitPerMin = parseSearchRatePerMin(c.env.SEARCH_RATE_PER_MIN);
  const allowed = await tryConsumeSearchRateLimit(c.env.CACHE, limitPerMin);
  if (!allowed) return c.json({ error: "rate_limited" }, 429);

  const hits = await searchArticles(c.env, q, parseSearchLimit(c), "ready");
  return c.json({
    items: hits.map((hit) => ({ article: toPublicListItem(hit.article), score: hit.score })),
  });
});

// Everything below requires a verified Cloudflare Access identity — see
// access-middleware.ts. Unlike the old whole-app mounting, this FAILS
// CLOSED (401 auth_not_configured) when Access isn't set up, rather than
// serving mutation routes openly.
app.use("/api/admin/*", accessAuth());

app.get("/api/admin/me", (c) => {
  return c.json({ sub: c.get("accessSub"), email: c.get("accessEmail") ?? null });
});

// Owner-mode equivalent of GET /api/search — same underlying search (see
// search.ts), but rows keep the real `error` field (ArticleListItem, not
// PublicArticle) same as GET /api/admin/articles vs. GET /api/articles.
// Already behind accessAuth() above, so no separate rate limit here — the
// public route is the one an anonymous caller could hammer.
app.get("/api/admin/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ items: [] });
  const hits = await searchArticles(c.env, q, parseSearchLimit(c));
  return c.json({ items: hits.map((hit) => ({ article: hit.article, score: hit.score })) });
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

// Owner-only equivalent of GET /api/articles — same filters/pagination,
// but full rows (error included, full_text still excluded — same shape as
// GET /api/admin/articles/:id minus full_text) since the owner needs the
// real error text to decide whether a failure is worth investigating. Task
// 41 Part D: honors status=ready|pending|failed|all (default all — every
// status, the historical behavior) since the owner legitimately needs to
// see pending/failed rows; the public route above always forces 'ready'
// regardless of this param.
app.get("/api/admin/articles", async (c) => {
  await sweepStalePending(c.env.DB, c.env.PENDING_TIMEOUT_MIN, c.env.QUEUE_WAIT_TIMEOUT_MIN);
  const result = await listArticles(c.env.DB, parseArticleListParams(c));
  return c.json(result);
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
    return c.json(
      { id: existingId, error: "duplicate" } satisfies DuplicateArticleResponse,
      409,
    );
  }

  // Task 24 Part C: a different URL whose normalized title exactly matches
  // something added in the last 72h — likely the same story re-submitted
  // under a mirror/syndicated link. Only exact normalized-title, no Jaccard
  // fuzziness here (unlike agent-pool.ts's pre-scrape pool dedup) — owner
  // intent overrides for a deliberate manual/extension re-add, so this only
  // blocks a near-certain duplicate, never a merely-similar one. Skipped
  // entirely when no title was supplied (nothing to compare).
  if (title) {
    const sinceIso = new Date(Date.now() - RECENT_TITLES_DEDUP_WINDOW_MS).toISOString();
    const recentRows = await findRecentTitlesForDedup(c.env.DB, sinceIso);
    const normalizedTitle = normalizeTitleExact(title);
    const similar = recentRows.find((row) => normalizeTitleExact(row.title) === normalizedTitle);
    if (similar) {
      return c.json(
        {
          id: similar.id,
          error: "duplicate",
          reason: "similar_title",
        } satisfies DuplicateArticleResponse,
        409,
      );
    }
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

  if (html !== undefined) {
    await stashPendingHtml(c.env.CACHE, id, html);
  }
  await enqueueArticleJob(c.env, c.executionCtx, { kind: "process", articleId: id });

  // Task 33 §2: manual/extension/telegram adds are NEVER blocked (owner
  // intent overrides the curation blocklist) — but a warning surfaces the
  // fact so the owner knows this save is likely to fail extraction anyway.
  const blockedWarning = await checkBlockedDomainWarning(c.env, url);
  if (blockedWarning) {
    return c.json({ id, status: "pending", warning: blockedWarning }, 202);
  }
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
  const id = c.req.param("id");
  const deleted = await deleteArticle(c.env.DB, id);
  if (!deleted) return c.json({ error: "not found" }, 404);
  // No orphan vectors — a no-op when VECTORS isn't configured (see
  // embeddings.ts's deleteArticleEmbedding), so this is safe to call
  // unconditionally regardless of whether the row ever actually got embedded.
  await deleteArticleEmbedding(c.env.VECTORS, id);
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

  if (htmlResult.value !== undefined) {
    await stashPendingHtml(c.env.CACHE, id, htmlResult.value);
  }
  await enqueueArticleJob(c.env, c.executionCtx, { kind: "process", articleId: id });

  return c.json({ id, status: "pending" }, 202);
});

// Re-runs only the summary — distinct from retry above, which is for a
// stuck/failed pipeline run and re-fetches from scratch. Allowed for
// 'ready' (the normal case) and 'failed' (a superset of what retry can do,
// when there's already stored text to work from). Skips fetch/extract
// entirely when full_text is already stored — cheaper and deterministic —
// and only falls back to the full pipeline when there's nothing to
// summarize yet.
app.post("/api/admin/articles/:id/resummarize", async (c) => {
  const id = c.req.param("id");
  const article = await getArticleById(c.env.DB, id);
  if (!article) return c.json({ error: "not found" }, 404);
  if (article.status !== "ready" && article.status !== "failed") {
    return c.json({ error: "article must be ready or failed to resummarize" }, 409);
  }

  await markArticlePending(c.env.DB, id);
  await enqueueArticleJob(c.env, c.executionCtx, { kind: "resummarize", articleId: id });

  return c.json({ id, status: "pending" }, 202);
});

// Task 35 Part A §3: lazy, owner-triggered EN generation — the default
// summary is RU-only (see summarize.ts), so this is how an EN edition gets
// created at all. Generates ONLY the EN fields from the article's stored
// full_text (never a translation of the RU summary — see
// generateEnglishFields) and merges them into summary_json, setting
// en_generated_at. Idempotent: already-translated is a 200 no-op, never a
// second queue job — a caller (the SPA's lazy-translate trigger) can safely
// call this again without checking en_generated_at itself first. Does NOT
// flip status to 'pending' — the article's own RU content/status is
// entirely untouched by this operation, only summary_json gains the EN
// fields once the job completes.
app.post("/api/admin/articles/:id/translate", async (c) => {
  const id = c.req.param("id");
  const article = await getArticleById(c.env.DB, id);
  if (!article) return c.json({ error: "not found" }, 404);
  if (article.status !== "ready" || !article.full_text) {
    return c.json({ error: "article must be ready with stored text to translate" }, 409);
  }
  if (article.en_generated_at) {
    return c.json({ id, status: "already-translated" }, 200);
  }

  await enqueueArticleJob(c.env, c.executionCtx, { kind: "translate", articleId: id });
  return c.json({ id, status: "pending" }, 202);
});

// Re-runs ONLY the faithfulness stage (see faithfulness.ts) against an
// already-summarized article's stored full_text/summary_json — no
// fetch/extract/summarize at all, so this is a cheap way to spot-check the
// judge on a specific article without touching its status or content.
// Deliberately ignores FAITHFULNESS_ENFORCE entirely: this is a read-mostly
// diagnostic action, not a pipeline re-run, so it never discards the
// article regardless of the verdict it gets back.
app.post("/api/admin/articles/:id/reverify", async (c) => {
  const id = c.req.param("id");
  const article = await getArticleById(c.env.DB, id);
  if (!article) return c.json({ error: "not found" }, 404);
  if (!article.full_text || !article.summary_json) {
    return c.json({ error: "article has no stored summary to verify" }, 409);
  }

  const judgeModel = resolveFaithfulnessJudgeModel(c.env.FAITHFULNESS_JUDGE_MODEL);
  const fullText = article.full_text;
  const summaryJson = article.summary_json;
  c.executionCtx.waitUntil((async () => {
    const result = await runFaithfulnessCheck(c.env.AI, judgeModel, fullText, summaryJson);
    await updateFaithfulnessOnly(c.env.DB, id, {
      verdict: result.verdict,
      json: result.json,
      checkedAt: result.checkedAt,
    });
  })());

  return c.json({ id, status: "reverify-queued" }, 202);
});

// Manual trigger for the daily scraping agent — same job the hourly
// AGENT_HOUR_UTC dispatch runs, useful for testing without waiting for the
// clock. See agent.ts. Task 36 Part B §3: owner intent always wins here —
// this runs regardless of whether the agent already ran today — but if it
// did, the response carries a `warning` naming the most recent prior run so
// the owner isn't surprised by a doubled batch. `?force=1` skips the
// history check (and thus the warning) entirely, matching the bot's
// "/scrape force" bypass.
app.post("/api/admin/agent/run", async (c) => {
  const forced = c.req.query("force") === "1";
  const previousRuns = forced ? [] : await readAgentRunHistory(c.env.CACHE);
  c.executionCtx.waitUntil(runAgentJob(c.env, undefined, "manual"));

  if (previousRuns.length > 0) {
    const last = previousRuns[previousRuns.length - 1];
    const warning = agentAlreadyRanWarning(last.picks, formatUtcHourMinute(last.startedAt));
    return c.json({ ok: true, warning }, 202);
  }
  return c.json({ ok: true }, 202);
});

// Owner-only visibility into the self-healing system (see healing.ts,
// classify-failure.ts, thin-host-learning.ts) — no SPA UI for this yet,
// intended for curl/owner tooling. Three cheap D1/KV reads, no article
// content.
app.get("/api/admin/health-report", async (c) => {
  const [
    { failed_by_class, heal_attempts_totals },
    learnedThinhosts,
    lastAgentActivity,
    llmCalls,
    faithfulnessStats,
    faithfulnessCallsToday,
    curationBlocked,
    sourceStats,
    agentRunsToday,
  ] = await Promise.all([
    getFailureStats(c.env.DB),
    listLearnedThinHosts(c.env.CACHE),
    getLastAgentActivity(c.env.DB),
    readSummaryBudgetUsage(c.env.CACHE, c.env.DAILY_SUMMARY_LIMIT),
    getFaithfulnessStats(c.env.DB),
    readFaithfulnessCallCount(c.env.CACHE),
    buildCurationBlockedReport(c.env),
    getSourceStats(c.env.DB),
    readAgentRunHistory(c.env.CACHE),
  ]);

  // Task 33 §8: joins each source's picks/successes/failures with its
  // domain's current autoblock score (0 when the domain isn't
  // autoblocked at all) — best-effort domain resolution from sources.json
  // (RSS sources carry a url; "hn" is the one hackernews-type source,
  // hardcoded to its own well-known domain since it has no url field).
  const autoScoreByDomain = new Map(
    curationBlocked.auto.map((entry) => [entry.domain, entry.score]),
  );
  const sourcesWithAutoblock = sourceStats.map((stat) => {
    const source = SOURCES.find((s) => s.id === stat.sourceId);
    const domain = source?.url
      ? hostname(source.url)
      : (source?.type === "hackernews" ? "news.ycombinator.com" : null);
    return { ...stat, autoblockScore: domain ? (autoScoreByDomain.get(domain) ?? 0) : 0 };
  });

  return c.json({
    failed_by_class,
    heal_attempts_totals,
    learned_thinhosts: learnedThinhosts,
    last_agent_run: { last_added_at: lastAgentActivity },
    // Task 36 Part B §4: every completed agent run for the current UTC day
    // (scheduled and/or manual, see agent-run-tracker.ts) — makes a doubled
    // batch (two runs same day) visible without log spelunking. Empty when
    // the agent hasn't run yet today.
    agent_runs_today: agentRunsToday,
    // Today's daily-limit budget usage — a run that silently fails with
    // 'daily-limit' (fetch->extract->done, no summarize stage — see
    // pipeline.ts's budget stage log) previously cost the owner a
    // debugging session with no way to check this short of reading KV
    // directly.
    llm_calls: llmCalls,
    // Faithfulness check breakdown (see faithfulness.ts) — pass/weak/fail
    // counts across every article, plus today's judge-call volume from its
    // own (uncapped, observability-only) KV counter, distinct from
    // llm_calls above which only tracks the paid summarization budget.
    faithfulness: { ...faithfulnessStats, judge_calls_today: faithfulnessCallsToday },
    // Task 33 §8: curation — the blocklist snapshot (same shape as GET
    // /api/admin/curation/blocked) plus per-source stats, so the owner
    // doesn't need a second call to see the whole curation picture.
    curation: {
      blocked: curationBlocked,
      sources: sourcesWithAutoblock,
    },
  });
});

// Task 33 §8: shared by GET /api/admin/curation/blocked and the
// health-report's curation section below — one blocklist/autoblock/conflict
// snapshot, computed once per call.
interface CurationBlockedReport {
  config: string[];
  auto: Awaited<ReturnType<typeof listAutoBlocks>>;
  conflicts: { domain: string; layer: "config" | "auto" }[];
}

async function buildCurationBlockedReport(env: Env): Promise<CurationBlockedReport> {
  const blocklist = loadBlocklistConfig();
  const pickCount = parseAgentDailyPicks(env.AGENT_DAILY_PICKS);
  const curationConfig = loadCurationConfig(SOURCES, pickCount);
  const auto = await listAutoBlocks(env.CACHE);
  const autoSet = new Set(auto.map((entry) => entry.domain));

  // Preferred-but-blocked conflicts (Task 33 §5): the whitelist never
  // unblocks anything, so a preferred domain that's ALSO blocked is
  // reported here rather than silently overridden — surfaced prominently
  // so the owner decides deliberately.
  const conflicts: { domain: string; layer: "config" | "auto" }[] = [];
  for (const domain of curationConfig.preferredDomains) {
    const result = resolveDomainPrecedence(
      domain,
      blocklist.blockedDomains,
      autoSet,
      curationConfig.preferredDomains,
    );
    if (result.conflict && result.layer) {
      conflicts.push({ domain, layer: result.layer });
    }
  }

  return { config: blocklist.blockedDomains, auto, conflicts };
}

// Owner-only visibility into the curation blocklist (Task 33 §7.3) — the
// manual/config layer is read straight from blocklist.json (edit the file
// in your fork, no endpoint needed); this exists for the KV-learned side,
// which changes at runtime with no deploy.
app.get("/api/admin/curation/blocked", async (c) => {
  const report = await buildCurationBlockedReport(c.env);
  return c.json(report);
});

// False-positive relief without a deploy: clears one auto-learned block
// immediately. Normalizes free-form input (lowercase, strip scheme/path/
// www) and rejects anything that doesn't look like a real hostname.
app.delete("/api/admin/curation/autoblock", async (c) => {
  const bodyResult = await readJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const rawDomain = typeof bodyResult.body === "object" && bodyResult.body !== null
    ? (bodyResult.body as Record<string, unknown>).domain
    : undefined;
  const domain = normalizeDomainInput(rawDomain);
  if (!domain) {
    return c.json({ error: "domain is required and must be a valid hostname" }, 400);
  }
  await clearAutoBlock(c.env.CACHE, domain);
  return c.json({
    domain,
    cleared: true,
    note: "config-file blocklist entries require editing blocklist.json in your fork",
  });
});

// One-time rescue for the summary-validation backlog left behind by the
// prompt/spec recalibration in this same task (see summarize.ts's
// deriveSummarySpec) — those rows failed against the OLD, now-corrected
// bounds and would otherwise sit capped at heal_attempts=1 (class
// 'unknown') until the owner manually retried each one. Ignores the normal
// healing cap entirely: resets heal_attempts to 0 first, then re-enqueues
// through the regular queue path (same budget/pipeline as any other run).
// Meant to be run once, by the owner, right after this PR merges.
app.post("/api/admin/heal/revalidate-failed", async (c) => {
  const rows = await listSummaryValidationFailures(c.env.DB);
  for (const row of rows) {
    await resetHealAttempts(c.env.DB, row.id);
    await markArticlePending(c.env.DB, row.id);
    await enqueueArticleJob(c.env, c.executionCtx, { kind: "process", articleId: row.id });
  }
  return c.json({ count: rows.length }, 202);
});

// One-time backfill for the tag-normalization fix (see tags.ts) — every
// NEW write already normalizes automatically (insertPendingArticle,
// markArticleReady), so this only needs running once, by the owner, to
// clean up tags on rows written before this fix shipped. Idempotent: a
// second run always returns {updated: 0}.
app.post("/api/admin/tags/normalize", async (c) => {
  const updated = await backfillNormalizedTags(c.env.DB);
  return c.json({ updated });
});

// Same batch size the task's own paginated-backfill convention uses
// elsewhere in this repo (see /api/admin/tags/normalize's sibling
// endpoints) — small enough to comfortably finish one Workers CPU-time
// budget even with a Workers AI call per row.
const EMBEDDINGS_BACKFILL_BATCH_SIZE = 20;

// Idempotent, synchronous-paginated backfill (Task 27, README "Semantic
// dedup & search") — embeds every 'ready' article with no embedding yet,
// one batch of EMBEDDINGS_BACKFILL_BATCH_SIZE per call. The caller (owner
// tooling, or a future SPA button) repeats this call until `remaining` is
// 0; same pattern as the other one-shot admin backfills in this file, no
// queue needed. A per-row embed failure is logged and left `embedded_at`
// null (never fails the whole batch) — the next call picks it up again,
// same "auxiliary, never blocks" contract as the pipeline's own embed
// stage (see pipeline.ts's runEmbedStage).
app.post("/api/admin/embeddings/backfill", async (c) => {
  if (!c.env.VECTORS) {
    const remaining = await countUnembeddedArticles(c.env.DB);
    return c.json({ processed: 0, remaining } satisfies EmbeddingsBackfillResponse);
  }

  const model = resolveEmbeddingModel(c.env.EMBEDDING_MODEL);
  const batch = await listUnembeddedArticles(c.env.DB, EMBEDDINGS_BACKFILL_BATCH_SIZE);

  let processed = 0;
  for (const article of batch) {
    const text = buildEmbeddingText({
      title_ru: article.title_ru,
      tldr_ru: article.tldr_ru,
      bullets_ru: article.bullets_ru,
    });
    if (!text) {
      // Nothing embeddable on this row (e.g. a 'ready' row with no
      // parseable summary_json) — mark it embedded anyway so it doesn't
      // wedge every future backfill call on a row that will never have
      // anything to embed.
      await markEmbedded(c.env.DB, article.id, new Date().toISOString());
      processed += 1;
      continue;
    }
    try {
      const vector = await embedText(c.env.AI, model, text);
      await upsertArticleEmbedding(c.env.VECTORS, article.id, vector, {
        added_at: article.added_at,
        source: article.source,
        added_via: article.added_via,
        lang_original: article.lang_original,
      });
      await markEmbedded(c.env.DB, article.id, new Date().toISOString());
      processed += 1;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "embeddings_backfill_failed",
        id: article.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const remaining = await countUnembeddedArticles(c.env.DB);
  return c.json({ processed, remaining } satisfies EmbeddingsBackfillResponse);
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Named export for tests, which call `app.request(...)` directly — the
// default export below is the Workers-runtime handler shape
// ({fetch, scheduled}), which doesn't have that method.
export { app };

export default {
  fetch: app.fetch,
  // Single hourly cron (see wrangler.toml [triggers]) dispatched by UTC
  // hour to the agent/digest jobs — see scheduled.ts.
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(handleScheduled(env, controller.scheduledTime, ctx));
  },
  // Consumer for BOTH the "clipfeed-jobs" queue and its
  // "clipfeed-dlq" dead-letter queue (see wrangler.toml [[queues.consumers]],
  // queue.ts) — Cloudflare invokes this same export for either, batch.queue
  // tells them apart. A consumer invocation gets minutes of wall time,
  // unlike the 30s hard cap on ctx.waitUntil(), which is what this task
  // exists to route around for large-article summarization.
  //
  // queue_received/queue_done bracket every message on the main queue —
  // deliberately the very first and very last thing this loop does per
  // message, so a production `wrangler tail` window always shows a life
  // sign for an invocation even if processQueueMessage itself throws
  // early, rather than a silent gap.
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (batch.queue === DEAD_LETTER_QUEUE_NAME) {
      for (const message of batch.messages) {
        try {
          await processDeadLetterMessage(env, message.body);
        } catch (err) {
          console.warn(JSON.stringify({
            event: "queue_dead_letter_unexpected_throw",
            id: message.body.articleId,
            error: err instanceof Error ? err.message : String(err),
          }));
        } finally {
          // Nothing further to retry into — either it succeeded, was
          // skipped as a no-op/already-terminal, or D1 itself is down (in
          // which case retrying here can't help either). Acking always
          // avoids a dead-letter-of-a-dead-letter loop.
          message.ack();
        }
      }
      return;
    }

    // processQueueMessage() owns the terminal-state guarantee (it
    // delegates to runArticlePipeline/runResummarization, whose own
    // top-level try/catch already turns any failure into a 'failed' row)
    // — so a throw reaching this loop means something unexpected (e.g. D1
    // itself erroring), not a normal pipeline failure; only that case is
    // retried, and after max_retries Cloudflare routes it to the DLQ
    // consumer above.
    for (const message of batch.messages) {
      const startedAt = Date.now();
      console.log(JSON.stringify({
        event: "queue_received",
        articleId: message.body.articleId,
        kind: message.body.kind,
        queueMessageId: message.body.queueMessageId,
        attempt: message.attempts,
      }));
      try {
        await processQueueMessage(env, message.body);
        message.ack();
        console.log(JSON.stringify({
          event: "queue_done",
          articleId: message.body.articleId,
          queueMessageId: message.body.queueMessageId,
          outcome: "ok",
          duration_ms: Date.now() - startedAt,
        }));
      } catch (err) {
        console.warn(JSON.stringify({
          event: "queue_message_unexpected_throw",
          id: message.body.articleId,
          error: err instanceof Error ? err.message : String(err),
        }));
        message.retry();
        console.log(JSON.stringify({
          event: "queue_done",
          articleId: message.body.articleId,
          queueMessageId: message.body.queueMessageId,
          outcome: "retry",
          duration_ms: Date.now() - startedAt,
        }));
      }
    }
  },
};
