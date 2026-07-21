import type { FailureClass } from "./types.ts";

// Classifies a stored `articles.error` string into a healing strategy.
// Lives in the shared package (not packages/api) because both the API
// (persisting fail_class, driving the healing job) and the SPA (deriving a
// human-readable reason for a permanent-failed card, see ArticleCard.tsx)
// need the identical mapping — duplicating it per-package risks the two
// drifting apart. Every failure reason in this codebase is ours (see
// pipeline.ts, db.ts, queue.ts, summarize.ts, ssrf.ts) — there's no
// third-party error text to account for, so this is a small, explicit
// vocabulary rather than a generic error-parsing library. Matching is
// substring-based (not prefix) because pipeline.ts wraps most caught
// exceptions as `internal: <stage>: <message>` before storing them — e.g.
// an SsrfError's "upstream responded 404" is actually stored as
// "internal: fetch: upstream responded 404", which still contains the
// vocabulary substring.
// Stable identifiers for each PERMANENT reason — the SPA maps these to
// localized (ru/en) copy for a permanent-failed card (see
// packages/web/src/lib/failureDisplay.ts); `reason` below stays a plain
// English string meant for logs/health-report output, never shown to a
// user directly, so it doesn't need a ru/en pair of its own.
export type PermanentReasonKey =
  | "insufficient_text"
  | "not_found"
  | "removed"
  | "ssrf_blocked"
  | "paywalled";

export interface FailureClassification {
  class: FailureClass;
  reason: string;
  // Only meaningful when class === "permanent" — null otherwise, since
  // transient/unknown failures don't get the special "couldn't process"
  // card treatment that needs a stable, localizable key.
  permanentReasonKey: PermanentReasonKey | null;
}

// Ordered rule list — first match wins. No two rules in this list actually
// overlap in practice (verified against every error string the pipeline
// produces), so the order mostly matters for the `reason` text, not the
// resulting class.
const TRANSIENT_RULES: { substring: string; reason: string }[] = [
  // Covers both the Anthropic/gateway path's "timed out after Nms" and the
  // Workers AI binding's timeout rejection — a timeout says nothing about
  // whether the SAME call would time out again, so it's worth a retry.
  { substring: "timed out", reason: "llm call timed out" },
  { substring: "ai gateway error (5", reason: "ai gateway 5xx error" },
  { substring: "anthropic api error (429", reason: "anthropic rate limited (429)" },
  { substring: "anthropic api error (5", reason: "anthropic 5xx error" },
  // Workers AI binding failures are overwhelmingly infra-flakiness
  // (timeouts already caught above, transient binding errors, rate
  // limits) rather than a property of the specific article.
  { substring: "workers ai error", reason: "workers ai binding error" },
  { substring: "fetch: upstream responded 5", reason: "source server 5xx error" },
  {
    substring: "queue: processing failed after retries",
    reason: "queue exhausted retries (dead-lettered)",
  },
  { substring: "timeout: processing did not complete", reason: "stale-pending sweeper timeout" },
  // Resets at UTC midnight (see cost-guard.ts) — "permanent" today, gone
  // by tomorrow, so a later retry is expected to succeed on its own.
  { substring: "daily-limit", reason: "daily summary budget exhausted" },
];

const PERMANENT_RULES: { substring: string; reason: string; key: PermanentReasonKey }[] = [
  // The dominant real-world signal for a thin/mirror/paywalled page —
  // there's no more text to extract next time either.
  {
    substring: "extraction: insufficient text",
    reason: "page has no substantive article text",
    key: "insufficient_text",
  },
  { substring: "fetch: upstream responded 404", reason: "source page not found", key: "not_found" },
  {
    substring: "fetch: upstream responded 410",
    reason: "source page permanently removed",
    key: "removed",
  },
  // A paywall doesn't heal itself — retrying gets the exact same 402/403
  // every time, so this belongs with the other un-retryable reasons, not
  // with transient 5xx errors.
  {
    substring: "fetch: upstream responded 403",
    reason: "source page paywalled or forbidden",
    key: "paywalled",
  },
  {
    substring: "fetch: upstream responded 402",
    reason: "source page paywalled or forbidden",
    key: "paywalled",
  },
  { substring: "ssrf", reason: "url blocked by ssrf policy", key: "ssrf_blocked" },
];

export function classifyFailure(error: string): FailureClassification {
  const normalized = error.toLowerCase();

  for (const rule of TRANSIENT_RULES) {
    if (normalized.includes(rule.substring)) {
      return { class: "transient", reason: rule.reason, permanentReasonKey: null };
    }
  }
  for (const rule of PERMANENT_RULES) {
    if (normalized.includes(rule.substring)) {
      return { class: "permanent", reason: rule.reason, permanentReasonKey: rule.key };
    }
  }
  // Includes 'summary validation' failures — content-shaped, not
  // infra-shaped, so a retry MIGHT produce a passing summary, but there's
  // no strong signal either way — see the reduced heal_attempts cap for
  // 'unknown' in the healing job.
  return { class: "unknown", reason: "no known pattern matched", permanentReasonKey: null };
}
