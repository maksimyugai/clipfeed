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

  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ASSETS: Fetcher;
    SUMMARY_MODEL: string;
    DAILY_SUMMARY_LIMIT: number;
    ANTHROPIC_API_KEY: string;
  }
}

export {};
