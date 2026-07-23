// Shared types for the scraper agent (sources.ts, feed-parser.ts,
// hackernews.ts, agent-pool.ts, ranking.ts, agent.ts) — kept dependency-free
// so none of those modules need to import each other just for a type.

export type SourceType = "rss" | "hackernews";

// Mirrors packages/api/sources.json exactly — see README for the
// owner-editable config shape.
export interface SourceConfig {
  id: string;
  type: SourceType;
  url?: string;
}

export interface Candidate {
  // Unique within a single agent run (not stable across runs) — how the
  // ranking LLM call references items; never persisted.
  id: string;
  // sources.json config id, e.g. "hn", "arstechnica" — seeds the saved
  // article's tags.
  sourceId: string;
  // Human-readable discovery source for the ranking prompt and logs, e.g.
  // "news.ycombinator.com" or the RSS feed's own domain. Distinct from the
  // saved article's `source` column, which is derived from the article's
  // own URL via sourceFromUrl().
  discoverySource: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}
