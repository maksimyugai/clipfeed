import "../env.d.ts";
import sourcesData from "../../sources.json" with { type: "json" };
import type { Candidate, SourceConfig } from "./agent-types.ts";
import { fetchRssCandidates } from "./feed-parser.ts";
import { fetchHackerNewsCandidates } from "./hackernews.ts";

// The owner-editable source list — see README "Daily scraping agent" for
// the shape and how to add/remove sources in a fork.
export const SOURCES: SourceConfig[] = sourcesData as SourceConfig[];

export interface FetchSourcesResult {
  candidates: Candidate[];
  fetched: string[];
  failed: { id: string; reason: string }[];
}

async function fetchOneSource(source: SourceConfig): Promise<Candidate[]> {
  if (source.type === "hackernews") {
    return await fetchHackerNewsCandidates(source.id);
  }
  return await fetchRssCandidates(source);
}

// Fetches every configured source, isolating failures per source — one
// unreachable or malformed feed is logged and skipped, never fails the
// whole agent run.
export async function fetchAllCandidates(
  sources: SourceConfig[] = SOURCES,
): Promise<FetchSourcesResult> {
  const candidates: Candidate[] = [];
  const fetched: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const source of sources) {
    try {
      candidates.push(...await fetchOneSource(source));
      fetched.push(source.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ id: source.id, reason });
      console.warn(JSON.stringify({ event: "agent_source_failed", sourceId: source.id, reason }));
    }
  }

  return { candidates, fetched, failed };
}
