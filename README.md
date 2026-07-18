# ClipFeed

A personal article-digest web app. Save articles (via a Chrome extension, Telegram, or an automated
agent); the backend extracts text and generates Russian + English AI summaries via the Anthropic
API; a minimalist SPA shows them as a Medium-like single-column feed.

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
deno task build   # esbuild-bundle the API and copy web assets into dist/
deno task deploy  # build, then wrangler deploy
deno task test    # run the test suite
deno task fmt     # format
deno task lint    # lint
```

## Project layout

```
packages/api/src/index.ts     Hono app (JSON API + static asset fallback)
packages/web/                 Placeholder SPA static assets
packages/shared/src/types.ts  Types shared between API and (future) SPA
migrations/                   D1 schema migrations
```

## Database

Apply migrations locally with:

```
deno run -A npm:wrangler d1 migrations apply DB --local
```

`wrangler.toml` currently has a placeholder `database_id` and KV `id`. A `deno task setup` script
(arriving in a later task) will create these resources in your own Cloudflare account and fill them
in — see "Deploy your own (fork)" below.

## Deploy your own (fork)

ClipFeed is designed to be forked and run under your own Cloudflare account — nothing in this repo
is tied to a specific account, domain, or Access team. Full setup automation is still in progress;
the intended steps are:

1. Fork the repo.
2. Run `deno task setup` (coming in a later task) to create your D1 database and KV namespace and
   fill in `wrangler.toml`.
3. Set the `ANTHROPIC_API_KEY` secret: `deno run -A npm:wrangler secret put ANTHROPIC_API_KEY`.
4. `deno task deploy`.
5. Configure Cloudflare Access on your Worker (later task) to restrict who can reach it.

See `.dev.vars.example` for local-dev secrets and variable overrides, and [CLAUDE.md](CLAUDE.md) for
the forkability policy new changes must follow.
