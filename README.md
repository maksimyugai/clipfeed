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
   try the app out, not the last word (see "Two validation tiers" below for exactly how this plays
   out).
2. **AI Gateway (recommended upgrade)** — routes calls through Cloudflare AI Gateway to a real
   Claude model, with usage/cost visibility and key rotation without a redeploy. Set secret
   `AI_GATEWAY_URL` to your gateway's Anthropic-provider endpoint — it must already end in
   `/anthropic` (ClipFeed appends `/v1/messages` itself, not the whole path):
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic` (see
   `.dev.vars.example`). Add `CF_AIG_TOKEN` too if the gateway requires auth. The actual model
   called is `SUMMARY_MODEL` ([vars] in `wrangler.toml`, default `claude-haiku-4-5-20251001`) —
   change that value for a different Claude model; no secret needed, since it's not sensitive.
3. **Direct Anthropic** — calls `api.anthropic.com` straight, using the same `SUMMARY_MODEL`. Set
   secret `ANTHROPIC_API_KEY`.

A mode is only used when its configuration is **complete** — AI Gateway needs `AI_GATEWAY_URL` _and_
a credential (`CF_AIG_TOKEN` or `ANTHROPIC_API_KEY`); direct Anthropic needs `ANTHROPIC_API_KEY`
alone. Any partial config (e.g. `AI_GATEWAY_URL` set with no credential, or a stray `CF_AIG_TOKEN`
with no URL) is treated the same as nothing configured and falls back to Workers AI, rather than
making a request that's guaranteed to fail. This fallback is silent by design (the article still
gets summarized) — if summaries look unexpectedly non-Claude-quality, check the `error` field on
`GET /api/admin/articles/:id` (owner-only — the public `GET /api/articles/:id` only exposes a
`has_error` boolean, not the raw message) for past failures, and your AI Gateway logs for whether
requests are actually arriving there. See "Deploy your own (fork)" below for the exact commands.

### Two validation tiers

Every summary is checked against a content-quality bar before it's persisted (title length, tldr
length, bullet count/length, body paragraph count/length, and a duplicate-content heuristic — see
`validateSummary` in `packages/api/src/summarize.ts`) — an LLM response that fails gets one
corrective retry naming the specific violations, then the article is marked `'failed'` rather than
storing a substandard summary. There are two named tiers, not one: **STRICT** (gateway/direct,
Claude-class models) and **RELAXED** (Workers AI's free-tier Llama default) — Claude-class models
reliably clear STRICT on the first attempt, but Llama 3.3 70B needs a more forgiving floor to get a
usable first/second-attempt success rate.

**Neither tier is a fixed table of numbers anymore.** Both are _derived_ from one owner setting —
`SUMMARY_BODY_TARGET_CHARS` — by `deriveSummarySpec()` in `summarize.ts`, and the exact same derived
object feeds both the prompt (`buildSystemPrompt`) and the validator (`validateSummary`), so there's
no separate "prompt number" and "validator number" that can drift out of sync with each other.

### Summary length (`SUMMARY_BODY_TARGET_CHARS`)

`SUMMARY_BODY_TARGET_CHARS` ([vars] in `wrangler.toml`, default `800`, valid range `400`–`4000`) is
how much summary you want to read — the target _total_ body length in characters, across all
paragraphs, for the (Russian-only, see "Russian-first summaries & lazy English" below) generated
summary. Everything else derives from it:

- **Paragraph count** widens as the target grows, based on the tier your target falls into (≤900,
  ≤2000, beyond): STRICT gets 2, 2–3, or 3–4 paragraphs; RELAXED gets one extra paragraph of
  headroom on the upper end of whichever tier STRICT lands in (2–3, 2–4, or 3–5) — Llama's shorter
  natural paragraphs need more of them to add up to a comparable total.
- **Per-paragraph length**: STRICT's per-paragraph target is `target ÷ paragraph-count`; RELAXED's
  is computed from a _scaled-down_ effective target (`round(target × 0.7)`) instead of the raw
  setting — Llama reliably writes shorter paragraphs than Claude given the same numbers, so RELAXED
  asks for what it actually produces rather than a STRICT-shaped target under a different name. Both
  tiers' prompts state `aim for ± 25%` of their own per-paragraph target, and the prompt's stated
  `{min}`–`{max}` sizing band widens further, and in **opposite directions per tier**: STRICT
  `−40%/+60%` (more room above — Claude-class models overshoot, not undershoot), RELAXED `−55%/+40%`
  (more room below — Llama undershoots instead), both floored so even a small target still yields a
  real paragraph (STRICT ≥ 250 chars, RELAXED ≥ 120) — no more silent, always-700 ceiling regardless
  of what you asked for. Because RELAXED derives its ceiling from both a smaller effective target
  _and_ a smaller high-side widening factor, its absolute paragraph ceiling can end up _lower_ than
  STRICT's at the same setting — that's intentional, not a bug: each tier's bounds are calibrated to
  its own model's actual overshoot/undershoot behavior, not to RELAXED being wider on every single
  axis. **This prompt-facing number is the _soft_ max** — see "Asymmetric validation" below for what
  the validator actually enforces, which is more forgiving than what the model is told to aim for.
- **tldr minimum**: STRICT is `max(150, 15% of target)` capped at 350 characters; RELAXED is 75% of
  whatever STRICT computes to — from the raw target, not the scaled-down effective one.
- **Bullets** don't scale with the target — they're about the _count_ of scannable facts, not prose
  volume, so both tiers keep their original ranges (STRICT 4–7 × 40–220 chars, RELAXED 3–7 × 30–220
  chars — 220 is likewise a soft max, see below).
- **`max_tokens`** scales with the raw target too, clamped to `[1500, 5000]` — see "Russian-first
  summaries & lazy English" below for the exact formula and why those numbers are what they are.

A bad override (missing, non-numeric, or outside `[400, 4000]`) falls back to the `800` default and
logs a warning naming the rejected value — never a broken or nonsensical prompt.

### Asymmetric validation: undershoot fails, moderate overshoot doesn't

Every per-item character bound above (body paragraph length, bullet length) is really **two**
ceilings, not one: `softMax` (the exact number quoted in the prompt and in the paragraphs above —
unchanged by this section) and `hardMax = round(softMax × 1.5)`, which is what `validateSummary()`
actually rejects on. The floor (`min`) is still a single hard bound — undershoot is a real quality
problem (a paragraph that's too short is thin, unhelpful prose), but a live incident showed the
opposite direction wasn't: a summary failed outright over `body_en` at 854 characters (old hard max
768) and `bullets_en` at 229 (old hard max 220) — a handful of characters of _extra, real detail_
burning a corrective retry for no reader-facing harm. So now:

- `length < min` → violation (unchanged).
- `softMax < length <= hardMax` → **passes**, logging
  `validation_soft_overshoot {field, got,
  softMax}` for visibility — this is pure observability,
  never a retry.
- `length > hardMax` → violation, worded "is extremely long" (not the generic "must be between X and
  Y") — still gets the existing corrective retry naming the exact paragraph and its aim-for band.

At the default target (STRICT), that's a 768-char soft max but a 1152-char (`768 × 1.5`) hard one
for body paragraphs, and a 220/330 soft/hard split for bullets, in both languages, both tiers.

**Rescuing rows that failed under the old, stricter bounds:**
`POST /api/admin/heal/revalidate-failed` (already existed for the exact same reason after the
previous prompt recalibration) matches on the error prefix
`'internal: summarize: summary validation'` regardless of the specific violation text — since every
row that failed on moderate overshoot under the old bounds has exactly that error shape, this
endpoint catches them with no changes of its own. Run it once, as the owner, after this change
deploys.

**Known edge case:** at the smallest allowed target (`400`), STRICT's 250-character paragraph floor
sits _above_ the prompt's own "aim for 150–250" band — the enforced minimum and the suggested target
briefly disagree at that one boundary. Harmless (the model still has a valid 250–280 range to land
in) but worth knowing if you dial the setting all the way down.

**The few-shot example in the prompt is calibrated for the _default_ target (800).** With a heavily
non-default `SUMMARY_BODY_TARGET_CHARS`, it still illustrates the right _structure_ (what a
paragraph vs. a bullet vs. a tldr should look like), but its exact character counts won't match your
target — the sizing block above it (the actual `{min}`–`{max}`, "aim for X–Y", "~N characters total"
numbers) is what the model is expected to follow for the real request.

**Why RELAXED is genuinely relaxed (not just STRICT under a different name):** an earlier version of
this derivation scaled both tiers off the _same_ raw target and only let RELAXED's floor differ from
STRICT's — at the default 1200-char target that floor rarely bound, so the two tiers converged onto
nearly identical body-paragraph bounds. Live-testing a real Wikipedia article in Workers AI mode
caught this directly: 2/2 runs failed on paragraph-length undershoots in the 240–290 character range
that a genuinely permissive RELAXED profile should accept. The fix is the effective-target scaling
(RELAXED derives its per-paragraph size from `round(target × 0.7)`, not the raw target — Llama
reliably writes shorter paragraphs than Claude given the same numbers) and wider paragraph-count
range described above — RELAXED's bounds are now provably more permissive than STRICT's at every
target (lower floor, wider paragraph-count range), not just at the smallest one, and a follow-up
live-verify run (2 real articles, workers-ai mode, 3 total attempts including one retry) confirmed
it: **zero of those attempts failed on a paragraph-length violation** — one article passed cleanly
first-try with 162–225-char paragraphs that the old formula would have rejected outright; the other
failed twice, but on unrelated validation rules (a bullet duplicating the tldr, then a paragraph/
bullet _count_ miss) rather than length, meaning the specific regression this fix targets is
resolved even though Workers AI's overall first-try pass rate on a harder article isn't 100%. If
quality matters more than staying on the free tier at all, set up AI Gateway or direct Anthropic
(above) — gateway/direct summaries always use STRICT regardless of how good a given Llama response
might have been.

**Why STRICT's ceiling widened again (asymmetrically) after that fix:** at the default target, the
formula above initially gave STRICT a symmetric `±40%` ceiling of 672 characters — but real Claude
output, produced _with_ this prompt's sizing block already in place, hit 709–716-character
paragraphs and kept failing validation on overshoot. Claude-class models overshoot; they don't
undershoot the way Llama does, so the fix widened STRICT's ceiling specifically (`+60%`, giving 768
at the default target — comfortably above the observed 709–716) while leaving STRICT's floor and
RELAXED's whole profile untouched. Two earlier live observations of 796–857-character paragraphs
predate the sizing block being added to the prompt at all, so they aren't evidence against this
specific fix; they're a data point that a sizing-block-equipped STRICT still occasionally clears
768, in which case the next knob to reach for is a smaller `SUMMARY_BODY_TARGET_CHARS` (which
shrinks every derived bound proportionally) rather than widening the ceiling further and further —
if you see repeated overshoot failures on gateway/direct summaries after this change, that's the
signal to check the health-report's failure counts and consider lowering the target instead.

**Rescuing a backlog after changing this setting:** articles that failed with a
`'internal:
summarize: summary validation'` error under the _old_ bounds might well pass under new
ones. `POST
/api/admin/heal/revalidate-failed` (owner-only) re-enqueues every such article
regardless of its healing attempt count, resetting that count first — run it once after changing
`SUMMARY_BODY_TARGET_CHARS` (or after any prompt/validation change) to sweep up the backlog instead
of retrying each one by hand. Responds `202 {count}`.

## Russian-first summaries & lazy English

The owner reads Russian only. Emitting both a Russian and an English edition in the same LLM
response doubles output tokens for a language nobody reads by default, and was a real cause of
`max_tokens` truncation on longer targets. As of Task 35, a fresh summarization request generates
**only** the Russian fields (`title_ru`, `tldr_ru`, `bullets_ru`, `body_ru`, `tags`,
`lang_original`) — the `_en` fields are gone from the JSON schema, the system prompt, both
validation profiles, and the few-shot example. Articles summarized before this change keep whatever
English content they already have (no backfill, no deletion) — the `_en` fields on `SummaryJson` are
optional now, not removed, so old rows still round-trip correctly.

**`max_tokens` formula (RU-only).** Russian is roughly 2–3× more token-expensive per character than
English (Cyrillic tokenizes less efficiently), so halving the old RU+EN budget would have been the
wrong arithmetic — the formula below is derived from scratch in RU-only terms:

```
ENGLISH_TOKENS_PER_CHAR   = 0.25              (~4 chars/token, standard rough estimate)
CYRILLIC_TOKEN_MULTIPLIER = 2.5               (middle of the commonly-cited ~2-3x range)
CYRILLIC_TOKENS_PER_CHAR  = 0.25 * 2.5 = 0.625

RU_OVERHEAD_CHARS = 2100   (everything besides the body: up to 7 bullets * 220 chars = 1540,
                            tldr ~350, title ~90, tags/JSON structure ~100 — rounded up)
MAX_TOKENS_SAFETY_MARGIN  = 1.25              (run-to-run variance headroom)

maxTokens(targetTotalChars) = clamp(
  ceil((RU_OVERHEAD_CHARS + targetTotalChars) * CYRILLIC_TOKENS_PER_CHAR * MAX_TOKENS_SAFETY_MARGIN),
  MIN_MAX_TOKENS = 1500,
  MAX_MAX_TOKENS = 5000,
)
```

At `SUMMARY_BODY_TARGET_CHARS` = 400 / 800 / 1200 / 2000, this yields **1954 / 2266 / 2579 / 3204**
tokens respectively (all four exact values are asserted in `summarize_test.ts`). The formula is
identical for both validation profiles (STRICT/RELAXED) — only the body-length targets those
profiles derive differ, not this calculation.

**Lazy English generation.** English is now opt-in and owner-only, generated independently from the
article's stored `full_text` — never by translating the Russian summary, for the same reason the
original RU/EN generation was independent (translating a summary risks compounding whatever the
summary itself already dropped or paraphrased).

- `POST /api/admin/articles/:id/translate` (Access-protected) enqueues an EN-generation job on the
  same queue/provider stack as regular summarization. It requires the article to be `ready` with
  stored `full_text`; if `en_generated_at` is already set it's a `200` no-op (idempotent — safe to
  call repeatedly without checking first), otherwise it enqueues and returns `202`. The job merges
  the resulting `title_en`/`tldr_en`/`body_en`/`bullets_en` into `summary_json`, sets
  `en_generated_at`, and never touches the article's RU content or `status`.
- Resummarizing an article's RU content always clears `summary_en`/`en_generated_at` back to `null`
  — a stale English edition describing content that's since been rewritten in Russian is worse than
  no English edition, and the owner can just call `.../translate` again.
- **In the SPA:** the RU/EN toggle in the header is **owner-only** — a visitor always gets the
  Russian feed with no language switch at all. When the owner switches to EN, any visible, `ready`
  article without an English edition yet renders a "preparing English version" skeleton instead of
  silently falling back to Russian, and the SPA fires `.../translate` for that card automatically
  (capped at 5 concurrent requests across the whole page, never in bulk — see
  `lib/translateQueue.ts`), then polls on the same schedule as any other pending work until
  `en_generated_at` appears. Articles that already have English (summarized before this change, or
  already translated) render normally in EN mode immediately.

## Faithfulness check

After a summary validates (see above), a SEPARATE verification pass checks whether it actually
reflects the source, or invented/contradicted something. The judge is **always Workers AI Llama**
(`env.AI`, `FAITHFULNESS_JUDGE_MODEL`), regardless of which model wrote the summary — a model can't
reliably catch its own fabrications, and the free-tier binding is cheap enough to run on every
article.

**Config (`[vars]` in `wrangler.toml`, or override in `.dev.vars`):**

- `FAITHFULNESS_CHECK` (default `"true"`) — master on/off. Only the literal `"false"` disables it:
  no judge call, no `faithfulness_*` columns written, the pipeline behaves exactly as it did before
  this feature existed.
- `FAITHFULNESS_ENFORCE` (default `"false"`) — **soft/signal-only by design for this first
  release.** A `'fail'` verdict is stored and shown as a badge, but the article still proceeds to
  `ready` regardless. Only the literal `"true"` turns on the enforce path: a `'fail'` triggers one
  resummarize-and-reverify attempt, and if that retry still fails the judge, the article is
  permanently discarded (`status: 'failed'`,
  `error: 'faithfulness: summary not supported by
  source'`). Leave this off until you've watched
  the health-report's faithfulness breakdown for a while and trust the judge isn't producing false
  positives on your content.
- `FAITHFULNESS_JUDGE_MODEL` (default `"@cf/meta/llama-3.3-70b-instruct-fp8-fast"`, same default as
  `WORKERS_AI_MODEL`) — a separate setting so an owner running Claude via gateway/direct for
  summarization can still pick a specific Llama judge model.

**How it works:** the judge is given the numbered claims (the tldr + each bullet + each body
paragraph — RU fields, since Task 35 made summarization Russian-only by default; see "Russian-first
summaries" above) and the same extracted source text the summarizer saw, and returns
`supported`/`unsupported`/`contradicted` per claim plus a short source-span citation for each. Any
single `contradicted` claim fails the article outright; otherwise the unsupported-claim ratio
decides `pass` (≤25%), `weak` (25–50%), or `fail` (>50%) — see `packages/api/src/faithfulness.ts`
for the exact thresholds, which are intentionally round, untuned numbers for this first release
rather than something calibrated against real judge output yet.

**Cross-lingual caveat:** the source article is usually English while the summary being judged is
now Russian by default (it was the reverse before Task 35, when EN was the judged language and RU/EN
were both always generated). The judge prompt explicitly tells the model that the claim and the
source may be in different languages and that it must judge MEANING, not wording or language match —
but this is inherently a harder task for the judge than same-language verification was, and verdict
quality (especially the supported/unsupported boundary) may be less reliable than before. No paid
judge model swap is planned for this yet — watch the `pass`/`weak`/`fail`/`null` breakdown in
`GET /api/admin/health-report` over time and reconsider `FAITHFULNESS_JUDGE_MODEL` or
`FAITHFULNESS_ENFORCE` if the weak/fail rate climbs higher than you'd expect from the source
material.

A judge failure (timeout, unparseable output even after one corrective retry) never blocks a good
summary — it's recorded as a `null` verdict and the article proceeds normally either way. The judge
call does **not** count against the paid summarization budget above (`DAILY_SUMMARY_LIMIT`) — it has
its own uncapped KV counter purely for observability, visible in `GET /api/admin/health-report`
alongside a pass/weak/fail/null breakdown across every article.

**In the SPA:** a `'weak'`/`'fail'` verdict shows a small amber, non-alarming badge ("needs
review"/"possibly inaccurate") on the card — visible to owner **and visitor** alike, since the whole
point is transparency, not a private owner tool. `'pass'` and `null` (disabled/never checked) show
nothing at all. The badge is a tooltip trigger (`Tooltip.tsx`/`lib/tooltip.ts`, no external library)
explaining in plain language what the badge means and that a separate AI model did the checking —
hover or keyboard-focus on desktop, tap on touch (dismissed by an outside tap or Escape). The
owner-only expanded-card footnote additionally shows the unsupported/contradicted claim counts from
the judge's full response.

**Spot-checking the judge:** `POST /api/admin/articles/:id/reverify` (owner-only, `202`) re-runs
only the faithfulness stage against an already-summarized article's stored text and summary — no
re-fetch, no re-summarize, no status change — a cheap way to see how the judge scores a specific
article without touching anything else.

## Article images

After extraction, the pipeline reads the fetched page's `og:image` (falling back to `twitter:image`)
and, if present, downloads it into a dedicated R2 bucket for the article's card and link previews.
Only a publisher-provided image explicitly intended for link previews is ever used, cached, or shown
— never anything scraped from the article body itself — and it's always displayed with an
attribution caption naming the source domain (see below). Images are strictly optional: no
`og:image` tag, a download failure, or the feature being disabled all leave the article completely
unaffected — nothing about the summary or its status depends on whether an image was found.

**Fork setup:** `deno task setup` provisions the `clipfeed-images` R2 bucket the same way it
provisions D1/KV/Queues/Vectorize (create-or-reuse, patches nothing since a bucket name — like a
queue or Vectorize index name — has no id to write into `wrangler.toml`). Without the bucket
provisioned (fresh fork that hasn't run setup yet), the `IMAGES` binding is simply absent and the
image stage silently skips storing anything — same graceful-degradation story as Vectorize/Queues.

**Download path:** the image URL goes through the exact same SSRF-safe fetch guard as article
fetching (`ssrf.ts`'s `safeFetchImageBytes`) — http/https only, private IP ranges rejected,
redirects re-validated at each hop — with its own 10-second timeout and 5 MB size cap. Content-Type
must be `image/jpeg`, `image/png`, `image/webp`, or `image/gif`; **SVG is explicitly rejected** (an
SVG can carry embedded scripts, unlike a raster image). At most one image is stored per article,
keyed `articles/<id>.<ext>` in R2. `IMAGES_ENABLED` ([vars] in `wrangler.toml`, default `"true"`)
disables the whole feature — only the literal `"false"` skips extraction/ download/storage entirely.

**Serving:** `GET /img/:id` (public, no auth — the feed itself is public) streams the R2 object with
`Cache-Control: public, max-age=31536000, immutable` and the stored content type; `404` when the
article has no image.

**In the SPA:** a collapsed card with an image shows a small thumbnail, right-aligned, with the
title/TL;DR/tags reflowing beside it (a card with no image renders exactly as before — this is
purely additive). An expanded card shows the image full-width above the TL;DR, with a caption line
("Изображение: `<domain>`" / "Image: `<domain>`") naming the site the image came from — the
attribution the paragraph above promises. Both use `loading="lazy"`, `decoding="async"`, and
explicit width/height to avoid layout shift; a failed image load hides the element gracefully
instead of showing a broken-image icon.

**Telegram:** no `sendPhoto` call — instead, when an article has an image, `GET /a/:id`'s OG tags
(see "Link previews" below) include `og:image` (an absolute URL to `/img/:id`) and switch
`twitter:card` to `"summary_large_image"`. Telegram's own link-preview crawler then renders the card
with the image automatically, the same mechanism that already renders the title/description.

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
article. Every consumer invocation logs `queue_received` as its first line and `queue_done` as its
last (with `articleId`/`kind`/`outcome`/`duration_ms`), and every successful enqueue logs
`queue_enqueued` — so a `wrangler tail` window always shows a life sign for a message, rather than a
silent gap if something goes wrong before the pipeline itself gets to log anything.

The pipeline itself guarantees a terminal `'ready'`/`'failed'` row for every invocation it actually
runs (see `pipeline.ts`) — but that guarantee only covers messages the consumer gets to run at all.
A message that's dropped before ever reaching a consumer invocation, or that exhausts `max_retries`
on a genuine infrastructure error, previously left its article stuck `'pending'` until the sweeper's
timeout with no record of what happened. `clipfeed-jobs`' consumer now has a
`dead_letter_queue = "clipfeed-dlq"`: Cloudflare routes an exhausted message there automatically,
and the same Worker's `queue()` export consumes it too (`batch.queue` tells the two apart) — it
marks the referenced article `'failed'` with `"queue: processing failed after retries"` and logs
`queue_dead_letter`, skipping articles that are already terminal (idempotent, so a message that
dead-letters after the pipeline itself already wrote a real result doesn't clobber it). This closes
the gap: no queue path can leave an article non-terminal, regardless of the failure mechanism.

**Burst behavior:** the daily agent enqueues up to `AGENT_DAILY_PICKS` messages in a tight loop (see
"Daily scraping agent" above), all landing in the queue within milliseconds of each other. A live
10-message burst showed at least two messages only succeeding on their **second** delivery attempt —
`queue_received`'s `attempt` field showed `2`, with no visible first-attempt log in that observation
window. This is consistent with (though not conclusively proven to be) contention from Cloudflare's
automatic consumer-concurrency scaling spinning up several invocations at once to drain a sudden
backlog; it could equally be an artifact of when a manual `wrangler tail` session was attached
relative to the burst, since tail only shows logs from the moment it connects onward. Either way,
`max_concurrency = 3` on the `clipfeed-jobs` consumer now caps how many invocations run concurrently
— a cheap, reversible, latency-insensitive change for a background job (nothing here is
user-facing-request-latency sensitive) regardless of which explanation is right. The existing
terminal-state guarantee + DLQ consumer + healing sweep already fully bound the actual risk: with
`max_retries = 2` (3 attempts total) and every observed message in that incident recovering by
attempt 2, no message reached the DLQ and no article was left stuck — a message that exhausted all 3
attempts would land in the DLQ and get terminal-failed there anyway, then get picked up by the
self-healing sweep like any other transient failure.

**Forkability / graceful degradation:** if the `JOBS` binding isn't available (the queue hasn't been
provisioned yet, or any environment that hasn't wired `[[queues.producers]]`), the app falls back to
the pre-Queues `ctx.waitUntil()` behavior with a logged warning (`queue.ts`'s `enqueueArticleJob`) —
large articles may hit the 30s cap again in that mode, but nothing crashes. `deno task setup`
provisions both queues (`wrangler queues create clipfeed-jobs` and `clipfeed-dlq`, reusing existing
ones of those names if present) — **run it once, before your first deploy**, since `wrangler deploy`
needs both queues to already exist to bind `[[queues.producers/consumers]]` (including the
`dead_letter_queue` reference) to them. Cloudflare Queues is on the Workers free plan (10,000
operations/day across reads/writes/deletes, 24h max retention) — the DLQ's own traffic is normally
zero, so it doesn't meaningfully add to that budget.

## Deploy your own (fork)

ClipFeed is designed to be forked and run under your own Cloudflare account — nothing in this repo
is tied to a specific account, domain, or Access team.

1. Fork the repo.
2. `deno run -A npm:wrangler login`, then `deno task setup` — creates (or reuses) your D1 database,
   KV namespace, the `clipfeed-jobs`/`clipfeed-dlq` queues (see "Queue-based pipeline execution"
   below), the `clipfeed-embeddings` Vectorize index + its `added_at` metadata index (see "Semantic
   dedup & search" below), and the `clipfeed-images` R2 bucket (see "Article images" below), patches
   `wrangler.toml` with your real D1/KV ids, and applies migrations to the remote database. It never
   commits that patch for you; review and commit it yourself. It also prints which of the secrets
   below are already set, without ever reading or printing their values. **Run this before merging a
   PR that touched `wrangler.toml`'s `[[r2_buckets]]`/`[[vectorize]]` entries** — those bindings
   fail deploy if the underlying resource doesn't exist yet.
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
5. **`workers_dev = false`** in `wrangler.toml` means your Worker does **not** get a `*.workers.dev`
   URL by default after this deploy — attach a custom domain first (Workers & Pages → your Worker →
   Settings → Domains & Routes → Add Custom Domain, on a zone you control), or flip
   `workers_dev = true` locally (uncommitted, or your own commit) if you just want to try the app on
   the free `*.workers.dev` hostname before wiring up a real domain. Either way, once you have a
   reachable URL: reads are public by design — anyone can browse the feed, that's the point (see
   "Protecting your instance" below for the model). But every mutation requires a verified
   Cloudflare Access identity and **fails closed** until that's set up — meaning **you, the owner,
   can't add an article yet either.** Setting up Access (next section) is the last, required step,
   not an optional hardening pass.
6. Set these after attaching your domain — both are `[vars]`, left as `""` by default (per the
   forkability policy), so nothing here is owner-specific until you fill them in yourself:
   - **`PUBLIC_BASE_URL`** — set it to the exact custom domain from step 5 (e.g.
     `https://your-domain.com`, no trailing slash). Used to build links back to the app in Telegram
     messages (see "Telegram bot" below): the drip post's card link and the digest command's footer.
     **Leaving this empty doesn't break anything** — those links are simply omitted from the message
     text — but until it's set, a published Telegram post has no way back to the actual article
     card.
   - **`REPO_URL`** (e.g. `https://github.com/you/clipfeed`) — your fork's repo. Shows a GitHub icon
     link in the header and turns the footer's "MIT" text into a link to your `LICENSE` file. Both
     stay hidden until you set it.

   `deno task setup` (step 2) prints a reminder naming both if either is still empty after
   provisioning.

See `.dev.vars.example` for local-dev secrets and variable overrides, and [CLAUDE.md](CLAUDE.md) for
the forkability policy new changes must follow.

Note the daily scraping agent (see "Daily scraping agent" below) runs **on by default** once
deployed — it uses the committed `packages/api/sources.json` list, `INTEREST_TOPICS` default, and
the curated-variety config (`packages/api/curation.json`/`blocklist.json`, all fork-editable, no
`[vars]` needed for any of it — see "Curated variety" below), and fires daily via the hourly cron
(`AGENT_HOUR_UTC`, default `5`). Clear `AGENT_HOUR_UTC` to `""` if you'd rather opt in later once
Access/LLM mode are set up the way you want.

Two more optional pieces, once the above is working: "Protecting your instance" below (required
before real use — reads are public by design, but writes need this) and "Telegram bot" further down
(an optional capture path + hourly drip publishing, off by default).

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

Optional capture path + hourly drip publishing, entirely separate from the extension/SPA. Send the
bot a link and it saves the article the same way the web UI does. Instead of a once-daily
wall-of-text digest, ClipFeed publishes **one standalone post per hour** — title, TL;DR, key points,
and a link to the full card — during a configurable daily window (see "Drip publishing (cron)"
below); `/publish` forces the next queued article out immediately instead of waiting for the next
tick, and `/digest` still exists for an on-demand plain-text summary of the last 24h if you want
one. `/scrape` runs the daily scraping agent (see "Daily scraping agent" below) on demand instead of
waiting for its own cron hour. The bot only ever acts on messages from your own chat — every other
chat gets a one-line refusal and nothing else happens.

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

Plus `[vars]`, all optional:

- `PUBLIC_BASE_URL` (e.g. `https://example.com`) — used to build links in bot messages (each drip
  post's card link, the digest footer, the "saved" reply) and the `GET /a/:id` link-preview route's
  `og:url`. Left as `""` by default; bot messages simply omit the link when it's empty, and `/a/:id`
  serves the plain SPA shell instead of injecting Open Graph tags. **Set this before relying on the
  drip's card links** — they point at `PUBLIC_BASE_URL + "/a/<id>"`, which is meaningless while it's
  blank.
- `TELEGRAM_CHANNEL_ID` (default `""`) — when set, drip posts go to this channel instead of your own
  DM. See "Publishing to a channel" below.
- `PUBLISH_START_HOUR_UTC` / `PUBLISH_END_HOUR_UTC` (defaults `4` / `18`), `PUBLISH_ENABLED`
  (default `true`), and `PUBLISH_MAX_PER_DAY` (default `10`) — see "Drip publishing (cron)" below.

### Setup

Get your chat id **before** registering the webhook — `getUpdates` (used to look it up) and a live
webhook can't both be active for the same bot, so doing this after step 5 below means untangling a
409 instead (see "Finding your chat id"):

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts — it gives you a bot
   token shaped like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
2. Message your new bot once (anything — even just `/start`), then find your chat id:
   ```
   deno task telegram:setup --get-chat-id
   ```
   Prints every chat id seen in recent messages — use the one for your own private chat as
   `TELEGRAM_OWNER_CHAT_ID` below. (See "Finding your chat id" if this fails with a 409.)
3. `deno task deploy` first, if you haven't already — the webhook needs a live URL to register
   against.
4. Set the three secrets:
   ```
   deno run -A npm:wrangler secret put TELEGRAM_BOT_TOKEN
   deno run -A npm:wrangler secret put TELEGRAM_WEBHOOK_SECRET
   deno run -A npm:wrangler secret put TELEGRAM_OWNER_CHAT_ID
   ```
   (Optionally also `deno run -A npm:wrangler secret put PUBLIC_BASE_URL`, or add it to
   `wrangler.toml`'s `[vars]` — it's not sensitive.)
5. Register the webhook with Telegram:
   ```
   deno task telegram:setup
   ```
   Prompts for the bot token, a webhook secret (press Enter to have it generate one — copy that
   value into step 4's `TELEGRAM_WEBHOOK_SECRET` if you do), and your deployed instance's public
   base URL; then calls Telegram's `setWebhook` and prints `getWebhookInfo` so you can confirm it
   took. (Deno's `prompt()` needs a real terminal — `--token=`/`--secret=`/`--base-url=` flags are
   also accepted for non-interactive use, but note those land in shell history, so prefer the
   prompts for a one-off run.)
6. Message your bot: `/start` for help, paste a link to save it, `/digest` for an on-demand summary,
   `/publish` to force the next queued article out right now, `/scrape` to run the daily scraping
   agent right now.

### Publishing to a channel

By default, drip posts land in your own DM — the same surface the old digest used, so the feature
works before you've set anything else up. To publish to a channel instead:

1. Create a Telegram channel (public or private).
2. Add your bot as an **admin** of the channel, with permission to post messages.
3. Set `TELEGRAM_CHANNEL_ID` to the channel's `@username` (public channels) or its numeric id, which
   looks like `-100XXXXXXXXXX` (private channels — forward a message from the channel to
   [@userinfobot](https://t.me/userinfobot) to get it). Either a `[vars]` entry in `wrangler.toml`
   or a secret works; it isn't sensitive.

Once set, both the hourly drip and `/publish` post there instead of your DM. Clear it back to `""`
to revert to DMs.

**Finding your chat id:** message your bot at least once (anything — even just `/start`), then run:

```
deno task telegram:setup --get-chat-id
```

It calls `getUpdates` and prints every chat id seen in recent messages — use the one for your own
private chat. If this fails with **409**, a webhook is already registered for this bot — Telegram
refuses `getUpdates` while a webhook is active (this is why step 2 above runs before step 5). Either
message [@userinfobot](https://t.me/userinfobot) for your numeric id instead, or temporarily remove
the webhook:

```
deno task telegram:setup --delete-webhook   # asks for confirmation first; add --yes to skip it
deno task telegram:setup --get-chat-id
deno task telegram:setup                    # re-registers the webhook once you have the id
```

### Drip publishing (cron)

`wrangler.toml`'s `[triggers]` section runs a single **hourly** cron. The scraping agent (see "Daily
scraping agent" below) dispatches once at `AGENT_HOUR_UTC`; the drip publish job runs on **every**
tick instead of a single hour, gated by its own window:

```
[triggers]
crons = ["0 * * * *"]
```

On every enabled tick (window or not — see below), ClipFeed first sweeps: any `ready`, non-archived,
still-unpublished article added **before the current UTC day** is marked as skipped-stale rather
than left to queue forever (Task 37 — see "Today-only selection and stale articles" below). Then, if
the current UTC hour falls inside `[PUBLISH_START_HOUR_UTC, PUBLISH_END_HOUR_UTC)` and
`PUBLISH_ENABLED` isn't the literal `"false"`, ClipFeed picks the **oldest** `ready`, non-archived,
not-yet-published article added **on the current UTC day** and posts it as a proper standalone
message: title in bold, the TL;DR, the key-point bullets, a "Читать полностью →" link to its card
(`PUBLIC_BASE_URL + "/a/<id>"` — a real path, not a hash fragment; see "Link previews" below), and a
plain-text source line (just the domain, e.g. `Источник: example.com` — no link). The message
therefore contains **exactly one** link, the ClipFeed card, so Telegram's own link-preview crawler
builds its preview from that card instead of the original article. At most one article goes out per
tick, so across the default 4–18 UTC window that's up to 14 posts a day — well under
`PUBLISH_MAX_PER_DAY`'s default of 10, so the cap (see below) is what actually governs the daily
total. An article is marked published the moment it's posted (or skipped — see below) so it's never
sent twice, even across restarts or config changes.

### Today-only selection and stale articles

Task 37: the drip selects only articles added on the **current UTC calendar day** — not a rolling
window. Owner decision: 10 posts/day (the cap, see below) is already more than enough for a full
day's picks to fit inside "today", so freshness beats completeness. An article that doesn't get
posted before the day ends is **not** carried over and published later — it stays visible in the
feed like any other article, it just never goes out over Telegram. To stop the job re-scanning a
growing backlog of old candidates on every tick, any such article is marked with a sentinel value in
its existing `telegram_published_at` column (distinct from a real publish timestamp, but every
reader of that column only ever checks NULL vs. NOT NULL, never parses it as a date — so reusing the
column avoids a migration) the first tick after its day has passed, logged as
`publish_skipped_stale
{count}`. This sweep is idempotent: once marked, a row can never be
reconsidered, so there's no re-looping.

### Daily post cap

**`PUBLISH_MAX_PER_DAY`** ([vars] in `wrangler.toml`, default `10`) caps how many articles the drip
actually sends per UTC day — a KV counter (`published:<YYYY-MM-DD>`, 48h TTL) increments on every
real send and resets naturally at the next UTC day. This matters because the scraping agent can
produce more than one batch in a day (see "Daily scraping agent" below and Task 36's run-level
idempotency); without the cap, a second batch's worth of picks would otherwise all drip out on top
of the first. Once the cap is hit, both the cron job and manual `/publish` no-op (logged as
`publish_cap_reached`) rather than posting further — `/publish` replies with "Дневной лимит
публикаций достигнут (N)" and, unlike `/scrape force`, has **no bypass**: the cap is a flood guard,
not an inconvenience. A faithfulness-`'fail'` skip (see below) never counts against the cap and is
never blocked by it, since it's never actually sent to Telegram.

### Link previews (`GET /a/:id`)

A hash fragment (`#article-<id>`, still accepted by the SPA for already-published posts) is never
sent to the server — link-preview crawlers (Telegram's included) only ever fetch a URL's raw HTML,
so a hash-only link can never get its own preview. Drip posts therefore link to `/a/<id>`, a real
path the Worker serves directly: it reads the SPA's own `index.html` from the static assets and
injects per-article `og:title`/`og:description`/`og:url`/`og:site_name`/`og:type`/`twitter:card`
meta tags into it (`Cache-Control: public, max-age=300`), then hands the same page to the browser,
which boots the SPA as normal and expands that card. An unknown id, a not-yet-`ready` article, or an
unset `PUBLIC_BASE_URL` all serve the plain, un-modified shell instead — never a 404.

An article whose faithfulness check came back `'fail'` (see "Faithfulness check" below) is **skipped
silently** — never posted, since broadcasting a likely-inaccurate summary is worse than staying
quiet — but still marked as handled, so the drip queue advances past it instead of retrying the same
skip forever. Nothing in the SPA or `/digest` is affected; this only changes what the bot
broadcasts.

`PUBLISH_ENABLED` set to `"false"` turns the whole job off (no posts, cron or `/publish`, and no
stale sweep either); any other value, including leaving it unset, means "on" — same "only the
literal false disables it" convention as `FAITHFULNESS_CHECK`.
`PUBLISH_START_HOUR_UTC`/`PUBLISH_END_HOUR_UTC` and `PUBLISH_MAX_PER_DAY` are all `[vars]` strings
parsed defensively (an invalid or missing value falls back to the documented default — `4`/`18`/`10`
respectively — with a logged warning) rather than disabling anything — the hour vars only bound the
window and the cap only bounds the count, neither is an on/off switch itself. Always **UTC**,
regardless of your own timezone. `deno task deploy` (and the CD workflow on merge to `main`) applies
`wrangler.toml`'s triggers automatically; no separate registration step like the webhook needs.

### Privacy

Drip posts go to `TELEGRAM_CHANNEL_ID` if you've set one, otherwise to your own
`TELEGRAM_OWNER_CHAT_ID` — never anywhere else. The webhook (saving links, `/digest`, `/publish`,
`/scrape`) only ever acts on messages from your own chat. Saving via Telegram reuses the exact same
extract → summarize → persist pipeline as every other capture path (including the daily cost guard)
— nothing Telegram-specific is duplicated.

## Daily scraping agent

Once a day, the agent reads a small set of trusted sources, ranks the last 24h of candidates against
your interests with one cheap LLM call, and runs the top `AGENT_DAILY_PICKS` (default `10`) through
the normal extract → summarize → persist pipeline — same as any other capture path, just
self-initiated (`added_via: "agent"`). The SPA already highlights the newest agent-added article
from today with a "pick of the day" badge; no separate review step exists — a pick that turns out
uninteresting is just another card you can archive.

**`AGENT_DAILY_PICKS`** ([vars] in `wrangler.toml`, default `10`, valid range `1`–`20`) is how many
candidates the agent saves per run — a bad override (missing, non-numeric, out of range) falls back
to `10` with a logged warning, same defensive-parse pattern as `SUMMARY_BODY_TARGET_CHARS`. Raising
it increases how many summarization slots the agent itself spends every day — see "Self-healing
failures" below for the `DAILY_SUMMARY_LIMIT` budget arithmetic this feeds into.

### Sources (`packages/api/sources.json`)

Fork-editable, not a `[vars]` setting — it's a small JSON array committed to the repo, since a list
of feed URLs isn't really a secret or a per-deployment credential. Eleven sources ship by default:
general tech (Hacker News, Ars Technica, The Verge, MIT Technology Review), AI/dev-focused (Simon
Willison, Cloudflare's blog), hardware/Linux (Tom's Hardware, Phoronix, LWN.net, ServeTheHome), and
security (The Hacker News, `thehackernews.com` — a distinct site and source `id` from the
pre-existing `"hn"`, which is Hacker News / `news.ycombinator.com`) — chosen for being established,
reputable outlets, not aggregators or SEO farms:

```json
[
  { "id": "hn", "type": "hackernews" },
  { "id": "arstechnica", "type": "rss", "url": "https://feeds.arstechnica.com/arstechnica/index" },
  { "id": "tomshardware", "type": "rss", "url": "https://www.tomshardware.com/feeds.xml" },
  { "id": "phoronix", "type": "rss", "url": "https://www.phoronix.com/rss.php" }
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

That static list isn't the only filter, though — the pool-building stage also consults a **learned**
blocklist in KV (see `thin-host-learning.ts`): any host that produces 2+
`'extraction: insufficient
text'` failures within a rolling 30-day window is filtered automatically,
no code change needed. This is populated both by fresh pipeline failures and by the hourly
self-healing sweep re-classifying older rows (see "Self-healing failures" below) — it only ever
filters _agent_ candidates, never a manually/extension/Telegram-added article, so a link you
deliberately save is never silently blocked by what the agent has learned to avoid. As of "Curated
variety" below, NEW learning signals go to a separate, superseding KV mechanism (`autoblock.ts`)
instead — this older counter stays read-only (still consulted, still respected) during the
transition, and its entries age out naturally via their existing 30-day TTL; nothing writes a fresh
`thinhost:` key anymore.

A candidate whose **title** starts with a known paywall marker is dropped the same way, before any
fetch is attempted — LWN prefixes subscriber-only article titles with `"[$]"` in its own RSS feed,
so this is a free, no-network signal (see `agent-pool.ts`'s `PAYWALL_TITLE_MARKERS`, an extendable
list for other sources with a similar convention). A paywalled URL that slips through anyway (no
title marker, but the fetch itself comes back `403`/`402`) is classified **permanent** by
`classifyFailure` — a paywall doesn't heal itself on retry, so an agent-picked row like this
auto-archives via the existing healing behavior, same as a 404/410.

The candidate pool (post-dedupe, pre-ranking) is capped at 160 (see `agent-pool.ts`'s `POOL_CAP`) —
raised from 120 when the source list grew to ten, so the wider set of feeds doesn't get truncated
before the ranking call even sees most of it.

**Pre-scrape dedup (before any LLM spend):** `buildCandidatePool` rejects a duplicate candidate in
three layers, cheapest first, so no ranking or summarization tokens are ever spent on one — (1)
exact URL/canonical-URL match (pool-internal and against every URL already saved), (2)
exact-normalized- title match (lowercased, punctuation/emoji stripped, whitespace collapsed — see
`title-similarity.ts`'s `normalizeTitleExact`), (3) title token-set Jaccard similarity `>= 0.6` (see
`titleSimilarity`, the same comparison function the story-level dedup below reuses). Layers 2 and 3
check both the other candidates already in this run's pool AND every article's title added to the DB
in the last 72 hours (`findRecentTitlesForDedup` in `db.ts`, capped at the most recent 300 rows for
cost) — a same-story duplicate from a different source, or a mirror/syndicated re-post under a new
URL, is dropped before it ever reaches the ranking call. Every drop logs
`pool_dedup_dropped
{candidateTitle, reason: 'url'|'title'|'jaccard', matchedId?}`, and the counts
by reason are folded into the agent run's own `pool` stage log
(`dedup_dropped`/`dedup_dropped_by_reason`).

Honest limitation: layers 1-3 are cheap string-only matching, not semantic — two differently-worded
headlines covering the same event that don't share enough tokens can still both pass through as
distinct candidates (e.g. "Company X Ships Feature Y" vs. "A New Way To Do Y Arrives"). A 4th,
embedding-based layer now runs last, after these three, when Vectorize is configured — see "Semantic
dedup & search" below for the model, the live-measured threshold, and its own honest best-effort
caveat; it's still not a substitute for these cheap layers running first, since it's the only one
that costs a Workers AI call per candidate. The Jaccard threshold here (`0.6`) is intentionally
stricter than the post-pick story-dedup's `0.5` below — this stage runs against the whole pool (100+
candidates), where a looser bar risks dropping genuinely distinct stories that merely share a
topic's common vocabulary; the post-pick stage runs on a small, already-curated set of picks where
being a bit more aggressive is safer.

### Ranking: diversity-aware, not just "newest/most relevant"

The one ranking LLM call is asked to respect four hard rules, restated below every candidate list
(see `buildRankSystemPrompt` in `ranking.ts`): at most 2 picks per source, cover at least 3 distinct
topic areas from your `INTEREST_TOPICS` when the pool allows it, prefer substantive reporting over
link-posts and speculation, and never pick two items covering the same story/event even from
different sources. The per-source cap is never just trusted to the model's own counting —
`enforceRankingDiversity` re-checks the model's response afterward and, if a source shows up more
than twice, drops the excess and backfills those freed slots from the next candidates of _other_
sources in the pool (newest-first), logging a `rank_diversity_fixup` line whenever this actually
triggers. If the pool doesn't have enough distinct-source candidates to fill every freed slot, the
agent just saves fewer than `AGENT_DAILY_PICKS` that day rather than violating the cap to force a
full count. The topic-diversity rule (b) is prompt-only — there's no per-candidate topic label to
mechanically re-check it against, so it depends on the model actually reasoning about your interest
list, same as picking "best" already does. The total-failure fallback path (LLM error or two
unparseable responses in a row) doesn't apply the per-source cap — it favors breadth first
(one-per-source, oldest-source-exhausted-first) and only repeats a source once every other source is
already represented, which naturally covers at least `min(3, distinct source count)` sources
whenever `AGENT_DAILY_PICKS >= 3`.

**Story-level dedup (never trust the model to have caught this either):** a live incident had two
picks cover the exact same story (a Kimi/Moonshot model release) from two outlets under two
different URLs — the URL-based dedupe elsewhere in the pipeline never saw a collision, since the
URLs genuinely differ. `dedupStories` in `ranking.ts` re-checks the model's (already
diversity-enforced) picks pairwise using the shared `titleSimilarity` function
(`title-similarity.ts` — consolidated there so the pre-scrape pool dedup above and this post-pick
backstop can never silently drift apart on what counts as "the same story"): titles are normalized
(lowercased, punctuation stripped, common English/Russian stopwords removed) into token sets, then
compared by plain Jaccard similarity (intersection over union); a pair scoring `>= 0.5` is treated
as the same story, and the lower-ranked one is dropped and backfilled from the next pool candidate
of a different story (still respecting the per-source cap above) — logging
`rank_story_dedup {kept, dropped}` when it triggers. The same check also runs against every article
**title saved in the last 48 hours** (`findRecentTitles` in `db.ts`), so the agent won't re-pick
yesterday's story just because a different outlet covered it today. This applies uniformly whether
the LLM call succeeded or fell all the way back to `fallbackPicks` — a same-story duplicate can't
slip through either path.

### Curated variety (topic quotas, priority sources, blocklist, auto-learned blocks)

The prompt rules above only _encourage_ variety — on an AI-heavy news day, Linux/hardware/security
can still vanish from the picks entirely, and Hacker News (the one aggregator source) can drag in
arbitrary domains: mirrors, paywalls, junk. Three fork-editable JSON files, all sibling to
`sources.json`, add guaranteed variety and an absolute domain policy on top of the ranking call —
none of this costs an extra LLM call.

**`packages/api/curation.json`** — taste, not policy:

```json
{
  "topicVocabulary": [
    "ai",
    "hardware",
    "linux",
    "security",
    "programming",
    "science",
    "business",
    "other"
  ],
  "topicQuotas": { "linux": 1, "hardware": 1, "security": 1 },
  "prioritySources": ["phoronix", "lwn", "thehackernews"],
  "preferredDomains": ["phoronix.com", "lwn.net", "thehackernews.com"]
}
```

- **`topicQuotas`** — minimum picks per topic, filled from the model's own topic labels (see below).
  The sum must never exceed 50% of `AGENT_DAILY_PICKS`, so quotas can never crowd out general
  ranking entirely — validated at load (`validateTopicQuotas` in `curation.ts`): an over-budget sum
  logs a `curation_quota_sum_exceeded` warning and truncates by dropping the **last-listed** quotas
  until it fits (so `{linux:1, hardware:1, security:1}` — sum 3 — comfortably fits within 50% of the
  default `AGENT_DAILY_PICKS` of 10). A quota topic with fewer matching candidates than requested
  just takes what exists and logs `rank_quota_unfilled {topic, wanted, got}` — it never blocks the
  run or forces in an off-topic pick.
- **`prioritySources`** — source ids (from `sources.json`) that each get **at most one** guaranteed
  slot, but only if the model's own ranked list includes at least one candidate from that source at
  all (see below) — an id the model rejected outright is never forced in. An id not present in
  `sources.json` is dropped and logged (`curation_priority_source_unknown`) rather than silently
  never matching anything.
- **`preferredDomains`** — **advisory only**; see the precedence rules below. Never unblocks a
  blocked domain, and its only effect on an otherwise-unblocked domain is a small tie-break bonus in
  general fill.
- Empty values (`{}`/`[]`) reduce every rule above to a no-op — today's (pre-this-feature) ranking
  behavior exactly.

**`packages/api/blocklist.json`** — absolute, manual, in git:

```json
{
  "blockedDomains": ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "medium.com"],
  "note": "Hard paywalls and open-publishing platforms — extraction yields nothing usable."
}
```

Matching is case-insensitive suffix-on-hostname-labels (`domainMatchesAny`/`hostMatchesDomain` in
`domain-block.ts`): `"example.com"` blocks `example.com`, `www.example.com`, and `blog.example.com`,
but never `notexample.com` (no label boundary) or `example.com.evil.net` (the blocked domain isn't a
suffix of that host's own labels, just a substring). Applied inside `buildCandidatePool`, **before**
ranking — a blocked candidate never reaches the LLM, so it costs nothing. An empty `blockedDomains`
array disables the layer entirely. Manual/extension/Telegram adds are **never** blocked (owner
intent always overrides) — `POST /api/admin/articles` still saves the article, but the `202`
response body carries `{warning: "blocked_domain"}` so you know it's likely to fail extraction
anyway.

**Precedence (blocks are absolute, the whitelist is advisory) — `resolveDomainPrecedence` in
`domain-block.ts`, a pure function, unit-tested against the full matrix:**

1. `blocklist.json` match → **blocked** (`layer: "config"`)
2. KV auto-learned block (see below) → **blocked** (`layer: "auto"`)
3. otherwise → allowed

`preferredDomains` is checked independently and **never overrides a block** — a domain that's both
preferred and blocked stays blocked, reported with `conflict: true` so you can see it and decide
deliberately (surfaced in `GET /api/admin/health-report`'s `curation.blocked.conflicts` and in
`GET /api/admin/curation/blocked`, below) rather than the whitelist silently winning. Its only real
effect is in general fill: a bounded tie-break that lets a preferred candidate move up **at most one
position** past an immediately-preceding non-preferred candidate — a genuine tie-break, not a
re-sort, so it can never jump a large rank gap.

**Ranking returns a labeled, over-length list — selection happens in code, never trusted to the
model.** The one ranking LLM call now asks for up to `min(2 × AGENT_DAILY_PICKS, 24)` items, best
first, each shaped `{"i": "<candidate id>", "topic": "<one of topicVocabulary>"}` — more than will
actually be picked, so the selection step below has real alternatives to draw from without a second
LLM call. Parsed defensively as before (fence-strip, shape validation, invalid/duplicate ids
dropped, an unrecognized topic label falls back to `"other"`); a parse failure keeps the existing
fallback (newest, one per distinct source) and **skips quotas/priority sources entirely** for that
run — with no labeled data to work from, guessing topics would be worse than just falling back.

From that labeled list, `selectPicks` in `ranking.ts` picks exactly `AGENT_DAILY_PICKS`, **in this
order** (documented in the function itself, matching the spec this feature shipped against):

1. **Priority sources** — each configured id's highest-ranked candidate, if the model ranked one at
   all.
2. **Topic quotas** — best-first from candidates labeled that topic, skipping anything already
   selected.
3. **General fill** — whatever's left of the ranked list, in order, with the bounded
   preferred-domain tie-break above.

The existing hard constraints apply **throughout**, not as a separate pass afterward: the max-2-per-
source cap and the 48h story-dedup window (same `titleSimilarity` check as the post-pick dedup
described above) are enforced inline at every step via one shared "try to add this candidate" check
— a quota or priority pick that would bust the cap or duplicate an already-selected story is skipped
in favor of the next matching candidate, exactly like the pre-existing `enforceRankingDiversity`/
`dedupStories` backfill behavior. Every run logs the full composition —
`rank_selection {picks, byTopic, bySource, quotaFilled, priorityFilled}` — plus
`rank_priority_unfilled {sourceId}` / `rank_quota_unfilled {topic, wanted, got}` whenever either
degrades silently rather than forcing a bad pick.

**Auto-learned blocks — KV only, structurally separate from the manual/git-committed policy above
(`autoblock.ts`).** Automation writes _only_ `autostat:<domain>`/`autoblock:<domain>` KV keys;
manual policy lives _only_ in the two JSON files above — disjoint key spaces and disjoint storage,
so neither can ever overwrite the other by construction (enforced as a standing regression test, see
`curation_isolation_test.ts`).

- Each pipeline failure classified by the existing `classifyFailure` (see "Self-healing failures"
  below) scores its host: `insufficient_text` or `paywalled` (403/402) → **+1**; **transient**
  (5xx/timeouts) → **+0**, deliberately — an outage is evidence the upstream had a bad moment, not
  that the domain itself is unusable, and scoring it would eventually auto-block any
  flaky-but-otherwise-fine source given enough traffic.
- Score reaching **`AUTOBLOCK_THRESHOLD`** ([vars], default `3`) writes/refreshes
  `autoblock:<domain>` = `{firstSeen, score, lastReason}`, TTL **`AUTOBLOCK_TTL_DAYS`** ([vars],
  default `60`, refreshed on every new signal) — expiry is automatic rehabilitation, no manual
  cleanup needed for a domain that's since improved.
- **Supersedes** the older `thinhost:` learning mechanism (see the note in "Sources" above) — writes
  moved entirely to this new mechanism; the old counter's read side stays active (dual-read) so
  already-learned hosts keep being respected until their own TTL naturally expires, rather than a
  sudden mass "rehabilitation" the day this shipped.
- **Admin endpoints** (Access-protected, minimal — manual policy is a file edit now, no endpoint
  needed for it):
  - `GET /api/admin/curation/blocked` →
    `{config: [...], auto: [{domain, score, reason, firstSeen,
    expiresAt}], conflicts: [{domain, layer}]}`
    — same shape as `health-report`'s `curation.blocked`.
  - `DELETE /api/admin/curation/autoblock` `{domain}` → clears one false-positive immediately, no
    deploy needed; normalizes free-form input (lowercase, strips scheme/path/`www.`, rejects an
    invalid hostname with `400`). Clears **both** the `autoblock:` entry and its underlying
    `autostat:` counter — clearing only the block would let a single new signal instantly re-trigger
    it, defeating the point of manual relief.

`GET /api/admin/health-report`'s `curation` section folds all of this together: the same
`config`/`auto`/`conflicts` blocklist snapshot, plus per-source
`{picks, successes, failures,
autoblockScore}` (derived from agent-added rows' status and each
source's own domain) — one call for the whole curation picture, no separate lookups needed. Curation
is taste, not a signal: nothing in this feature ever auto-modifies `curation.json`/`blocklist.json`
— only the owner, editing the files in their fork, changes manual policy.

### Self-healing failures

Every 'failed' article is classified into one of four healing strategies the moment it fails (see
`classify-failure.ts`, shared between the API and SPA) — the classification is a small, explicit
vocabulary over this codebase's own error strings, not a generic parser:

- **transient** (llm timeouts, gateway/Anthropic 5xx, rate limits, dead-lettered queue messages,
  daily budget exhaustion) — worth retrying; the daily-budget case in particular always resolves
  itself the next day.
- **permanent** (insufficient extracted text, a 404/410 source, an SSRF-blocked url) — retrying
  can't help; the article is surfaced honestly with no Retry button (see the SPA's `ArticleCard`)
  instead of pretending a retry might work.
- **content** (a `validateSummary()` miss — see "Bullet repair" below) — the retry is _informed_:
  the exact violation is fed back into the next attempt's prompt (`pipeline.ts`'s
  `priorViolations`), so it gets a higher cap than `unknown` below.
- **unknown** (anything else) — might pass on retry, might not; gets one lower-confidence attempt
  rather than the full transient/content budget.

An hourly job (part of the existing cron tick, no separate schedule to configure — see `healing.ts`)
retries transient/content/unknown failures automatically (capped at 2/3/1 attempts respectively and
never more than 5 retries in a single tick), and classifies any older 'failed' rows that predate
this feature. A **permanent** failure on an agent-picked article auto-archives itself (the system
chose it, so burying its own mistake is safe); the same failure on an article you added yourself is
never auto-archived — it stays in your feed, clearly marked, for you to delete or leave as-is.

**Task 34 change:** a **content** failure that exhausts its heal cap (3 informed retries) and is
still failed now auto-archives too, but **only for agent-picked articles** — after three attempts,
each told exactly what was wrong, the model still isn't producing a valid summary, which is unlikely
to self-resolve without a prompt/threshold change; hiding the agent's own dead end is the same
judgment call as the pre-existing permanent+agent-picked rule above. This **supersedes** the earlier
"never auto-archive on `content`" rule, but only for `added_via: 'agent'` — an owner-added article
that exhausts the same cap is still never auto-archived; it stays visible as failed, for you to
delete or leave as-is, same as any other owner-added failure. Logged as `content_failure_archived`.

Archived articles are never touched by healing, and healing never bypasses the daily summarization
budget — a retried article goes through the exact same queue path (and the same budget check) as any
other pipeline run.

### Bullet repair (never fail a summary over a formatting nit)

History: earlier tasks tried to fix a recurring nit — a bullet that just restates the tldr instead
of adding a new fact — at the prompt level (a contrast rule + a BAD/GOOD example, then an informed
retry naming the exact bullet). It still recurs in production. Prompt-level enforcement of a
formatting nit isn't achievable with a probabilistic model, and failing an otherwise-correct summary
over it is disproportionate to the actual problem.

`validateSummary()` (`summarize.ts`) now repairs this deterministically, **before** validation ever
sees the bullets, with no extra LLM call: `repairDuplicateBullets` detects any bullet whose overlap
with the tldr crosses the existing heuristic threshold (`TLDR_OVERLAP_THRESHOLD = 0.8` — ≥80% of a
bullet's own non-trivial words literally present in the tldr text; unchanged from the pre-existing
duplicate-detection heuristic, just applied earlier in the pipeline) and drops it, keeping the
first-occurrence order of what's left. If the repaired count still meets the profile's `minBullets`,
the summary **passes** with the trimmed bullet list — logged as
`summary_repaired {field,
droppedIndexes, remaining}` — and that trimmed list is what actually gets
persisted/rendered. If dropping would leave fewer bullets than the minimum, repair gives up and
leaves the original bullets untouched; `validateBullets`'s existing duplicate-tldr check then
reports the violation exactly as before this task, still feeding the informed-retry path (which
still names the specific bullet and asks for a replacement fact). `bullets_ru` and `bullets_en` are
repaired **independently** — their counts may legitimately differ afterward (nothing downstream
indexes one language's bullets against the other's; `renderSummaryMarkdown` and the SPA's
`summaryFields.ts` are both already scoped to a single language at a time).

**`DAILY_SUMMARY_LIMIT`** ([vars] in `wrangler.toml`, default `80`) caps how many pipeline runs
consume a summarization slot per UTC day (see `cost-guard.ts`) — a best-effort KV counter, not a
hard guarantee under heavy concurrent load, but adequate for a personal, low-concurrency app. Note
what actually counts against it: **one slot per pipeline run** (a fresh article, a `retry`, or a
`resummarize`), not per raw LLM API call — `summarizeArticle`/`summarizeArticleWithWorkersAi` may
make up to 2 real provider calls internally (the corrective-retry-on-validation-failure path) inside
that single slot. The ranking call the agent makes once per run is separate again and never touches
this budget at all (see "Daily scraping agent" below). A live incident during development showed
exactly how confusing hitting this looks without instrumentation: three consecutive retries of one
article each completed in ~1 second with pipeline stages `fetch` → `extract` → done, no `summarize`
stage at all — a silent daily-limit rejection is indistinguishable from a hung or broken pipeline
unless you already suspect the budget. Two things now make this visible: the budget stage logs a
`pipeline_stage {stage: "budget", outcome: "exhausted", used, limit}` line the moment the guard
trips (instead of nothing), and `GET /api/admin/health-report`'s `llm_calls: {used, limit}` field
shows today's running total on demand. A `daily-limit` failed card gets dedicated copy in the SPA
("daily summary limit reached — this will process automatically tomorrow") with **no Retry button**
— retrying today can't succeed, and healing already re-tries it automatically once the UTC-midnight
reset frees up budget. If heavy manual testing (adding many articles back-to-back) keeps exhausting
the default 80/day, raise `DAILY_SUMMARY_LIMIT` in `wrangler.toml` — there's no other consequence to
a higher number besides LLM provider cost.

**Why 80, not the old 50 (broader sources + `AGENT_DAILY_PICKS` doubled the agent's own share):**
raising `AGENT_DAILY_PICKS` 5 → 10 doubles the agent's daily consumption from 5 slots to 10. Left at
the old 50/day limit, that alone would shrink the headroom available for everything else (owner
retries/resummarizes, healing catch-up) from `50 - 5 = 45` slots down to `50 - 10 = 40` — and a
heavy manual-testing day (the exact scenario that originally exhausted the old 50/day default)
routinely needs more than that on its own. Raising the limit to 80 keeps that headroom generous
instead — `80 - 10 = 70` slots/day for everything else, more than the old 45, not less. Healing's
own contribution is self-limiting regardless of the default (see above: capped at 2/1 attempts per
article and 5 retries per hourly tick, so it only spends slots proportional to an actual failure
backlog, not a fixed daily tax).

**Cost at 80/day:** in gateway/direct mode (a real Claude model, e.g. the default
`claude-haiku-4-5-20251001`), even the theoretical worst case — every one of the 80 slots needing
both the first attempt and a corrective retry, 160 raw API calls total — is well under a dollar a
day at Haiku's per-token pricing, since each call's input is one article's extracted text
(thousands, not millions, of tokens); realistically most calls pass validation first-try, so actual
daily cost is usually a small fraction of that ceiling. In Workers AI mode (the free-tier default,
no cost), the relevant ceiling instead is the platform's neuron allowance (10k neurons/day free
tier, mentioned above) — 80 slots/day at up to 2 Llama calls each is a meaningfully larger neuron
draw than the old 5-pick default, so if you're running purely on the free tier at high daily volume,
check Cloudflare's AI dashboard for neuron usage and consider AI Gateway/direct Claude (both cheap
at this volume, per above) if you're consistently near the cap.

`GET /api/admin/health-report` (owner-only) returns a JSON snapshot of all this — failure counts by
class, total heal attempts by class, the current learned thin-host list, today's `llm_calls`
used/limit, a cheap proxy for "when did the agent last do anything", and (see "Curated variety"
above) a `curation` section with the blocklist/auto-block/conflict snapshot and per-source stats —
meant for curl/owner tooling, not a dedicated SPA page (yet).

### Interests (`INTEREST_TOPICS`)

One `[vars]` string — free text describing what you want surfaced, sent straight into the ranking
prompt:

```
INTEREST_TOPICS = "AI/LLMs and their engineering; computer hardware — CPUs, GPUs, NVIDIA/Intel/AMD, chips; Linux — kernel, distributions, open source ecosystem; software development and programming languages; Cloudflare and edge computing; security — vulnerabilities, breaches, exploits, threat research; notable science/tech news"
```

Edit it in `wrangler.toml` (or override locally via `.dev.vars`) to match your own taste — there's
no required format, just describe what you'd want picked.

### Schedule and manual trigger

Runs on `AGENT_HOUR_UTC` (default `5`) via the same hourly cron the Telegram drip publish job uses —
see "Drip publishing (cron)" above for the publish job's own (always-on-every-tick) schedule and how
to disable the agent. Two ways to run the agent on demand instead of waiting for the clock:

- `POST /api/admin/agent/run` — Access-protected, returns `202` immediately and runs the job in the
  background.
- The Telegram `/scrape` command, if the bot is configured — replies "Запустил агента" immediately,
  same background job.

Re-running the same day is safe: candidates already saved (matched by URL) are excluded from the
pool, so nothing gets duplicated.

`GET /api/config` (public) also exposes `agent_hour_utc` (the parsed `AGENT_HOUR_UTC`, or `null` if
the agent is effectively disabled) and `agent_daily_picks` — this is what powers the SPA's empty
"Today" state: when today's section has zero articles yet, it shows a live countdown to the next
agent run (computed client-side from the visitor's own local clock) instead of just disappearing,
and falls back to a neutral "auto-picks are off" message when the hour is `null`.

**Pending-article UX (agent batch vs. an owner's own add):** a batch of freshly-scraped agent picks
used to appear as ten individual half-finished cards, each showing the raw English source title and
a spinner until summarization flipped it to the real (Russian/English) title — visually noisy, and a
jarring title flip once each one finished. Now the two capture paths render differently while
`status === 'pending'`:

- **Agent-added** (`added_via: 'agent'`): not rendered as an individual card at all. Instead, one
  aggregate indicator appears at the top of whichever section the batch's articles fall into
  (normally "Today"): "Preparing N fresh summaries… M of N ready", ticking down as each one
  finishes. It disappears once every agent article in that section has left `'pending'` (whether by
  finishing or failing) — see `lib/agentBatch.ts`'s `computeAgentBatchIndicator`. A failed
  agent-pending article is excluded from the indicator's count entirely (it was never "coming") and
  still renders as a normal failed card, same as any other failure. If the batch has started but
  nothing is ready yet, this indicator takes precedence over the empty-Today countdown above — see
  `shouldShowEmptyCountdown` for the exact rule.
- **Owner-added** (`manual` / `extension` / `telegram`): renders as a skeleton card — pulsing
  placeholder blocks, never the raw source title (so there's no title flip once it's ready) — with a
  "Processing…" caption, or the existing "taking a while / Check now" note if polling gives up.

Both the skeleton and the indicator share one shimmer CSS component, fully disabled under
`prefers-reduced-motion` (a static placeholder instead — see `lib/motion.ts` and the
`prefers-reduced-motion` blocks in `styles.css`). A card that finishes while visible (agent or
owner) gets a brief slide+fade-in on top of the existing "just became ready" highlight, also skipped
under reduced motion.

## Semantic dedup & search

One piece of infrastructure — a Cloudflare Vectorize index — backs two separate features: catching
paraphrased duplicate stories the string-only dedup layers above miss, and "ask your feed" semantic
search over everything you've saved.

**Model choice.** `@cf/baai/bge-m3` via Workers AI (free tier) — 1024 output dimensions, cosine
metric, and multilingual (100+ languages, explicitly including Russian and English). It's the model
this task's spec named directly, and it turned out to be available, so no fallback model was needed.
One embedding per article, built from **English only** —
`title_en + "\n" + tldr_en + "\n" + bullets_en` (see `buildEmbeddingText` in `embeddings.ts`) — for
the same reason `faithfulness.ts`'s claim check is EN-only: RU/EN are independently-written parallel
translations of the same facts (see the summarization prompt), so embedding one language captures
equivalent meaning at half the Workers AI calls, and — more importantly here — keeps every article
in one shared vector space regardless of `lang_original`, instead of a RU write-up and an EN
write-up of the identical story landing in different regions of the space purely from language
rather than content. Truncated to a conservative 1800 characters before embedding: Cloudflare's own
docs disagree with each other on bge-m3's practical input limit (one table says ~512 tokens, the
model's own page says a 60,000-token context window), and there's no tokenizer available at the edge
to count exactly, so this errs toward truncating a little early rather than risking the API's own
behavior on an oversized request.

**Live-measured threshold.** The task that added this asked for a live sanity check against a real
same-story pair already in production: two independently-written articles about the Kimi K3/Qwen 3.8
model launches — the same pair that motivated the post-pick story-dedup in "Daily scraping agent"
above — one framed as "this threatens Anthropic's business model," the other as "this is a US vs.
China AI story," sharing almost no vocabulary. Embedding both (via `env.AI` directly, bypassing
Vectorize — see the note on local dev below) and computing cosine similarity gave **0.835**. The
task's own starting default (`0.86`) would have missed this exact pair entirely — its own launch
announcement. `SEMANTIC_DEDUP_THRESHOLD` now defaults to **`0.82`**, a small margin below the
measured score so this specific pair is actually caught, while staying well above where genuinely
unrelated stories are expected to sit. This is one real calibration point, not a statistically
validated threshold — see the honest caveat at the end of this section.

**Embedding stage.** After a summary is stored (`status = 'ready'`), the pipeline computes and
upserts one embedding per article, tagged with metadata
`{added_at, source, added_via,
lang_original}` (see `runEmbedStage` in `pipeline.ts`). A
`embedded_at` marker column (migration `0005`) makes this idempotent and drives the backfill below.
Embed failures **never** fail the article — they're logged and left for a later backfill, same as
this task's spec required. Deleting an article also deletes its vector
(`DELETE /api/admin/articles/:id`) — no orphans.

**Semantic dedup layer (`agent-pool.ts`).** Runs **last**, after the three cheap string layers in
"Daily scraping agent" above, and only on the candidates that survived them — embedding every
candidate costs a Workers AI call, so this is capped at `SEMANTIC_DEDUP_MAX_CANDIDATES` (default
`40`) per agent run, newest-first. For each: query Vectorize (`topK=3`, filtered to `added_at`
within the last 72 hours) for a same-story match against already-saved articles, **and** compare
pairwise against every other candidate's freshly-computed embedding still in this same batch
(catches two picks about the same story in one run, before either is even saved). Either match
`>=
SEMANTIC_DEDUP_THRESHOLD` drops the candidate, logging
`pool_dedup_dropped {reason: 'semantic',
score, matchedId?}`. An embed or Vectorize-query failure
for one candidate fails **open** (the candidate is kept, not dropped) — a transient infrastructure
hiccup is not evidence of duplication.

**Search — `GET /api/search?q=...&limit=20`** (public, same as the rest of the feed) embeds the
query, queries Vectorize, and hydrates matching rows from D1 in score order. `GET
/api/admin/search`
is the owner-mode equivalent (real `error` field included, same as `/api/admin/articles` vs.
`/api/articles`). Both fall back to the pre-existing title/summary `LIKE` search — same rows,
`score: 0` — whenever Vectorize isn't configured or a call to it fails; a caller never sees a 500
just because semantic search couldn't run. The public endpoint is rate-limited
(`SEARCH_RATE_PER_MIN`, default `30`, a KV counter shared across all callers) since each query costs
a Workers AI call — over the limit returns `429 {error: "rate_limited"}` with the SPA showing
localized copy for it. In the SPA, once the search box has a query, a small toggle appears — **по
словам** (keyword, the default, today's `LIKE` behavior) / **по смыслу** (semantic) — and the choice
persists in `localStorage`. Deliberately no visible relevance score anywhere; ordering alone carries
the ranking. An empty result set shows the existing empty-feed layout with a hint to try the other
mode.

**Keyword search semantics (`GET /api/articles?q=...` / `GET /api/admin/articles?q=...`) —
AND-of-terms.** The query is whitespace-tokenized into individual terms (repeated/leading/trailing
whitespace collapses to nothing); every term must appear **somewhere** across `title`, `summary_ru`,
and `summary_en` combined (not necessarily the same field, not necessarily as a contiguous phrase)
for an article to match — a query matching only one of several terms excludes that row. Capped at 6
terms; extra terms beyond that are dropped rather than erroring. Each term is truncated to a safe
UTF-8 byte length before being turned into a `LIKE` pattern, and a literal `%`/`_` in a term is
escaped (`ESCAPE '\'`) so it matches literally instead of acting as a SQL wildcard. This fixes a
live incident: a multi-word query longer than ~48 bytes previously 500'd with
`D1_ERROR: LIKE or GLOB
pattern too complex` — D1/SQLite's default `LIKE` pattern-length limit is
**50 bytes, not characters** (confirmed empirically; a 50-character Cyrillic term is ~100 bytes and
would still overflow a naive character-based cap), so tokenizing into short per-term patterns keeps
every generated pattern comfortably under that limit regardless of how long the overall query is.

**Backfill — `POST /api/admin/embeddings/backfill`** (Access-protected): embeds every `'ready'`,
non-archived article with `embedded_at IS NULL`, 20 per call, returns `{processed, remaining}`. Same
synchronous-paginated pattern as this repo's other one-shot admin jobs (e.g. tag normalization) —
the caller repeats the call until `remaining` is `0`. Idempotent; safe to run anytime, including
repeatedly. **Existing rows saved before this feature shipped have no embedding until this is run at
least once** — the owner needs to call this after deploying, the same way the tag-normalize backfill
needed a manual run after its own fix shipped.

**Graceful degradation.** Everything above degrades to "acts like Vectorize doesn't exist" rather
than crashing: a fork that hasn't run `deno task setup` yet has no `VECTORS` binding at all
(`undefined`), and dedup/search both fall back to their string-only/`LIKE` equivalents
automatically. Less obviously: **`wrangler dev` has no local Vectorize emulation whatsoever** —
`env.VECTORS` there is a _present but non-functional_ proxy that throws `"needs to be run remotely"`
on every single method call, a materially different failure mode from a genuinely missing binding,
and one this task had to specifically account for (`embeddings.ts`'s
`upsertArticleEmbedding`/`deleteArticleEmbedding` swallow this; `queryRelatedEmbeddings`
deliberately does not, so its callers — `search.ts`, `agent-pool.ts` — can fall back properly
instead of silently returning zero results). `env.AI`, by contrast, always works locally too
(Workers AI bindings proxy to the real remote API even in local dev) — which is how the live
threshold measurement above was taken without ever touching Vectorize.

**Honest limitation.** This is best-effort, same as every other dedup/matching layer in this repo: a
cosine-similarity threshold necessarily trades false positives (two distinct stories dropped as
"duplicates") against misses (a real duplicate scoring just under the bar). The 0.82 default is
calibrated against exactly one real pair — there was no negative example (a genuinely unrelated
article pair) measured alongside it, so there's no confirmed floor below which false positives start
appearing. If your own feed's dedup behavior looks off in either direction,
`SEMANTIC_DEDUP_THRESHOLD` is a `[vars]` override, no code change needed.

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
