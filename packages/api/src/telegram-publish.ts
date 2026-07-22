import "./env.d.ts";
import { getNextPublishCandidate, markTelegramPublished } from "./db.ts";
import { readTelegramConfig, sendMessage, type TelegramConfig } from "./telegram-client.ts";
import { buildPublishPost } from "./telegram-post.ts";

// Don't drip out ancient backlog if the feature is turned on (or was off
// for a while) long after articles piled up — same "recent window" idea as
// the /digest command's 24h lookback, just wider since the drip is meant
// to eventually surface everything from roughly the last two days, not
// just "since yesterday".
const PUBLISH_LOOKBACK_MS = 48 * 60 * 60 * 1000;

// [vars] strings parsed defensively, same pattern as the rest of this
// codebase's hour-window/threshold configs (see search.ts's
// parseSearchMinScore) — a missing/invalid value falls back to the
// documented default with a warning, rather than disabling the feature the
// way scheduled.ts's parseHour does for AGENT_HOUR_UTC/DIGEST_HOUR_UTC.
// PUBLISH_ENABLED is the on/off switch; the window vars just bound WHEN a
// tick is allowed to publish.
export const DEFAULT_PUBLISH_START_HOUR_UTC = 4;
export const DEFAULT_PUBLISH_END_HOUR_UTC = 18;

function parseHourWithDefault(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    console.warn(JSON.stringify({ event: "publish_hour_invalid", raw: trimmed, fallback }));
    return fallback;
  }
  return n;
}

// Assumes start <= end (the documented defaults 4/18 do) — a fork that sets
// start > end gets an always-closed window rather than a wrapped-past-
// midnight one; not a supported configuration.
export function isWithinPublishWindow(
  currentHourUtc: number,
  startRaw: string | undefined,
  endRaw: string | undefined,
): boolean {
  const start = parseHourWithDefault(startRaw, DEFAULT_PUBLISH_START_HOUR_UTC);
  const end = parseHourWithDefault(endRaw, DEFAULT_PUBLISH_END_HOUR_UTC);
  return currentHourUtc >= start && currentHourUtc < end;
}

// Only the literal "false" disables — same convention as
// FAITHFULNESS_CHECK, so a typo'd or missing value fails open (drip stays
// on) rather than silently going dark.
export function isPublishEnabled(raw: string | undefined): boolean {
  return (raw ?? "true").trim().toLowerCase() !== "false";
}

export type PublishOutcome =
  | { kind: "published"; articleId: string }
  | { kind: "skipped-unfaithful"; articleId: string }
  | { kind: "empty" };

// The one shared "advance the drip queue by one" step, used by BOTH the
// hourly cron job (gated by window/enabled, see runPublishJob below) and
// the owner-only /publish command (which forces it immediately, ignoring
// the window). A faithfulness-'fail' candidate is never sent to Telegram —
// broadcasting a likely-inaccurate summary is worse than silence — but is
// still marked published so the queue advances past it on the next tick
// instead of retrying the same skip forever.
export async function publishNextArticle(
  env: Env,
  config: TelegramConfig,
  nowMs: number = Date.now(),
): Promise<PublishOutcome> {
  const since = new Date(nowMs - PUBLISH_LOOKBACK_MS).toISOString();
  const candidate = await getNextPublishCandidate(env.DB, since);
  if (!candidate) return { kind: "empty" };

  const now = new Date(nowMs).toISOString();

  if (candidate.faithfulness_verdict === "fail") {
    console.warn(
      JSON.stringify({ event: "telegram_publish_skip_unfaithful", articleId: candidate.id }),
    );
    await markTelegramPublished(env.DB, candidate.id, now);
    return { kind: "skipped-unfaithful", articleId: candidate.id };
  }

  const text = buildPublishPost({
    id: candidate.id,
    url: candidate.url,
    source: candidate.source,
    title_ru: candidate.title_ru,
    tldr_ru: candidate.tldr_ru,
    bullets_ru: candidate.bullets_ru,
  }, env.PUBLIC_BASE_URL);

  // TELEGRAM_CHANNEL_ID (when set) is where posts go so the feature works
  // as a proper channel from day one; empty means "no channel yet", so
  // posts land in the owner's own DM instead — the same surface the old
  // digest used, so nothing regresses for an owner who hasn't created a
  // channel.
  const chatId = (env.TELEGRAM_CHANNEL_ID ?? "").trim() || config.ownerChatId;

  // Deliberately NOT caught here: a send failure must not mark this
  // candidate published — leaving telegram_published_at untouched means
  // the next tick simply retries the same (still-oldest) candidate, which
  // is the correct self-healing behavior for a transient Telegram/network
  // error. Callers (runPublishJob, the /publish command) decide how to
  // surface the failure.
  await sendMessage(config.botToken, chatId, text, { parseMode: "HTML" });
  await markTelegramPublished(env.DB, candidate.id, now);
  return { kind: "published", articleId: candidate.id };
}

// Called by the hourly cron (see scheduled.ts, which passes the tick's own
// scheduledTimeMs rather than letting this read the wall clock itself —
// same explicit-time-injection convention as handleScheduled/
// sweepStalePending elsewhere in this codebase, so a test can drive the
// window check deterministically instead of monkey-patching Date). Silent
// no-op outside the publish window, when disabled, or when Telegram isn't
// configured at all; never throws (a publish failure is logged and
// swallowed so it can't take down the rest of the scheduled tick, same as
// the other cron jobs).
export async function runPublishJob(env: Env, nowMs: number = Date.now()): Promise<void> {
  const config = readTelegramConfig(env);
  if (!config) return;
  if (!isPublishEnabled(env.PUBLISH_ENABLED)) return;

  const currentHour = new Date(nowMs).getUTCHours();
  if (!isWithinPublishWindow(currentHour, env.PUBLISH_START_HOUR_UTC, env.PUBLISH_END_HOUR_UTC)) {
    return;
  }

  try {
    await publishNextArticle(env, config, nowMs);
  } catch (err) {
    console.error(JSON.stringify({ event: "telegram_publish_job_failed", error: String(err) }));
  }
}
