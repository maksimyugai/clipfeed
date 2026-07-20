import "./env.d.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import type { QueueMessage } from "@clipfeed/shared/types";
import { accessAuth, type AppEnv } from "./access-middleware.ts";
import { readTurnstileConfig } from "./turnstile-middleware.ts";
import {
  deleteArticle,
  findArticleIdByUrl,
  getArticleById,
  getFailureStats,
  getLastAgentActivity,
  insertPendingArticle,
  listArticles,
  markArticlePending,
  patchArticle,
  sweepStalePending,
  toPublicArticle,
} from "./db.ts";
import {
  DEAD_LETTER_QUEUE_NAME,
  enqueueArticleJob,
  processDeadLetterMessage,
  processQueueMessage,
  stashPendingHtml,
} from "./queue.ts";
import {
  MAX_BODY_BYTES,
  sourceFromUrl,
  validateCreateArticleRequest,
  validateHtml,
  validatePatchArticleRequest,
} from "./validation.ts";
import { handleTelegramWebhook } from "./telegram-webhook.ts";
import { runAgentJob } from "./agent.ts";
import { handleScheduled } from "./scheduled.ts";
import { listLearnedThinHosts } from "./thin-host-learning.ts";

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
  // Lazy stale-pending sweeper — see sweepStalePending() in db.ts.
  await sweepStalePending(c.env.DB, c.env.PENDING_TIMEOUT_MIN);

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

  if (html !== undefined) {
    await stashPendingHtml(c.env.CACHE, id, html);
  }
  await enqueueArticleJob(c.env, c.executionCtx, { kind: "process", articleId: id });

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

// Manual trigger for the daily scraping agent — same job the hourly
// AGENT_HOUR_UTC dispatch runs, useful for testing without waiting for the
// clock. See agent.ts.
app.post("/api/admin/agent/run", (c) => {
  c.executionCtx.waitUntil(runAgentJob(c.env));
  return c.json({ ok: true }, 202);
});

// Owner-only visibility into the self-healing system (see healing.ts,
// classify-failure.ts, thin-host-learning.ts) — no SPA UI for this yet,
// intended for curl/owner tooling. Three cheap D1/KV reads, no article
// content.
app.get("/api/admin/health-report", async (c) => {
  const [{ failed_by_class, heal_attempts_totals }, learnedThinhosts, lastAgentActivity] =
    await Promise.all([
      getFailureStats(c.env.DB),
      listLearnedThinHosts(c.env.CACHE),
      getLastAgentActivity(c.env.DB),
    ]);

  return c.json({
    failed_by_class,
    heal_attempts_totals,
    learned_thinhosts: learnedThinhosts,
    last_agent_run: { last_added_at: lastAgentActivity },
  });
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
        attempt: message.attempts,
      }));
      try {
        await processQueueMessage(env, message.body);
        message.ack();
        console.log(JSON.stringify({
          event: "queue_done",
          articleId: message.body.articleId,
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
          outcome: "retry",
          duration_ms: Date.now() - startedAt,
        }));
      }
    }
  },
};
