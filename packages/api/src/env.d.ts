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
    // (see thin-host-learning.ts's listLearnedThinHosts) — simplified to
    // the fields we actually read from Cloudflare's real KV list API.
    list(
      options?: { prefix?: string; cursor?: string },
    ): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
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
    // older than this many minutes is lazily flipped to 'failed' on the next
    // GET /api/articles. Backstop for a Workers CPU-time kill mid-pipeline.
    PENDING_TIMEOUT_MIN: number;
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
    // Public origin of the deployed instance (e.g. "https://example.com"),
    // used only to build links in Telegram messages (the morning digest
    // footer, the "saved" reply). [vars], default "" — when empty those
    // links are simply omitted, never a broken/placeholder URL.
    PUBLIC_BASE_URL: string;
    // Daily scraping agent (see agent.ts, README "Daily scraping agent").
    // INTEREST_TOPICS steers the ranking call's taste — owner-editable
    // free text, no particular format required.
    INTEREST_TOPICS: string;
    // Hour-dispatch scheduling for the agent/digest cron (see scheduled.ts):
    // [vars] strings (not numbers) so a forker can disable either job by
    // clearing it to "" — an empty or non-numeric/out-of-range value means
    // that job never fires. Both are UTC hours (0-23).
    AGENT_HOUR_UTC: string;
    DIGEST_HOUR_UTC: string;
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
    //   FAITHFULNESS_ENFORCE: "true"/"false", default "false" — false
    //     (soft/signal-only, the first-release default) stores the
    //     verdict and proceeds to 'ready' regardless; true additionally
    //     retries the summary once and discards (permanent 'failed') if
    //     the retry still fails the judge.
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
  }
}

export {};
