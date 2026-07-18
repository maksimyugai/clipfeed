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

  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ASSETS: Fetcher;
    AI: Ai;
    SUMMARY_MODEL: string;
    WORKERS_AI_MODEL: string;
    DAILY_SUMMARY_LIMIT: number;
    // LLM credentials/routing: pick one mode, in priority order —
    // AI Gateway (AI_GATEWAY_URL [+ CF_AIG_TOKEN]) > direct (ANTHROPIC_API_KEY)
    // > Workers AI (no config needed, the AI binding above, free-tier
    // default). The two secrets/key are secrets (`wrangler secret put`),
    // never [vars].
    ANTHROPIC_API_KEY?: string;
    AI_GATEWAY_URL?: string;
    CF_AIG_TOKEN?: string;
  }
}

export {};
