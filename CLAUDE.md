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

## Git workflow

1. Every task starts on a fresh branch created from up-to-date remote main:
   `git fetch origin && git checkout -b <type>/<short-task-name> origin/main`.
2. Push the branch to remote and open a Pull Request when the task is done.
3. NEVER merge PRs — the owner reviews and merges.
4. NEVER force-push, rebase, or reset remote main; treat it as protected.
5. Conventional commit messages; no Co-Authored-By / noreply@anthropic.com trailers.

## Security policy

1. This is a public repo: never commit secrets, tokens, API keys, real personal data, or real
   private URLs (including in tests, fixtures, docs, commit messages). `.dev.vars` stays gitignored;
   `.dev.vars.example` documents required vars with empty values.
2. All user-supplied input is untrusted: validate types/lengths/formats at the API boundary; enforce
   request body size limits.
3. Server-side fetching must be SSRF-safe (rules in this spec).
4. Fetched/extension-supplied HTML is processed to plain text server-side and never returned raw to
   clients.
5. LLM output is untrusted: schema-validate before persisting.
6. New endpoints must state their auth expectation (Cloudflare Access JWT — enforced from Task 3
   onward).
7. gitleaks runs only against git-tracked content and git history — never scan untracked local files
   (e.g. `.dev.vars`) and never echo scanner findings' matched secret values into logs or reports.
8. Never print the contents of `.dev.vars` or any secret-bearing file into logs, command output, or
   reports — not via `cat`, `grep`, `diff`, or an editor/Read view. To verify such a file was
   modified or restored correctly, compare hashes (e.g. `sha256sum`) or line counts, or diff against
   a redacted copy — never the raw content. Diagnostic commands that touch such a file must redact
   values by name allow-list (print `KEY=<redacted>`, never `KEY=value`) before echoing anything.
