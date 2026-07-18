// Minimal ambient types for the Cloudflare Workers bindings declared in
// wrangler.toml. Deno's own lib already covers standard fetch/Request/Response,
// so we only stub the Workers-specific runtime APIs we actually call — extend
// as later tasks start reading/writing through DB and CACHE.
declare global {
  interface Fetcher {
    fetch(request: Request): Promise<Response>;
  }

  interface D1Database {
    prepare(query: string): unknown;
  }

  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  }

  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    ASSETS: Fetcher;
    SUMMARY_MODEL: string;
    DAILY_SUMMARY_LIMIT: number;
  }
}

export {};
