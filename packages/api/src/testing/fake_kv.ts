import "../env.d.ts";

// Minimal in-memory KVNamespace double — TTL is accepted but not enforced
// (nothing in this codebase's test suite needs actual expiry behavior;
// tests assert that `expirationTtl` was passed, not that it later expires).
export class FakeKv implements KVNamespace {
  store = new Map<string, string>();
  ttls = new Map<string, number>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    this.ttls.delete(key);
    return Promise.resolve();
  }

  list(
    options?: { prefix?: string; cursor?: string },
  ): Promise<
    { keys: { name: string; expiration?: number }[]; list_complete: boolean; cursor?: string }
  > {
    const prefix = options?.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => {
        const ttl = this.ttls.get(name);
        // Fake "stored at call time" expiration (unix seconds) — good
        // enough for tests that only assert an expiresAt was derived from
        // SOME ttl, not real wall-clock expiry (nothing in this fake
        // enforces actual expiry either, see the class doc comment above).
        return {
          name,
          expiration: ttl !== undefined ? Math.floor(Date.now() / 1000) + ttl : undefined,
        };
      });
    return Promise.resolve({ keys, list_complete: true });
  }
}
