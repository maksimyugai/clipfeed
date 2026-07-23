import "../env.d.ts";
import curationData from "../../curation.json" with { type: "json" };
import blocklistData from "../../blocklist.json" with { type: "json" };
import type { SourceConfig } from "./agent-types.ts";

export interface CurationConfig {
  topicVocabulary: string[];
  topicQuotas: Record<string, number>;
  prioritySources: string[];
  preferredDomains: string[];
}

export interface BlocklistConfig {
  blockedDomains: string[];
}

// topicQuotas are a MINIMUM per topic — letting their sum approach or
// exceed AGENT_DAILY_PICKS would starve general ranking entirely (no room
// left for the model's own judgment). Capped at 50% of the daily pick
// count; see validateTopicQuotas.
const MAX_QUOTA_SHARE = 0.5;

interface RawCurationConfig {
  topicVocabulary?: unknown;
  topicQuotas?: unknown;
  prioritySources?: unknown;
  preferredDomains?: unknown;
}

interface RawBlocklistConfig {
  blockedDomains?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asQuotaRecord(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, number> = {};
  for (const [topic, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      result[topic] = Math.round(count);
    }
  }
  return result;
}

// Truncates topicQuotas so their sum never exceeds MAX_QUOTA_SHARE of
// pickCount — drops the LAST-listed quotas first (object key insertion
// order, matching curation.json's own listed order) rather than starving
// general ranking. Pure/exported so the truncation behavior is directly
// unit-testable independent of the JSON file's actual contents.
export function validateTopicQuotas(
  quotas: Record<string, number>,
  pickCount: number,
): Record<string, number> {
  const entries = Object.entries(quotas);
  const maxSum = Math.floor(pickCount * MAX_QUOTA_SHARE);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total <= maxSum) return Object.fromEntries(entries);

  const kept = [...entries];
  let sum = total;
  const droppedTopics: string[] = [];
  while (kept.length > 0 && sum > maxSum) {
    const dropped = kept.pop();
    if (!dropped) break;
    sum -= dropped[1];
    droppedTopics.unshift(dropped[0]);
  }
  console.warn(JSON.stringify({
    event: "curation_quota_sum_exceeded",
    pick_count: pickCount,
    max_sum: maxSum,
    total,
    dropped: droppedTopics,
  }));
  return Object.fromEntries(kept);
}

// Unknown priority source ids (typo, or a source removed from sources.json
// but left in curation.json) are dropped and logged — a stale fork config
// degrades to "no guaranteed slot for that id" rather than crashing or
// silently never matching anything downstream.
export function validatePrioritySources(
  prioritySources: string[],
  sources: readonly SourceConfig[],
): string[] {
  const validIds = new Set(sources.map((s) => s.id));
  const valid: string[] = [];
  for (const id of prioritySources) {
    if (validIds.has(id)) {
      valid.push(id);
    } else {
      console.warn(JSON.stringify({ event: "curation_priority_source_unknown", sourceId: id }));
    }
  }
  return valid;
}

function loadRawCurationConfig(): RawCurationConfig {
  return curationData as RawCurationConfig;
}

// Empty/absent values in curation.json fall back to "no quotas, no
// priority sources, no preferred domains" — i.e. today's (pre-Task-33)
// ranking behavior exactly.
export function loadCurationConfig(
  sources: readonly SourceConfig[],
  pickCount: number,
): CurationConfig {
  const raw = loadRawCurationConfig();
  return {
    topicVocabulary: asStringArray(raw.topicVocabulary),
    topicQuotas: validateTopicQuotas(asQuotaRecord(raw.topicQuotas), pickCount),
    prioritySources: validatePrioritySources(asStringArray(raw.prioritySources), sources),
    preferredDomains: asStringArray(raw.preferredDomains),
  };
}

// Empty blockedDomains disables the layer entirely — same graceful
// degradation convention as the rest of this codebase's optional features.
export function loadBlocklistConfig(): BlocklistConfig {
  const raw = blocklistData as RawBlocklistConfig;
  return { blockedDomains: asStringArray(raw.blockedDomains) };
}
