// Task 41 Part A: GET /api/config is static per session (agent schedule,
// repo URL, Turnstile site key never change while the SPA is open) but used
// to be fetched independently by agentSchedule.ts, repoConfig.ts, and
// turnstile.ts — three separate modules, each with its own module-level
// cache, meaning three separate requests to the same URL on every page load
// even though each individually reused its own cache afterward. This single
// shared fetch-once-and-cache is what those three now read from instead of
// hitting the network themselves.
export interface RawConfig {
  agent_hour_utc?: number | null;
  agent_daily_picks?: number;
  repo_url?: string;
  turnstile_site_key?: string | null;
}

const CONFIG_URL = "/api/config";

let configCache: Promise<RawConfig> | undefined;

export function loadRawConfig(): Promise<RawConfig> {
  if (!configCache) {
    configCache = fetch(CONFIG_URL)
      .then((res) => res.json() as Promise<RawConfig>)
      .catch(() => ({} as RawConfig));
  }
  return configCache;
}
