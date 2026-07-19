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
`GET /api/articles/:id` for past failures and your AI Gateway logs for whether requests are actually
arriving there. See "Deploy your own (fork)" below for the exact commands.

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

## Deploy your own (fork)

ClipFeed is designed to be forked and run under your own Cloudflare account — nothing in this repo
is tied to a specific account, domain, or Access team.

1. Fork the repo.
2. `deno run -A npm:wrangler login`, then `deno task setup` — creates (or reuses) your D1 database
   and KV namespace, patches `wrangler.toml` with your real ids, and applies migrations to the
   remote database. It never commits that patch for you; review and commit it yourself. It also
   prints which of the secrets below are already set, without ever reading or printing their values.
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
5. Your Worker is now live at `*.workers.dev` and **unprotected** — anyone with the URL can call its
   API (including the summarization endpoint, which spends your LLM budget). See "Protecting your
   instance" below to lock it down with Cloudflare Access before real use.

See `.dev.vars.example` for local-dev secrets and variable overrides, and [CLAUDE.md](CLAUDE.md) for
the forkability policy new changes must follow.

## Protecting your instance

By default a deployed ClipFeed instance is **public** — anyone with the URL can read, add, and
delete articles. The Worker itself verifies a Cloudflare Access JWT on every request (except
`GET /api/health`, kept open for monitoring); Access issues that JWT after your own login policy, so
setup happens in the Cloudflare dashboard, not in code:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.** Set the application
   domain to your Worker's public hostname.

   > If Access cannot be attached to your `*.workers.dev` hostname in your dashboard, attach the
   > Worker to a custom domain on your zone (Workers → Settings → Domains & Routes) and protect that
   > hostname instead; then treat direct `*.workers.dev` access as blocked by this middleware's 401.

2. **Policy 1 (you):** Allow → Include → Emails → your email address. Login is via a one-time PIN or
   whatever identity provider you've configured for your Zero Trust team.
3. **Policy 2 (for the Chrome extension/bots):** Allow → Include → Service Auth → create a Service
   Token, e.g. named `clipfeed-extension`. Save its Client ID and Client Secret somewhere safe —
   they're entered into the extension's Options page (see "Chrome extension" below) and aren't shown
   again after creation.
4. Copy your **team domain** (e.g. `myteam.cloudflareaccess.com`) and the application's **Audience
   (AUD) tag** from the Access application's Overview tab, then set them on the Worker:
   ```
   deno run -A npm:wrangler secret put ACCESS_TEAM_DOMAIN
   deno run -A npm:wrangler secret put ACCESS_AUD
   ```
   (Secrets are recommended; plain `[vars]` work too since neither value is sensitive on its own —
   but per the forkability policy, never commit a real value as a default in `wrangler.toml`.)
5. **Verify:**
   - Opening the app in a browser now shows the Access login instead of the feed.
   - `curl https://<your-worker>/api/articles` (no headers) → `401`.
   - `curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://<your-worker>/api/articles`
     (a Service Token from policy 2) → `200`.

**Both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` must be set for auth to activate.** With only one set,
or neither, the Worker logs a warning once per isolate ("Access auth disabled — set
ACCESS_TEAM_DOMAIN and ACCESS_AUD") and serves openly — this is the zero-config fork/dev bootstrap
state, not a failure mode. Once both are set, every tool you use to smoke-test the deployed Worker
(`curl`, browser, scripts) needs either a logged-in Access session cookie or
`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers from a Service Token — plain requests will
get a `401`.

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
- [ ] Turning the Worker's Access enforcement on and saving with a stale/wrong token shows an
      auth-specific error message, and the badge shows a red "!" that persists until the popup is
      reopened.
- [ ] `chrome://extensions` service worker inspector shows no `html` payload or credential values
      logged to the console during a save (only status/category per the security constraints).
