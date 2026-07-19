import "./env.d.ts";
import type { Candidate } from "./agent-types.ts";
import { callLlm, stripJsonFences } from "./summarize.ts";
import { selectProviderMode } from "./pipeline.ts";

const RANK_SYSTEM_PROMPT =
  "You rank news for a personal feed. Respond ONLY with a JSON array of the 5 best item ids.";
const RANK_MAX_TOKENS = 200;
export const PICK_COUNT = 5;

function buildRankUserMessage(interests: string, candidates: Candidate[]): string {
  const lines = candidates.map(
    (c) => `${c.id} | ${c.discoverySource} | ${c.title} | ${c.snippet}`,
  );
  return `Interests: ${interests}\n\nCandidates:\n${lines.join("\n")}`;
}

function parseRankedIds(raw: string, validIds: ReadonlySet<string>): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) {
    return null;
  }
  const filtered = parsed.filter((id) => validIds.has(id));
  return filtered.length > 0 ? filtered.slice(0, PICK_COUNT) : null;
}

// Used when the LLM call fails outright, or never returns a parseable,
// valid pick list: newest-first, one per source, up to PICK_COUNT — then
// backfills from the remaining newest candidates if there weren't enough
// distinct sources to fill every slot. `candidates` is assumed already
// sorted newest-first (see agent-pool.ts).
export function fallbackPicks(candidates: Candidate[]): string[] {
  const seenSources = new Set<string>();
  const picks: string[] = [];

  for (const c of candidates) {
    if (picks.length >= PICK_COUNT) break;
    if (seenSources.has(c.sourceId)) continue;
    seenSources.add(c.sourceId);
    picks.push(c.id);
  }
  if (picks.length < PICK_COUNT) {
    const pickedIds = new Set(picks);
    for (const c of candidates) {
      if (picks.length >= PICK_COUNT) break;
      if (pickedIds.has(c.id)) continue;
      picks.push(c.id);
    }
  }
  return picks;
}

// One cheap LLM call to pick the best PICK_COUNT candidates for the owner's
// interests. Never fails the run: a request error or two unparseable
// responses in a row both fall back to fallbackPicks(). Does NOT consume
// the daily summarization budget — that's spent per-article in the
// pipeline, not here.
export async function rankCandidates(
  env: Env,
  interests: string,
  candidates: Candidate[],
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const mode = selectProviderMode({
    aiGatewayUrl: env.AI_GATEWAY_URL,
    cfAigToken: env.CF_AIG_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });
  const validIds = new Set(candidates.map((c) => c.id));
  const userMessage = buildRankUserMessage(interests, candidates);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLlm(mode, env, RANK_SYSTEM_PROMPT, userMessage, RANK_MAX_TOKENS);
      const ids = parseRankedIds(raw, validIds);
      if (ids) return ids;
    } catch {
      // Provider/network error — retry once, then fall back below.
    }
  }

  return fallbackPicks(candidates);
}
