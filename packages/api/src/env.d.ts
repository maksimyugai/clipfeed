// Minimal ambient types for the Cloudflare Workers bindings declared in
// wrangler.toml. Deno's own lib already covers standard fetch/Request/Response,
// so we only stub the Workers-specific runtime APIs we actually call — extend
// as later tasks start reading/writing through DB and CACHE.
import type { QueueMessage } from "@clipfeed/shared/types";

declare global {
  interface Fetcher {
    fetch(request: Request): Promise<Response>;
  }

  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
    first<T = unknown>(column?: string): Promise<T | null>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }

  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    // Used by GET /api/admin/health-report to enumerate learned thin hosts
    // (see thin-host-learning.ts's listLearnedThinHosts) and Task 33's
    // autoblock.ts listAutoBlocks — simplified to the fields we actually
    // read from Cloudflare's real KV list API. `expiration` (unix seconds)
    // is only present when the key was stored with an expirationTtl, which
    // every key this app writes always is — used to derive an autoblock
    // entry's expiresAt without a separate metadata call.
    list(
      options?: { prefix?: string; cursor?: string },
    ): Promise<
      { keys: { name: string; expiration?: number }[]; list_complete: boolean; cursor?: string }
    >;
  }

  interface Ai {
    run(model: string, input: unknown): Promise<unknown>;
  }

  // Minimal ambient Vectorize types — same "extend as we actually use it"
  // convention as the rest of this file (no @cloudflare/workers-types
  // dependency). Metadata values are the JSON-primitive subset Vectorize
  // accepts; string arrays aren't needed here.
  interface VectorizeVector {
    id: string;
    values: number[];
    metadata?: Record<string, string | number | boolean>;
  }

  interface VectorizeMatch {
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }

  interface VectorizeMatches {
    matches: VectorizeMatch[];
    count: number;
  }

  // Filter values use Vectorize's operator-object syntax (e.g.
  // `{ added_at: { $gte: "2026-01-01T00:00:00.000Z" } }`) — string
  // comparison works for our zero-padded ISO 8601 timestamps. Filtering on
  // a property requires a metadata index for it (see scripts/setup.ts's
  // ensureVectorizeMetadataIndex), created once at setup time.
  interface VectorizeQueryOptions {
    topK?: number;
    returnMetadata?: boolean | "none" | "indexed" | "all";
    filter?: Record<string, unknown>;
  }

  interface VectorizeIndex {
    upsert(vectors: VectorizeVector[]): Promise<{ count: number; ids: string[] }>;
    query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
    deleteByIds(ids: string[]): Promise<{ count: number; ids: string[] }>;
  }

  // Producer side of a Cloudflare Queue binding (see wrangler.toml
  // [[queues.producers]]).
  interface Queue<Body = unknown> {
    send(body: Body): Promise<void>;
  }

  // Minimal ambient R2 types (Task 35 Part C, see images.ts) — same
  // "extend as we actually use it" convention as the rest of this file: we
  // only ever put() (with a content-type) and get() by key, never list/
  // multipart/conditional operations.
  interface R2HttpMetadata {
    contentType?: string;
  }

  interface R2Object {
    key: string;
    httpMetadata?: R2HttpMetadata;
  }

  interface R2ObjectBody extends R2Object {
    body: ReadableStream;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
      options?: { httpMetadata?: R2HttpMetadata },
    ): Promise<R2Object>;
    delete(key: string): Promise<void>;
  }

  // Consumer-side message shape (see index.ts's `queue` export).
  interface Message<Body = unknown> {
    readonly id: string;
    readonly timestamp: Date;
    readonly body: Body;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }

  interface MessageBatch<Body = unknown> {
    readonly queue: string;
    readonly messages: readonly Message<Body>[];
    ackAll(): void;
    retryAll(options?: { delaySeconds?: number }): void;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  interface ScheduledController {
    cron: string;
    scheduledTime: number;
  }

  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ASSETS: Fetcher;
    AI: Ai;
    SUMMARY_MODEL: string;
    WORKERS_AI_MODEL: string;
    DAILY_SUMMARY_LIMIT: number;
    // Stale-pending sweeper (see sweepStalePending in db.ts): a 'pending' row
    // whose processing_started_at is older than this many minutes is lazily
    // flipped to 'failed' ('timeout: processing did not complete') on the
    // next GET /api/articles. Backstop for a Workers CPU-time kill
    // mid-pipeline, OR a genuinely stuck LLM call. Task 41 Part C: measured
    // from processing_started_at (when a consumer actually picked the
    // message up), not added_at — see QUEUE_WAIT_TIMEOUT_MIN below for the
    // "still waiting in the queue" case this used to conflate with.
    PENDING_TIMEOUT_MIN: number;
    // Task 41 Part C: a 'pending' row that has NEVER reached a consumer
    // (processing_started_at still null) but was added more than this many
    // minutes ago is flipped to 'failed' ('queue: never picked up') instead
    // — a distinct, longer budget than PENDING_TIMEOUT_MIN because a message
    // can legitimately wait behind others under queue backpressure
    // (max_concurrency = 3 in wrangler.toml) without anything actually being
    // stuck.
    QUEUE_WAIT_TIMEOUT_MIN: number;
    // LLM credentials/routing: pick one mode, in priority order —
    // AI Gateway (AI_GATEWAY_URL [+ CF_AIG_TOKEN]) > direct (ANTHROPIC_API_KEY)
    // > Workers AI (no config needed, the AI binding above, free-tier
    // default). The two secrets/key are secrets (`wrangler secret put`),
    // never [vars].
    ANTHROPIC_API_KEY?: string;
    AI_GATEWAY_URL?: string;
    CF_AIG_TOKEN?: string;
    // Owner-tunable summary length: total body characters (all paragraphs,
    // per language) to aim for. [vars] string (like AGENT_HOUR_UTC below),
    // parsed defensively by summarize.ts's parseSummaryBodyTargetChars — a
    // missing/non-numeric/out-of-[400,4000]-range value falls back to the
    // 1200 default. Both the prompt and validateSummary() derive every
    // other numeric bound from this single setting (see
    // summarize.ts's deriveSummarySpec), so there's no separate "prompt
    // number" and "validator number" to keep in sync.
    SUMMARY_BODY_TARGET_CHARS: string;
    // Cloudflare Access protection: optional, var or secret. Auth middleware
    // activates only when BOTH are set (trimmed non-empty) — otherwise the
    // Worker serves openly (fork/dev bootstrap mode).
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
    // Cloudflare Turnstile bot protection for mutating endpoints: optional,
    // active only when BOTH are set (trimmed non-empty). Site key is public
    // by nature ([vars] default ""); secret key must be a real secret.
    // Requests carrying a verified Access identity (see accessSub above)
    // bypass Turnstile entirely.
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    // Telegram bot (capture + morning digest): optional, active only when
    // all three are set (trimmed non-empty). The webhook is a public path
    // (Telegram can't present an Access identity) — its own auth is the
    // TELEGRAM_WEBHOOK_SECRET header instead. The bot serves exactly one
    // chat: TELEGRAM_OWNER_CHAT_ID.
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    TELEGRAM_OWNER_CHAT_ID?: string;
    // Drip publishing (see telegram-publish.ts, README "Telegram bot"):
    // replaces the old wall-of-text morning digest with one standalone
    // post per hour. TELEGRAM_CHANNEL_ID (default "") — when set, posts go
    // there instead of the owner's own chat (bot must be a channel admin);
    // empty means posts land in TELEGRAM_OWNER_CHAT_ID, so the feature
    // works before the owner creates a channel. PUBLISH_START_HOUR_UTC/
    // PUBLISH_END_HOUR_UTC (defaults 4/18) bound the daily publish window;
    // [vars] strings, parsed defensively (fall back to the default, unlike
    // AGENT_HOUR_UTC/DIGEST_HOUR_UTC's empty-disables-the-job convention —
    // PUBLISH_ENABLED is the actual on/off switch here). PUBLISH_ENABLED
    // defaults to "true"; only the literal "false" turns the drip off.
    // Task 37: the drip now selects only today's (current UTC day's)
    // articles — see telegram-publish.ts's utcDayStartIso — and
    // PUBLISH_MAX_PER_DAY (default 10, [vars] string) caps how many of those
    // are actually sent per UTC day, as a flood guard against the scraping
    // agent producing more than one batch in a day (see Task 36).
    TELEGRAM_CHANNEL_ID?: string;
    PUBLISH_START_HOUR_UTC?: string;
    PUBLISH_END_HOUR_UTC?: string;
    PUBLISH_ENABLED?: string;
    PUBLISH_MAX_PER_DAY?: string;
    // Public origin of the deployed instance (e.g. "https://example.com"),
    // used only to build links in Telegram messages (the drip post's card
    // link, the "saved" reply). [vars], default "" — when empty those
    // links are simply omitted, never a broken/placeholder URL.
    PUBLIC_BASE_URL: string;
    // Repo URL shown as a GitHub icon link in the header and the footer's
    // license link (see GET /api/config, Header.tsx, Footer.tsx). [vars],
    // default "" — a fork sets its own; the icon and license link are simply
    // hidden until it's a non-empty https URL (see repoConfig.ts). Optional
    // here (unlike PUBLIC_BASE_URL) so the many existing test files' Env
    // literals don't all need updating just to add an unused field.
    REPO_URL?: string;
    // Daily scraping agent (see agent.ts, README "Daily scraping agent").
    // INTEREST_TOPICS steers the ranking call's taste — owner-editable
    // free text, no particular format required.
    INTEREST_TOPICS: string;
    // Hour-dispatch scheduling for the scraping agent cron (see
    // scheduled.ts): [vars] string (not a number) so a forker can disable
    // the job by clearing it to "" — an empty or non-numeric/out-of-range
    // value means it never fires. UTC hour (0-23).
    AGENT_HOUR_UTC: string;
    // Retired (Task 29): the old fixed-time morning digest cron is
    // superseded by the drip publish window above (PUBLISH_START_HOUR_UTC/
    // PUBLISH_END_HOUR_UTC) — one post per hour instead of a once-daily
    // wall of text. No longer read anywhere; kept optional (rather than
    // deleted outright) so an existing fork's wrangler.toml, or a test's
    // env override, that still sets it doesn't need to change. The manual
    // /digest command is unaffected — it still builds the same digest on
    // demand, this var only ever controlled the automatic cron dispatch.
    DIGEST_HOUR_UTC?: string;
    // How many candidates the agent saves per run — [vars] string, parsed
    // defensively by ranking.ts's parseAgentDailyPicks (1-20, else the
    // default 10 with a warning). Feeds both the ranking prompt's "pick N"
    // instruction and the fallback/post-parse-fixup paths, so there's one
    // number, not a prompt literal that can drift from the code.
    AGENT_DAILY_PICKS: string;
    // Article pipeline job queue (see wrangler.toml [[queues.producers]],
    // queue.ts) — optional so a fork that hasn't run `deno task setup` yet
    // (or any environment missing the binding) degrades gracefully to the
    // pre-Queues ctx.waitUntil() behavior instead of crashing; see
    // queue.ts's enqueueArticleJob.
    JOBS?: Queue<QueueMessage>;
    // Faithfulness check (see faithfulness.ts, README "Faithfulness
    // check"): a SEPARATE judge pass (always Workers AI Llama, regardless of
    // which model wrote the summary) that verifies a summary against its
    // source after it validates but before the article is marked 'ready'.
    // All three optional, parsed defensively — [vars] always sets them in
    // this repo's own wrangler.toml, but a fork/test environment that
    // omits them entirely gets the documented default rather than a type
    // error or a runtime crash.
    //   FAITHFULNESS_CHECK: "true"/"false", default "true" — master
    //     on/off. Disabled means the judge is never called at all: no
    //     Workers AI call, no faithfulness_* columns written, pipeline
    //     behaves exactly as it did before this feature existed.
    //   FAITHFULNESS_ENFORCE: "true"/"false", default "true" — Task 42:
    //     a 'fail' verdict drives ONE remediation attempt (a no-LLM
    //     bullet-drop repair when every bad claim maps to a bullet,
    //     otherwise one informed resummarize-and-reverify); afterward, an
    //     agent-picked article still 'fail' auto-archives, an owner-added
    //     one always stays visible. Never repeats for the same article,
    //     even across a later resummarize/heal cycle (see
    //     articles.faithfulness_enforced_at). "false" reverts to the
    //     original signal-only behavior: verdict stored, article proceeds
    //     to 'ready' regardless, no remediation ever attempted.
    //   FAITHFULNESS_JUDGE_MODEL: the Workers AI model id to judge with,
    //     default "@cf/meta/llama-3.3-70b-instruct-fp8-fast" — same
    //     default as WORKERS_AI_MODEL above, but a separate setting since
    //     an owner running Claude via gateway/direct for summarization
    //     still wants a specific (and possibly different) Llama judge
    //     model.
    FAITHFULNESS_CHECK?: string;
    FAITHFULNESS_ENFORCE?: string;
    FAITHFULNESS_JUDGE_MODEL?: string;
    // Embeddings (see embeddings.ts, README "Semantic dedup & search"):
    // optional so a fork that hasn't run `deno task setup` yet (no
    // Vectorize index provisioned, no [[vectorize]] binding in
    // wrangler.toml) degrades gracefully — semantic dedup skips its layer
    // and falls back to the existing string-based layers only, and search
    // falls back to the pre-existing LIKE query. Every call site checks
    // `env.VECTORS` before touching it; never a hard dependency.
    VECTORS?: VectorizeIndex;
    // Workers AI multilingual embedding model — @cf/baai/bge-m3 (1024
    // dims, cosine metric, 100+ languages including ru/en — see README for
    // why this one). [vars] string, optional/parsed defensively (like
    // FAITHFULNESS_JUDGE_MODEL above — see embeddings.ts's
    // resolveEmbeddingModel) so a fork can swap models without a redeploy
    // of code, though doing so requires re-creating the Vectorize index at
    // the new model's dimension count (see embeddings.ts's
    // dimension-mismatch guard, which fails loudly rather than silently
    // writing vectors of the wrong shape).
    EMBEDDING_MODEL?: string;
    // Semantic dedup (agent-pool.ts): caps how many surviving candidates
    // get an embedding call per agent run (each is a Workers AI request),
    // and the cosine-similarity floor above which two candidates are
    // treated as the same story. [vars] strings, parsed defensively — see
    // agent-pool.ts's parseSemanticDedupConfig. Defaults: 40 candidates,
    // 0.82 threshold (empirically derived — see README).
    SEMANTIC_DEDUP_MAX_CANDIDATES?: string;
    SEMANTIC_DEDUP_THRESHOLD?: string;
    // Semantic search (GET /api/search, /api/admin/search) is PUBLIC and
    // costs one Workers AI embedding call per query — rate-limited by a
    // per-minute KV counter (see search.ts), [vars] string, default 30,
    // parsed defensively.
    SEARCH_RATE_PER_MIN?: string;
    // Vectorize's topK always returns the K nearest vectors regardless of
    // absolute similarity — with a narrow/off-topic query and a small
    // corpus, that means "least far" noise instead of an honest empty
    // result. SEARCH_MIN_SCORE (default 0.5, bge-m3 cosine) filters those
    // out before D1 hydration; see search.ts's searchArticles and README
    // for the live-tuned derivation. [vars] string, parsed defensively.
    SEARCH_MIN_SCORE?: string;
    // Curated variety (Task 33, README "Curated variety"): topic quotas,
    // priority sources and the manual blocklist live in committed JSON
    // files (curation.json/blocklist.json, sibling to sources.json) — no
    // env vars needed for those. These two vars tune ONLY the KV-based
    // auto-learned block mechanism (autoblock.ts), which supersedes the
    // older thin-host-learning.ts counter (see autoblock.ts's module doc).
    // [vars] strings, parsed defensively (see
    // autoblock.ts's parseAutoblockThreshold/parseAutoblockTtlDays) —
    // missing/invalid falls back to the documented default (3 signals,
    // 60 days) rather than throwing.
    AUTOBLOCK_THRESHOLD?: string;
    AUTOBLOCK_TTL_DAYS?: string;
    // Article preview images (Task 35 Part C, see images.ts, README
    // "Article images"): optional so a fork that hasn't run
    // `deno task setup` yet (no R2 bucket provisioned, no [[r2_buckets]]
    // binding in wrangler.toml) degrades gracefully — the image stage
    // simply skips (logs, no image stored), same "auxiliary, never blocks"
    // contract as VECTORS/embeddings above. IMAGES_ENABLED (default
    // "true", [vars] string, parsed defensively by
    // images.ts's parseImagesEnabled) disables the whole feature even when
    // the binding IS configured — set to "false" to opt out entirely.
    IMAGES?: R2Bucket;
    IMAGES_ENABLED?: string;
  }
}

export {};
