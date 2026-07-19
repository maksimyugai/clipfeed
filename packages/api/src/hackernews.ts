import "./env.d.ts";
import type { Candidate } from "./agent-types.ts";

const TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const STORY_COUNT = 30;
const TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DISCOVERY_SOURCE = "news.ycombinator.com";

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  time?: number; // unix seconds
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`hn fetch failed: ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches HN's top stories, keeping only real link submissions (type
// 'story' with a url — Ask HN/Show HN text posts have no url and are
// skipped). Per-item fetch failures are swallowed individually so one bad
// id never drops the rest of the batch; a topstories-list failure throws
// (the caller, sources.ts, is responsible for catching and skipping the
// whole source).
export async function fetchHackerNewsCandidates(sourceId: string): Promise<Candidate[]> {
  const ids = await fetchJson<number[]>(TOPSTORIES_URL);
  const top = ids.slice(0, STORY_COUNT);

  const items = await Promise.all(
    top.map((id) => fetchJson<HnItem>(ITEM_URL(id)).catch(() => null)),
  );

  const candidates: Candidate[] = [];
  for (const item of items) {
    if (!item || item.type !== "story" || !item.url) continue;
    candidates.push({
      id: `${sourceId}-${item.id}`,
      sourceId,
      discoverySource: DISCOVERY_SOURCE,
      title: item.title ?? item.url,
      url: item.url,
      snippet: "",
      publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
    });
  }
  return candidates;
}
