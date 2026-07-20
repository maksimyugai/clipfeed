# ClipFeed

A personal article-digest web app. Save articles (via a Chrome extension, Telegram, or an automated
agent); the backend extracts text and generates Russian + English AI summaries (Cloudflare Workers
AI by default, or Claude via direct API or AI Gateway — see "LLM modes" below); a minimalist SPA
shows them as a Medium-like single-column feed.

Runs as a single Cloudflare Worker (Workers Static Assets) serving both the JSON API (Hono) and the
SPA. Storage is Cloudflare D1 + KV. Deno is the task runner, formatter, linter, and test runner;
bundling is done with esbuild invoked from Deno.

## Prerequisites

- [Deno](https://deno.com/) 2.x
- A Cloudflare account and `wrangler` auth (`deno run -A npm:wrangler login`) for `deploy` and any
  `--remote` commands

## Tasks

```
deno task dev     # build, then run wrangler dev with local D1/KV
deno task build   # esbuild-bundle the API and the Preact SPA into dist/
deno task setup   # one-time: create/reuse your D1 + KV resources, apply migrations
deno task deploy  # build, then wrangler deploy
deno task test    # run the test suite
deno task fmt     # format
deno task lint    # lint
```

## Project layout

```
packages/api/src/index.ts       Hono app (JSON API + static asset fallback)
packages/web/src/main.tsx       Preact SPA entry (-> dist/web/{app.js,app.css})
packages/web/index.html         SPA HTML template (copied to dist/web/index.html)
packages/extension/             Chrome extension (Manifest V3, see "Chrome extension" below)
packages/shared/src/types.ts    Types shared between API, SPA, and extension
migrations/                     D1 schema migrations
```

## LLM modes

ClipFeed picks a summarization backend at request time, in this priority order:

1. **Workers AI (default)** — zero config, free tier (10k neurons/day), works immediately after
   `deno task deploy` with no secrets set. Uses Cloudflare's
   `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via the native `AI` binding declared in
   `wrangler.toml`. Quality is noticeably below Claude for nuanced summarization — good enough to
   try the app out, not the last word.
2. **AI Gateway (recommended upgrade)** — routes calls through Cloudflare AI Gateway to a real
   Claude model, with usage/cost visibility and key rotation without a redeploy. Set secrets
   `AI_GATEWAY_URL` (+ `CF_AIG_TOKEN` for an authenticated gateway).
3. **Direct Anthropic** — calls `api.anthropic.com` straight. Set secret `ANTHROPIC_API_KEY`.

A mode is only used when its configuration is **complete** — AI Gateway needs `AI_GATEWAY_URL` _and_
a credential (`CF_AIG_TOKEN` or `ANTHROPIC_API_KEY`); direct Anthropic needs `ANTHROPIC_API_KEY`
alone. Any partial config (e.g. `AI_GATEWAY_URL` set with no credential, or a stray `CF_AIG_TOKEN`
with no URL) is treated the same as nothing configured and falls back to Workers AI, rather than
making a request that's guaranteed to fail. This fallback is silent by design (the article still
gets summarized) — if summaries look unexpectedly non-Claude-quality, check the `error` field on
`GET /api/admin/articles/:id` (owner-only — the public `GET /api/articles/:id` only exposes a
`has_error` boolean, not the raw message) for past failures, and your AI Gateway logs for whether
requests are actually arriving there. See "Deploy your own (fork)" below for the exact commands.

## Database

Apply migrations locally with:

```
deno run -A npm:wrangler d1 migrations apply DB --local
```

Against your real (remote) database, `deno task setup` applies migrations for you — see "Deploy your
own (fork)" below.

**Forkers note:** the `database_id` and KV `id` in `wrangler.toml` belong to whoever last ran
`deno task setup` in this checkout — if you fork a repo where someone already deployed, those ids
point at _their_ Cloudflare resources, not yours. `deno task setup` only replaces ids that are still
the literal placeholder `"PLACEHOLDER"`, so if you're forking a repo with real ids already
committed, reset both back to `"PLACEHOLDER"` in `wrangler.toml` first, then run `deno task setup`
to create/reuse resources under your own login.

## Queue-based pipeline execution

Every article's fetch → extract → summarize → persist pipeline runs inside a Cloudflare Queues
consumer, not inline in the request handler. The reason: `ctx.waitUntil()` (what earlier versions of
this app used) hard-caps at 30 seconds after the response is sent, and an unsettled promise is
cancelled outright at that point — a silent isolate teardown, not a catchable exception. Large
articles' Workers AI summarization calls have been measured well past 30 seconds; every past
`"timeout: processing did not complete"` incident traces back to this cap. A queue consumer
invocation gets minutes of wall time instead, so the `LLM_CALL_TIMEOUT_MS` guard (see
`summarize.ts`) can actually fire and turn a slow call into a clean `'failed'` row instead of the
article getting stuck.

Mutating endpoints and the scraping agent enqueue a small `{ kind, articleId, notify? }` message
(see `QueueMessage` in `packages/shared/src/types.ts`) onto the `clipfeed-jobs` queue instead of
running the pipeline directly; the same Worker's `queue()` export (`index.ts`) consumes it.
`kind: 'process'` runs the full pipeline; `kind: 'resummarize'` re-runs just the summarize step.
Extension-submitted HTML (up to 2MB) is too large for a Queues message body (128KB limit), so it's
handed off through KV instead — see `queue.ts`'s `stashPendingHtml`/`takePendingHtml`. Batch size is
1: one article per consumer invocation, so one slow summarization never blocks another queued
article. The pipeline itself already guarantees a terminal `'ready'`/`'failed'` row (see
`pipeline.ts`), so there's no dead-letter queue — a message that still fails after `max_retries` is
an infrastructure error, not a normal failure mode.

**Forkability / graceful degradation:** if the `JOBS` binding isn't available (the queue hasn't been
provisioned yet, or any environment that hasn't wired `[[queues.producers]]`), the app falls back to
the pre-Queues `ctx.waitUntil()` behavior with a logged warning (`queue.ts`'s `enqueueArticleJob`) —
large articles may hit the 30s cap again in that mode, but nothing crashes. `deno task setup`
provisions the queue (`wrangler queues create clipfeed-jobs`, reusing an existing one of that name
if present) — **run it once, before your first deploy**, since `wrangler deploy` needs the queue to
already exist to bind `[[queues.producers/consumers]]` to it. Cloudflare Queues is on the Workers
free plan (10,000 operations/day across reads/writes/deletes, 24h max retention).

## Deploy your own (fork)

ClipFeed is designed to be forked and run under your own Cloudflare account — nothing in this repo
is tied to a specific account, domain, or Access team.

1. Fork the repo.
2. `deno run -A npm:wrangler login`, then `deno task setup` — creates (or reuses) your D1 database,
   KV namespace, and the `clipfeed-jobs` queue (see "Queue-based pipeline execution" below), patches
   `wrangler.toml` with your real D1/KV ids, and applies migrations to the remote database. It never
   commits that patch for you; review and commit it yourself. It also prints which of the secrets
   below are already set, without ever reading or printing their values.
3. (Optional) Upgrade the LLM mode — ClipFeed already works out of the box on the free Workers AI
   default (see "LLM modes" above). To use a real Claude model instead, set one of:
   - **AI Gateway (recommended)** — gives you usage/cost visibility and lets you rotate or swap the
     provider key without a redeploy. Create a Gateway named `clipfeed` in the Cloudflare dashboard
     (AI > AI Gateway), then either store a provider (BYOK) key on it or load Unified Billing
     credits. Then:
     ```
     deno run -A npm:wrangler secret put AI_GATEWAY_URL
     deno run -A npm:wrangler secret put CF_AIG_TOKEN   # only if the gateway requires auth
     ```
   - **Direct Anthropic** — simplest, calls `api.anthropic.com` straight:
     ```
     deno run -A npm:wrangler secret put ANTHROPIC_API_KEY
     ```
4. `deno task deploy`.
5. Your Worker is now live at `*.workers.dev`. Reads are public by design — anyone can browse the
   feed, that's the point (see "Protecting your instance" below for the model). But every mutation
   requires a verified Cloudflare Access identity and **fails closed** until that's set up — meaning
   **you, the owner, can't add an article yet either.** Setting up Access (next section) is the
   last, required step, not an optional hardening pass.

See `.dev.vars.example` for local-dev secrets and variable overrides, and [CLAUDE.md](CLAUDE.md) for
the forkability policy new changes must follow.

Note the daily scraping agent (see "Daily scraping agent" below) runs **on by default** once
deployed — it uses the committed `packages/api/sources.json` list and `INTEREST_TOPICS` default, and
fires daily via the hourly cron (`AGENT_HOUR_UTC`, default `5`). Clear `AGENT_HOUR_UTC` to `""` if
you'd rather opt in later once Access/LLM mode are set up the way you want.

Two more optional pieces, once the above is working: "Protecting your instance" below (required
before real use — reads are public by design, but writes need this) and "Telegram bot" further down
(an optional capture path + daily digest, off by default).

## Protecting your instance

ClipFeed follows a **public-read / owner-write** model: the instance is meant to be a public page.
`GET /api/health`, `GET /api/config`, `GET /api/articles`, `GET /api/articles/:id`, and the SPA
shell/static assets are all open, no login required — that's intentional, not a gap. Every
_mutation_ — `POST /api/admin/articles`, `POST /api/admin/articles/:id/retry`,
`POST /api/admin/articles/:id/resummarize`, `PATCH /api/admin/articles/:id`,
`DELETE /api/admin/articles/:id` — plus `GET /api/admin/me` and `GET /api/admin/login` live under
`/api/admin/*` and require a verified Cloudflare Access identity.

**Retry vs. re-summarize:** these look similar but do different things. `retry` is for a
stuck/failed pipeline run — it re-fetches the article from scratch (or accepts fresh HTML from the
extension) and only works on a non-`ready` article. `resummarize` re-runs just the summarization
step against the already-extracted text stored on the article, skipping the fetch/extract stages
entirely when that text is available — cheaper, and deterministic input for comparing prompt/model
changes on an article you already have. It works on both `ready` (the normal case — get a fresh
summary without re-fetching) and `failed` (a superset of what retry can do, when there's stored text
to work from) articles, and only falls back to a full pipeline run when there's nothing stored yet
to summarize.

**This fails closed:** until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are both set, every request to
`/api/admin/*` gets `401 {"error":"auth_not_configured"}` — including yours. Unlike the read side,
there is no "open" bootstrap state for mutations; setting up Access below isn't optional hardening,
it's how you (and only you) get write access to your own instance.

Cloudflare Access attaches to a domain **path**, not an HTTP method, so a GET and a POST to the same
path can't get different policies. That's the reason mutations live under a dedicated `/api/admin`
prefix rather than sitting next to their public GET counterparts: Access protects exactly that
prefix, and the rest of the domain — including the SPA itself — stays outside it, public.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.** Set the application to
   your Worker's public hostname **with path `api/admin`** (e.g. domain `clipfeed.example.com`, path
   `api/admin`) — **not the bare domain.** Protecting the whole domain puts the public feed behind a
   login wall too, which defeats the point of this model.

   > If Access cannot be attached to your `*.workers.dev` hostname in your dashboard, attach the
   > Worker to a custom domain on your zone (Workers → Settings → Domains & Routes) and protect
   > `<your-domain>/api/admin` on that instead.

2. **Policy 1 (you):** Allow → Include → Emails → your email address. Login is via a one-time PIN or
   whatever identity provider you've configured for your Zero Trust team — this is what the SPA's
   "sign in" link takes you through, landing back on the feed with the
   add/archive/delete/retry/resummarize controls now visible.
3. **Policy 2 (for the Chrome extension/bots):** Allow → Include → Service Auth → create a Service
   Token, e.g. named `clipfeed-extension`. Save its Client ID and Client Secret somewhere safe —
   they're entered into the extension's Options page (see "Chrome extension" below) and aren't shown
   again after creation.
4. Copy your **team domain** and the application's **Audience (AUD) tag** from the Access
   application's Overview tab, then set them on the Worker:
   ```
   deno run -A npm:wrangler secret put ACCESS_TEAM_DOMAIN
   deno run -A npm:wrangler secret put ACCESS_AUD
   ```
   **`ACCESS_TEAM_DOMAIN` is a bare hostname — e.g. `myteam.cloudflareaccess.com` — no `https://`
   scheme, no trailing slash.** Pasting it with a scheme (as some dashboard views show it) passes
   `wrangler secret put` without error but silently fails JWT issuer verification on every request;
   this has bitten a real deploy before, worth double-checking.
5. **Verify:**
   - `curl https://<your-worker>/api/articles` (no headers, no login) → `200` — the public feed
     stays open.
   - `curl https://<your-worker>/api/admin/me` (no headers) → `401 {"error":"unauthorized"}`.
   - Open `https://<your-worker>/` in a browser, click "sign in" → Access login → redirected back to
     the feed, now showing the add/archive/delete/retry/resummarize controls.
   - `curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://<your-worker>/api/admin/me`
     (a Service Token from policy 2) → `200 {"sub": "...", "email": "..."}`.

**Both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` must be set for `/api/admin/*` to work at all** — with
only one set, or neither, every admin route returns `401 auth_not_configured` (fail closed) while
the public feed keeps working exactly as before.

## Bot protection (Turnstile) — currently dormant

Turnstile support was built for an earlier model where mutations were reachable without signing in,
and it protected them from scripted abuse. That model is gone: **every mutation now requires a
verified Cloudflare Access identity** (see "Protecting your instance" above), so there's no
anonymous-mutation surface left for Turnstile to guard. `turnstileGuard()`
(`packages/api/src/turnstile-middleware.ts`) is fully implemented and tested but isn't mounted on
any route in `index.ts`. `GET /api/config` still reports the configured site key if you've set one,
and the SPA still fetches it on boot — but nothing ever asks it to acquire a token, since no route
returns `turnstile_required` anymore.

The module, its tests, and the `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` config plumbing (see
`.dev.vars.example`) are left in place for a future genuinely-public write path — e.g. a "suggest a
link" form that intentionally doesn't require sign-in. Re-enabling it for such a route is a one-line
`turnstileGuard()` addition; see the middleware's own doc comment. If you don't plan to add one,
there's nothing to configure here — `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` can be left unset,
or you can remove `TURNSTILE_SECRET_KEY` if it's already set on a prior deploy (the site key alone,
with no secret, is inert — `readTurnstileConfig()` requires both).

## Telegram bot

Optional capture path + a daily digest, entirely separate from the extension/SPA. Send the bot a
link and it saves the article the same way the web UI does; `/digest` (or a daily cron, `06:00 UTC`
by default — see "The morning digest (cron)" below) sends a plain-text summary of everything that
finished processing in the last 24h; `/scrape` runs the daily scraping agent (see "Daily scraping
agent" below) on demand instead of waiting for its own cron hour. The bot is **private** — it
answers exactly one chat (yours) and politely refuses everyone else.

### How auth works here (read this before wiring it up)

The Telegram Bot API delivers updates to your Worker via an HTTP webhook, and Telegram has no way to
attach a Cloudflare Access identity to that request — so `POST /api/telegram/webhook` is
**intentionally public**, sitting outside `/api/admin/*` alongside the other public routes (see
"Protecting your instance" above for the overall model). Its own auth is a shared secret Telegram
echoes back on every call, in the `X-Telegram-Bot-Api-Secret-Token` header, checked with a
constant-time comparison. On top of that, the bot only ever acts on messages from the one chat id
you configure — every other chat gets a one-line refusal and nothing else happens. The endpoint 404s
outright (doesn't even reveal it exists) unless all three secrets below are set.

### Configuration

Three secrets, active only when **all three** are set (see `.dev.vars.example` for where to get each
value):

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) (`/newbot`).
- `TELEGRAM_WEBHOOK_SECRET` — any random string; `deno task telegram:setup` can generate one for
  you.
- `TELEGRAM_OWNER_CHAT_ID` — your numeric chat id; see "Finding your chat id" below.

Plus one `[vars]`, optional: `PUBLIC_BASE_URL` (e.g. `https://example.com`) — used only to build the
feed link in bot messages (the digest footer, the "saved" reply). Left as `""` by default; bot
messages simply omit the link when it's empty.

### Setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts — it gives you a bot
   token shaped like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
2. `deno task deploy` first, if you haven't already — the webhook needs a live URL to register
   against.
3. Set the three secrets:
   ```
   deno run -A npm:wrangler secret put TELEGRAM_BOT_TOKEN
   deno run -A npm:wrangler secret put TELEGRAM_WEBHOOK_SECRET
   deno run -A npm:wrangler secret put TELEGRAM_OWNER_CHAT_ID
   ```
   (Optionally also `deno run -A npm:wrangler secret put PUBLIC_BASE_URL`, or add it to
   `wrangler.toml`'s `[vars]` — it's not sensitive.)
4. Register the webhook with Telegram:
   ```
   deno task telegram:setup
   ```
   Prompts for the bot token, a webhook secret (press Enter to have it generate one — copy that
   value into step 3's `TELEGRAM_WEBHOOK_SECRET` if you do), and your deployed instance's public
   base URL; then calls Telegram's `setWebhook` and prints `getWebhookInfo` so you can confirm it
   took. (Deno's `prompt()` needs a real terminal — `--token=`/`--secret=`/`--base-url=` flags are
   also accepted for non-interactive use, but note those land in shell history, so prefer the
   prompts for a one-off run.)
5. Message your bot: `/start` for help, paste a link to save it, `/digest` for an on-demand summary,
   `/scrape` to run the daily scraping agent right now.

**Finding your chat id:** message your bot at least once (anything — even just `/start`), then run:

```
deno task telegram:setup --get-chat-id
```

It calls `getUpdates` and prints every chat id seen in recent messages — use the one for your own
private chat.

### The morning digest (cron)

`wrangler.toml`'s `[triggers]` section runs a single **hourly** cron, dispatched by UTC hour to
whichever daily jobs are configured for that hour (see "Daily scraping agent" below for the other
job it dispatches):

```
[triggers]
crons = ["0 * * * *"]
```

Two `[vars]` control the schedule — both plain UTC hours (`0`–`23`) as strings, both optional:

- `DIGEST_HOUR_UTC` (default `6`) — when the morning digest fires.
- `AGENT_HOUR_UTC` (default `5`) — when the scraping agent fires, one hour before the digest by
  default so a run's picks are already summarized by the time the digest goes out. This isn't a hard
  requirement, though: the digest covers "everything ready in the last 24h" regardless of ordering,
  so either hour can safely come first.

Clear either var to an empty string (or set something out of range) to disable that job entirely —
it just never fires, same as leaving the whole Telegram feature unconfigured disables the digest
altogether. Edit the hours to whatever suits you; they're always **UTC**, regardless of your own
timezone. `deno task deploy` (and the CD workflow on merge to `main`) applies `wrangler.toml`'s
triggers automatically; no separate registration step like the webhook needs. If there's nothing new
to report, the cron digest sends **nothing** — unlike `/digest`, which always replies (with a
"nothing new" message) since you asked for it directly.

### Privacy

This is a single-owner bot by design: article titles, summaries, and links are never sent to any
chat other than the one in `TELEGRAM_OWNER_CHAT_ID`. Saving via Telegram reuses the exact same
extract → summarize → persist pipeline as every other capture path (including the daily cost guard)
— nothing Telegram-specific is duplicated.

## Daily scraping agent

Once a day, the agent reads a small set of trusted sources, ranks the last 24h of candidates against
your interests with one cheap LLM call, and runs the top 5 through the normal extract → summarize →
persist pipeline — same as any other capture path, just self-initiated (`added_via: "agent"`). The
SPA already highlights the newest agent-added article from today with a "pick of the day" badge; no
separate review step exists — a pick that turns out uninteresting is just another card you can
archive.

### Sources (`packages/api/sources.json`)

Fork-editable, not a `[vars]` setting — it's a small JSON array committed to the repo, since a list
of feed URLs isn't really a secret or a per-deployment credential:

```json
[
  { "id": "hn", "type": "hackernews" },
  { "id": "arstechnica", "type": "rss", "url": "https://feeds.arstechnica.com/arstechnica/index" }
]
```

- `id` — short slug, used to tag saved articles (`tags: [id]`) and in logs. Renaming an existing
  entry's `id` is safe; it just starts a fresh tag going forward.
- `type` — `"rss"` (RSS2 or Atom, auto-detected) or `"hackernews"` (Hacker News top stories via the
  public Firebase API — no `url` needed).
- `url` — required for `"rss"` sources.

Add, remove, or repoint entries freely; a feed that starts returning errors is logged and skipped
for that run, never breaks the others. There's no dedicated test-a-feed command — the quickest way
to check a new URL works is `POST /api/admin/agent/run` (see below) and watch the logs.

Candidates whose URL host is a known thin/mirror host — a Twitter/X mirror or link shortener
(`xcancel.com`, `nitter.net`, `twitter.com`, `x.com`, `t.co`) — are dropped in the pool-building
stage before ranking even sees them: those pages are link-posts, not articles, and yield ~0 chars of
real extractable text (see `agent-pool.ts`'s `THIN_HOST_DENYLIST`, extend it if a new thin host
shows up in practice). Most Hacker News stories link to real articles, so this rarely shrinks the
pool.

### Interests (`INTEREST_TOPICS`)

One `[vars]` string — free text describing what you want surfaced, sent straight into the ranking
prompt:

```
INTEREST_TOPICS = "AI/LLMs and their engineering, software development, Cloudflare and edge computing, programming languages, security, notable science/tech news"
```

Edit it in `wrangler.toml` (or override locally via `.dev.vars`) to match your own taste — there's
no required format, just describe what you'd want picked.

### Schedule and manual trigger

Runs on `AGENT_HOUR_UTC` (default `5`) via the same hourly cron the Telegram digest uses — see "The
morning digest (cron)" above for both vars and how to disable either job. Two ways to run it on
demand instead of waiting for the clock:

- `POST /api/admin/agent/run` — Access-protected, returns `202` immediately and runs the job in the
  background.
- The Telegram `/scrape` command, if the bot is configured — replies "Запустил агента" immediately,
  same background job.

Re-running the same day is safe: candidates already saved (matched by URL) are excluded from the
pool, so nothing gets duplicated.

## Chrome extension

`packages/extension/` is a Manifest V3 extension that saves the **current tab's rendered HTML** (not
just its URL) to your ClipFeed instance in one click — this bypasses anti-bot walls that a
server-side fetch would hit, since the page is already rendered in your browser. It's published as a
single build with no backend baked in: every install (owner or forker) points it at their own server
and Access service token from the extension's Options page. The extension talks to your Worker
exactly like any other client — with `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers from
a Service Token (see "Protecting your instance" → policy 2 above).

### Build

```
deno task build:extension   # bundles packages/extension/ -> dist/extension/ (also runs as part of `deno task build`)
deno task zip:extension     # zips dist/extension/ -> dist/clipfeed-extension.zip (Chrome Web Store upload artifact)
```

`dist/extension/` is a complete unpacked extension: `manifest.json`, `background.js` (service
worker), `content-page.js` / `content-selection.js` (bundled with `@mozilla/readability`, injected
on demand — there's no static `content_scripts` entry in the manifest), `popup.html`/`.js`/`.css`,
`options.html`/`.js`/`.css`, and `icons/icon{16,32,48,128}.png` (procedurally generated at build
time from an inline gradient + monogram — no binary image assets are committed to the repo).

### Load it for development

1. `deno task build:extension`.
2. Chrome/Edge → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   `dist/extension/`.
3. Click the ClipFeed toolbar icon → gear icon → enter your Worker's URL and a Service Token's
   Client ID/Secret → **Save**. The extension requests a one-time, origin-scoped host permission for
   that server (`optional_host_permissions`, granted via `chrome.permissions.request`) so a
   store-published build never has to declare `<all_urls>` or know your origin in advance.
4. Reopen the popup on any article page → **Save page**.

Credentials are stored in `chrome.storage.local` (not `chrome.storage.sync`, so they never leave
this browser profile) **unencrypted** — anyone with local access to this Chrome profile can read
them. Treat that the same as any other locally-cached credential: if the machine is compromised,
revoke and reissue the Service Token in Zero Trust (Access → Service Auth) rather than trying to
"rotate" client-side.

### Manual verification status

No Chrome/Chromium binary was available in the environment this extension was built in, so "Load
unpacked" could not be exercised directly — verification here was `deno task test` (pure
capture/payload/tag/auth-header logic, 21 tests) plus inspecting the built `dist/extension/` and
`dist/clipfeed-extension.zip` output (valid PNG icons, no source maps, manifest paths resolve, zip
opens with a standard `unzip`). **Owner checklist** to run once after loading the unpacked build or
the store zip:

- [ ] Toolbar icon opens the popup; before configuring, it shows "ClipFeed is not configured yet" +
      an "Open settings" button (not a broken/blank popup).
- [ ] Settings gear (or "Open settings") opens the Options page.
- [ ] Options: entering a `http://` non-localhost URL is rejected before any network call.
- [ ] Options: entering your real server URL + Service Token prompts a Chrome permission dialog for
      that origin; declining it leaves the fields unsaved and shows a warning.
- [ ] Options: accepting the permission prompt, with correct credentials, shows "Connected ✓" and
      persists (reopening Options shows the same values).
- [ ] Options: a wrong Client Secret shows a clear auth error, not a generic failure.
- [ ] Popup on a normal article page shows the page's domain + title (2-line clamp) and an enabled
      "Save page" button; "or save selected text" is greyed out with nothing selected.
- [ ] Selecting text on the page, then reopening the popup, enables "or save selected text".
- [ ] "Save page" shows a spinner, then a green "Saved — summary in ~10s" card with "Open feed" and
      "Undo"; the toolbar badge briefly shows a green "✓".
- [ ] "Open feed" opens the configured server's origin in a new tab.
- [ ] "Undo" deletes the just-created article (verify it's gone from the feed) and returns to the
      Ready state.
- [ ] Saving the same URL twice shows "Already saved" (no duplicate article, no "Undo" button).
- [ ] Saving with a stale/wrong Service Token shows an auth-specific error message, and the badge
      shows a red "!" that persists until the popup is reopened. (Access is mandatory now — every
      `/api/admin/*` mutation, including the extension's saves, requires a valid Service Token; see
      "Protecting your instance".)
- [ ] `chrome://extensions` service worker inspector shows no `html` payload or credential values
      logged to the console during a save (only status/category per the security constraints).
