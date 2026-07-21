# Migrating to a custom subdomain (owner runbook)

This is an **owner-side operational checklist**, not something the code enforces — none of these
steps live in the repo because none of them are fork-generic (they're specific to one deployment's
Cloudflare account, Access app, and Turnstile widget). It exists purely so the exact order isn't
re-derived from memory next time an instance moves domains.

Context for this specific move: apex domain → a subdomain already attached as a Worker custom domain
in the dashboard. The apex will later redirect to a different domain at the zone level (also
owner-side, not code). Nothing below assumes those particular domains — swap in whatever your old
and new hostnames actually are.

## Before merging/deploying this change

1. **Zero Trust → Access → your admin app → change (or add) the destination** to
   `<new-host>/api/admin`. The application's AUD tag is per-app and survives a destination edit —
   you are **not** rotating `ACCESS_AUD` or any other secret here, just repointing which hostname
   the existing app protects.
2. **Turnstile widget → add the new hostname** to the allowed domains list. Keep the old hostname
   listed too during the transition (don't remove it yet — see step 7) so both are recognized while
   traffic still might hit either one.
3. **Verify the Worker custom domain is active** for the new hostname (Workers & Pages → your Worker
   → Settings → Domains & Routes) before merging/deploying this PR — the code change here
   (`workers_dev = false`) removes the `*.workers.dev` fallback route, so if the custom domain isn't
   actually live yet, deploying leaves the Worker unreachable until it is.

## After merging and deploying

4. **Browse the new host** and confirm reads work (public feed loads). Then **pass Access login**
   there (a fresh login is expected — Access identities are scoped per hostname) and **run one
   resummarize round-trip** end to end (pick any existing article, hit resummarize, confirm it
   completes) to confirm the full owner-mode path — auth, mutation, LLM call, persist — works on the
   new domain before relying on it.
5. **Update the Chrome extension's Options page server URL** to the new origin. Expect a permission
   re-prompt (Manifest V3 host permissions are origin-specific) — approve it, then re-verify capture
   still works from the extension.
6. **Re-point the Telegram webhook**:
   ```
   deno task telegram:setup --token=<bot token> --secret=<webhook secret> --base-url=https://<new-host>
   ```
   The **old** host's webhook keeps working until you do this — Telegram doesn't know the domain
   moved, so it keeps POSTing to wherever the webhook was last registered. This is exactly why this
   step has no strict deadline relative to the others, **except** for one thing: once the zone-level
   redirect (step 7) is live, a redirect response to a webhook POST does **not** get replayed as a
   POST by Telegram's delivery client (redirects don't replay request bodies) — so re-pointing the
   webhook must happen **before** the zone redirect goes live, not after, or the bot silently stops
   receiving updates with no obvious error on either side.

## Later — once you're confident the new host is solid

7. **Zone-level Bulk Redirect**: set up the apex → new-domain redirect at the Cloudflare zone level
   (owner-side dashboard config, not this repo). Only after that's live and confirmed working:
   - **Remove the old hostname from the Turnstile widget's allowed domains** (it's no longer serving
     real traffic directly — everything now redirects first).
   - **Delete the old Worker custom domain attachment** (Workers & Pages → your Worker → Settings →
     Domains & Routes → remove the old one). Do this last, since removing it too early — before the
     zone redirect is confirmed — would make the old hostname 522/unreachable instead of
     redirecting, which is a worse failure mode for anyone still holding an old bookmark or link
     mid-transition.

## What does NOT need to change

- `ACCESS_AUD` and the Access app itself — same app, same AUD, just re-pointed (step 1).
- `TURNSTILE_SECRET_KEY` — unaffected by which hostname the widget is allowed on.
- Any D1/KV/Queue resource — none of them are hostname-scoped.
- `PUBLIC_BASE_URL` in the committed `wrangler.toml` — it ships as `""` (fork-friendly default);
  this repo never hardcodes a real deployment's domain. The owner's real value lives only in their
  own deployed environment (set via `wrangler secret put PUBLIC_BASE_URL` or a local, uncommitted
  `wrangler.toml` edit), never in a commit.
