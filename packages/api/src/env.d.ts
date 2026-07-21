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
  }
}

export {};
