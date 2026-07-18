# ClipFeed

## Forkability policy

ClipFeed must be deployable by anyone who forks the repo and plugs in their own Cloudflare account.
The Chrome extension is a single published build with a user-configurable server URL — it never
assumes a fixed backend.

1. Never hardcode owner-specific values anywhere: no Cloudflare `account_id`, no real `database_id`
   / KV `id` committed beyond documented placeholders, no personal domains, no Access team domain /
   AUD in code or config defaults.
2. All deployment-specific configuration comes from: `wrangler login` context, `[vars]` with safe
   defaults, secrets (`wrangler secret put`), or the setup flow documented in the README.
3. Every new deployment-affecting setting must be added to `.dev.vars.example` and the README
   "Deploy your own (fork)" section in the same task that introduces it.
4. The extension must never assume a fixed backend origin.
