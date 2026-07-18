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

`wrangler.toml` currently has a placeholder `database_id` and KV `id` — real resource provisioning
happens outside this task.
