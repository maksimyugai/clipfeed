import { classifyFailure, type PermanentReasonKey } from "../../../shared/src/classify-failure.ts";

// Pure helpers deciding what a failed-article card shows and which actions
// it offers — kept separate from ArticleCard.tsx so this logic is
// unit-testable without mounting a component.
//
// `error` can be null/empty even though the D1 row has a real, non-empty
// message: the live poll path (usePendingPoll -> getArticle()) fetches the
// PUBLIC article shape, which never carries the raw error string (only
// `has_error: boolean` — see PublicArticle in @clipfeed/shared/types) — so
// a card that transitions from 'pending' to 'failed' via a live poll
// merges in the fresh status but keeps whatever `error` it already had
// (null, from when it was pending) until the next full feed reload.
// Rather than show a bare "Ошибка: —", which reads like a genuine bug,
// this falls back to a generic, honest label.

export interface FailureDisplayDict {
  errorPrefix: string;
  couldNotProcessLabel: string;
  permanentFailurePrefix: string;
  permanentReasonInsufficientText: string;
  permanentReasonNotFound: string;
  permanentReasonRemoved: string;
  permanentReasonSsrfBlocked: string;
}

function permanentReasonLabel(key: PermanentReasonKey, dict: FailureDisplayDict): string {
  switch (key) {
    case "insufficient_text":
      return dict.permanentReasonInsufficientText;
    case "not_found":
      return dict.permanentReasonNotFound;
    case "removed":
      return dict.permanentReasonRemoved;
    case "ssrf_blocked":
      return dict.permanentReasonSsrfBlocked;
  }
}

// PERMANENT failures (a thin/mirror page, a 404, a removed page, an
// SSRF-blocked url) get a distinct, localized "couldn't process: <reason>"
// message instead of the raw technical error — retrying a permanent
// failure is pointless, so the copy shouldn't read like a transient glitch
// (see isPermanentFailure, which the card also uses to hide its Retry
// button for exactly this class).
export function articleErrorText(error: string | null, dict: FailureDisplayDict): string {
  const trimmed = (error ?? "").trim();
  if (trimmed.length === 0) return dict.couldNotProcessLabel;

  const { class: failClass, permanentReasonKey } = classifyFailure(trimmed);
  if (failClass === "permanent" && permanentReasonKey) {
    return `${dict.permanentFailurePrefix}: ${permanentReasonLabel(permanentReasonKey, dict)}`;
  }
  return `${dict.errorPrefix}: ${trimmed}`;
}

// A null/empty error (see the poll-merge gap above) is deliberately NOT
// treated as permanent here — we simply don't know yet, so the card keeps
// offering Retry rather than guessing.
export function isPermanentFailure(error: string | null): boolean {
  const trimmed = (error ?? "").trim();
  if (trimmed.length === 0) return false;
  return classifyFailure(trimmed).class === "permanent";
}
