import "../env.d.ts";
import {
  getNextPublishCandidate,
  markStaleArticlesSkipped,
  markTelegramPublished,
  type PublishCandidate,
} from "../articles/db.ts";
import {
  readTelegramConfig,
  sendMessage,
  sendPhoto,
  type TelegramConfig,
} from "./telegram-client.ts";
import { buildPublishCaption, buildPublishPost, cardUrl } from "./telegram-post.ts";
import { extensionForContentType } from "../pipeline/images.ts";

// Task 47 Part B §4: Telegram's own limits for a sendPhoto upload — a photo
// exceeding either is rejected outright, so it's cheaper to check ourselves
// and fall back to the sendMessage+link-preview path than to let the API
// call fail. Byte size is also checked defensively even though our own
// ingest-time IMAGES_MAX_BYTES cap (5 MB, see ssrf.ts) already keeps every
// stored image well under this.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_DIMENSION_SUM = 10000;
export const MAX_PHOTO_DIMENSION_RATIO = 20;

// Unknown dimensions (either null — no parser match at ingest time, an old
// row from before Task 46, or a format the parser doesn't cover) can't be
// checked at all, so they're treated as "not disqualified" here rather than
// blocking the photo path outright.
export function photoDimensionsWithinLimits(
  width: number | null,
  height: number | null,
): boolean {
  if (width === null || height === null) return true;
  if (width <= 0 || height <= 0) return false;
  if (width + height > MAX_PHOTO_DIMENSION_SUM) return false;
  return Math.max(width, height) / Math.min(width, height) <= MAX_PHOTO_DIMENSION_RATIO;
}

export interface PublishablePhoto {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

// Task 47 Part B §3: never throws, never blocks a publish — any failure
// (no image, no IMAGES binding, dimension limits, R2 miss/error, oversized
// bytes, unrecognized content-type) simply means "no photo this time",
// falling back to the existing sendMessage+link-preview path unchanged.
async function loadPublishablePhoto(
  env: Env,
  candidate: PublishCandidate,
): Promise<PublishablePhoto | null> {
  if (!candidate.image_key || !env.IMAGES) return null;

  if (!photoDimensionsWithinLimits(candidate.image_width, candidate.image_height)) {
    console.warn(JSON.stringify({
      event: "telegram_publish_photo_skipped",
      reason: "dimension_limits",
      articleId: candidate.id,
      width: candidate.image_width,
      height: candidate.image_height,
    }));
    return null;
  }

  try {
    const object = await env.IMAGES.get(candidate.image_key);
    if (!object) return null;

    const contentType = object.httpMetadata?.contentType;
    const extension = contentType ? extensionForContentType(contentType) : null;
    if (!contentType || !extension) return null;

    const buffer = await object.arrayBuffer();
    if (buffer.byteLength > MAX_PHOTO_BYTES) {
      console.warn(JSON.stringify({
        event: "telegram_publish_photo_skipped",
        reason: "oversized",
        articleId: candidate.id,
        bytes: buffer.byteLength,
      }));
      return null;
    }

    return { bytes: new Uint8Array(buffer), filename: `article.${extension}`, contentType };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "telegram_publish_photo_failed",
      articleId: candidate.id,
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

// Task 37: publish ONLY today's articles. The drip used to draw from a
// rolling 48h window, which meant a quiet stretch let yesterday's leftovers
// crowd out today's picks before the reader ever saw them. Owner decision:
// freshness beats completeness — 10 posts/day is already more than enough
// for a full day's picks to fit inside "today", so there's no need for a
// wider window at all.
export function utcDayStartIso(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

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

// Task 37 §3: flood guard against the agent producing more than one batch in
// a day (see Task 36) — without a cap, a second batch's worth of picks would
// otherwise all drip out on top of the first. Same defensive-parse
// convention as the hour vars above.
export const DEFAULT_PUBLISH_MAX_PER_DAY = 10;

function parsePublishMaxPerDay(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_PUBLISH_MAX_PER_DAY;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(
      JSON.stringify({
        event: "publish_max_per_day_invalid",
        raw: trimmed,
        fallback: DEFAULT_PUBLISH_MAX_PER_DAY,
      }),
    );
    return DEFAULT_PUBLISH_MAX_PER_DAY;
  }
  return n;
}

// Same 48h TTL convention as Task 36's agentrun:<date> marker — a day's
// counter naturally expires after two days rather than needing explicit
// cleanup, well after the cap could matter again.
const PUBLISH_COUNT_TTL_SECONDS = 48 * 60 * 60;

// Keyed off `nowMs` (the publish attempt's own time, not the real wall
// clock) so the cap is scoped to the correct UTC calendar day even under
// test with an injected time.
function publishCountKey(nowMs: number): string {
  return `published:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

async function readPublishCountToday(cache: KVNamespace, nowMs: number): Promise<number> {
  const raw = await cache.get(publishCountKey(nowMs));
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function incrementPublishCount(
  cache: KVNamespace,
  nowMs: number,
  countBefore: number,
): Promise<void> {
  await cache.put(publishCountKey(nowMs), String(countBefore + 1), {
    expirationTtl: PUBLISH_COUNT_TTL_SECONDS,
  });
}

export type PublishOutcome =
  | { kind: "published"; articleId: string }
  | { kind: "skipped-unfaithful"; articleId: string }
  | { kind: "empty" }
  | { kind: "cap-reached"; maxPerDay: number };

// The one shared "advance the drip queue by one" step, used by BOTH the
// hourly cron job (gated by window/enabled, see runPublishJob below) and
// the owner-only /publish command (which forces it immediately, ignoring
// the window — but NOT the cap, see §4). A faithfulness-'fail' candidate is
// never sent to Telegram — broadcasting a likely-inaccurate summary is
// worse than silence — but is still marked published so the queue advances
// past it on the next tick instead of retrying the same skip forever. That
// skip never touches the daily cap: it never reaches Telegram, so it can't
// contribute to flooding the channel.
export async function publishNextArticle(
  env: Env,
  config: TelegramConfig,
  nowMs: number = Date.now(),
): Promise<PublishOutcome> {
  const since = utcDayStartIso(nowMs);
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

  const maxPerDay = parsePublishMaxPerDay(env.PUBLISH_MAX_PER_DAY);
  const countToday = await readPublishCountToday(env.CACHE, nowMs);
  if (countToday >= maxPerDay) {
    console.warn(JSON.stringify({ event: "publish_cap_reached", maxPerDay }));
    return { kind: "cap-reached", maxPerDay };
  }

  const postInput = {
    id: candidate.id,
    url: candidate.url,
    source: candidate.source,
    title_ru: candidate.title_ru,
    tldr_ru: candidate.tldr_ru,
    bullets_ru: candidate.bullets_ru,
  };

  // TELEGRAM_CHANNEL_ID (when set) is where posts go so the feature works
  // as a proper channel from day one; empty means "no channel yet", so
  // posts land in the owner's own DM instead — the same surface the old
  // digest used, so nothing regresses for an owner who hasn't created a
  // channel.
  const chatId = (env.TELEGRAM_CHANNEL_ID ?? "").trim() || config.ownerChatId;

  // Task 47 Part B: Telegram's own link-preview crawler never renders a
  // preview for this instance regardless of link_preview_options (see Task
  // 46/47's investigation — /a/:id and /img/:id are both reachable and
  // correctly tagged from outside, so the failure isn't ours to fix by
  // tuning parameters further). Uploading the image directly via sendPhoto
  // sidesteps the crawler entirely: Telegram never has to fetch anything
  // from us for the photo to appear. Deliberately NOT caught here: a send
  // failure must not mark this candidate published — leaving
  // telegram_published_at untouched means the next tick simply retries the
  // same (still-oldest) candidate, which is the correct self-healing
  // behavior for a transient Telegram/network error. Callers (runPublishJob,
  // the /publish command) decide how to surface the failure.
  const photo = await loadPublishablePhoto(env, candidate);
  if (photo) {
    const caption = buildPublishCaption(postInput, env.PUBLIC_BASE_URL);
    await sendPhoto(config.botToken, chatId, photo.bytes, photo.filename, photo.contentType, {
      caption,
      parseMode: "HTML",
    });
  } else {
    const text = buildPublishPost(postInput, env.PUBLIC_BASE_URL);
    // Kept as a best-effort fallback for the no-image/failed-load case —
    // harmless to still pin the preview even though it hasn't been observed
    // to actually render (see the doc comment above).
    const trimmedBase = env.PUBLIC_BASE_URL.trim();
    const linkPreviewOptions = trimmedBase
      ? {
        url: cardUrl(trimmedBase, candidate.id),
        preferLargeMedia: true,
        showAboveText: true,
      }
      : undefined;
    await sendMessage(config.botToken, chatId, text, { parseMode: "HTML", linkPreviewOptions });
  }

  await markTelegramPublished(env.DB, candidate.id, now);
  await incrementPublishCount(env.CACHE, nowMs, countToday);
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

  // Task 37 §2: sweep yesterday-and-older unpublished candidates out of the
  // queue on every enabled tick, regardless of the publish-hour window — this
  // is unrelated cleanup, not a publish attempt, so it shouldn't wait for the
  // window to open. Wrapped separately so a sweep failure can never prevent
  // the actual publish attempt below.
  try {
    const cutoff = utcDayStartIso(nowMs);
    const staleCount = await markStaleArticlesSkipped(env.DB, cutoff);
    if (staleCount > 0) {
      console.log(JSON.stringify({ event: "publish_skipped_stale", count: staleCount }));
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "publish_stale_sweep_failed", error: String(err) }));
  }

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
