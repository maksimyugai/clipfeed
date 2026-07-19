// Minimal ambient types for the Cloudflare Workers bindings declared in
// wrangler.toml. Deno's own lib already covers standard fetch/Request/Response,
// so we only stub the Workers-specific runtime APIs we actually call — extend
// as later tasks start reading/writing through DB and CACHE.
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
  }

  interface Ai {
    run(model: string, input: unknown): Promise<unknown>;
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
  }
}

export {};
