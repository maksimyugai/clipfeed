import { useEffect, useRef, useState } from "preact/hooks";
import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { viaLabel } from "../i18n.ts";
import { getArticle } from "../api.ts";
import { selectSummaryFields } from "../lib/summaryFields.ts";
import { formatDate } from "../lib/format.ts";
import { nextPollDelayMs, pollReducer, type PollState } from "../lib/pollSchedule.ts";
import {
  articleErrorText,
  failClassIsPermanent,
  isDailyLimitFailure,
  isPermanentFailure,
  visitorFailureText,
} from "../lib/failureDisplay.ts";

const JUST_READY_HIGHLIGHT_MS = 2000;

// Polls GET /api/articles/:id while status is 'pending'. Cadence and the
// give-up/resume transitions live in pollSchedule.ts (pure, unit-tested);
// this hook owns only the DOM-timer wiring: a variable-delay setTimeout
// chain (the schedule isn't a fixed interval — see nextPollDelayMs), the
// elapsed-time clock driving it, tab-visibility pause/resume (existing
// behavior, unchanged), and the manual "Check now" re-fetch that can always
// bring a given-up card back to polling — so a pending card never reaches a
// genuine dead end, just a slower/manual path back to the same result.
function usePendingPoll(
  article: ArticleListItem,
  onUpdate: (article: ArticleListItem) => void,
): { pollState: PollState; checkNow: () => void } {
  const [pollState, setPollState] = useState<PollState>("polling");
  // Mirrors `pollState` for the effect below to read synchronously — a
  // plain closure over the state variable would see whatever value was
  // current when the effect was set up (article.id/status haven't
  // changed, so the effect never re-runs to pick up a fresher one), which
  // would make visibility-resume always think it's still "polling" even
  // after a give-up.
  const pollStateRef = useRef<PollState>("polling");
  // Wall-clock accumulator for the CURRENT cycle only — paused while the
  // tab is hidden (matching the existing pause behavior) and reset to 0
  // whenever a manual check resumes a fresh cycle.
  const elapsedRef = useRef(0);
  const checkNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (article.status !== "pending") return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let cycleStartedAt = 0;

    pollStateRef.current = "polling";
    elapsedRef.current = 0;
    setPollState("polling");

    const applyPollState = (next: PollState) => {
      pollStateRef.current = next;
      setPollState(next);
    };

    const stopTimer = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
    };

    const runCheck = async (): Promise<"done" | "still-pending" | "error"> => {
      try {
        const updated = await getArticle(article.id);
        if (cancelled) return "done";
        if (updated.status !== "pending") {
          // getArticle() returns the public shape (has_error, no raw error
          // string) — merge onto the existing list item so `error` survives
          // (it was already null while pending; a newly-failed article
          // shows the generic "—" fallback until the next full list fetch).
          onUpdate({ ...article, ...updated });
          return "done";
        }
        return "still-pending";
      } catch {
        return "error";
      }
    };

    const scheduleNext = (delayMs: number) => {
      stopTimer();
      timerId = setTimeout(tick, delayMs);
    };

    // Starts (or resumes) a poll cycle from the current elapsed-time clock
    // — if that clock already exceeds the give-up budget (only possible if
    // this runs right after a stale resume), give up immediately instead
    // of firing a 0-delay poll.
    const startCycle = () => {
      const delay = nextPollDelayMs(elapsedRef.current);
      if (delay === null) {
        applyPollState("given-up");
        return;
      }
      cycleStartedAt = Date.now();
      scheduleNext(delay);
    };

    async function tick() {
      const outcome = await runCheck();
      if (cancelled || outcome === "done") return;

      elapsedRef.current += Date.now() - cycleStartedAt;

      if (outcome === "error") {
        applyPollState(pollReducer("polling", { type: "tick-error" }));
        return;
      }

      const nextState = pollReducer("polling", {
        type: "tick-still-pending",
        elapsedMs: elapsedRef.current,
      });
      applyPollState(nextState);
      if (nextState === "polling") {
        cycleStartedAt = Date.now();
        scheduleNext(nextPollDelayMs(elapsedRef.current) ?? 0);
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopTimer();
      } else if (pollStateRef.current === "polling") {
        startCycle();
      }
    };

    checkNowRef.current = () => {
      stopTimer();
      runCheck().then((outcome) => {
        if (cancelled || outcome === "done") return;
        // A manual check always starts a fresh cycle, regardless of why the
        // previous one stopped (give-up timeout or a fetch error) — that's
        // the "never a dead end" guarantee: there's always a way back to
        // polling.
        elapsedRef.current = 0;
        applyPollState(pollReducer("given-up", { type: "manual-check-still-pending" }));
        if (!document.hidden) startCycle();
      });
    };

    if (!document.hidden) startCycle();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [article.id, article.status]);

  return { pollState, checkNow: () => checkNowRef.current() };
}

// Briefly true right after `status` flips from 'pending' to 'ready' — drives
// a fading highlight so the transition is noticeable instead of the card
// just silently changing shape. Not triggered for a 'pending' -> 'failed'
// transition, which already has its own distinct card--failed styling.
function useJustReadyHighlight(status: ArticleListItem["status"]): boolean {
  const [justReady, setJustReady] = useState(false);
  const previousStatus = useRef(status);

  useEffect(() => {
    if (previousStatus.current === "pending" && status === "ready") {
      setJustReady(true);
      const timer = setTimeout(() => setJustReady(false), JUST_READY_HIGHLIGHT_MS);
      previousStatus.current = status;
      return () => clearTimeout(timer);
    }
    previousStatus.current = status;
  }, [status]);

  return justReady;
}

export interface ArticleCardProps {
  dict: Dictionary;
  lang: Lang;
  article: ArticleListItem;
  isPickOfDay: boolean;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  onTagClick: (tag: string) => void;
  onSourceClick: (source: string) => void;
  onArchiveToggle: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onResummarize: (id: string) => void;
  onArticleUpdate: (article: ArticleListItem) => void;
  isOwner: boolean;
}

export function ArticleCard(props: ArticleCardProps) {
  const {
    dict,
    lang,
    article,
    isPickOfDay,
    expanded,
    onToggleExpand,
    onTagClick,
    onSourceClick,
    onArchiveToggle,
    onDelete,
    onRetry,
    onResummarize,
    onArticleUpdate,
    isOwner,
  } = props;

  const { pollState, checkNow } = usePendingPoll(article, onArticleUpdate);
  const justReady = useJustReadyHighlight(article.status);
  const givenUpPolling = pollState === "given-up";

  if (article.status === "pending") {
    return (
      <article class="card card--pending">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <h3 class="card-title">{article.title}</h3>
        {givenUpPolling
          ? (
            <div class="pending-stuck-note">
              <span>{dict.pendingStuckLabel}</span>
              <button type="button" class="check-now-button" onClick={checkNow}>
                {dict.checkNowButton}
              </button>
            </div>
          )
          : (
            <div class="pending-row">
              <span class="spinner" aria-hidden="true" />
              <span>{dict.pendingLabel}</span>
            </div>
          )}
      </article>
    );
  }

  if (article.status === "failed") {
    // Owner mode has the real `error` string (from GET /api/admin/articles)
    // and can classify it precisely — including the daily-limit special
    // case (see isDailyLimitFailure: the budget resets at UTC midnight and
    // healing auto-retries it, so Retry here is pointless). Visitor mode
    // only ever has `fail_class` (the public list redacts `error` — see
    // failureDisplay.ts's doc comment and the privacy-incident regression
    // test in articles_test.ts), so it gets a less specific but still
    // localized message via visitorFailureText.
    //
    // A PERMANENT failure (thin/mirror page, 404, removed, ssrf-blocked)
    // won't succeed on retry no matter how many times it's tried — hiding
    // Retry and making Delete the obvious action is honest, not just a
    // style choice.
    const dailyLimit = isOwner && isDailyLimitFailure(article.error);
    const permanent = isOwner
      ? isPermanentFailure(article.error)
      : failClassIsPermanent(article.fail_class);
    const message = isOwner
      ? articleErrorText(article.error, dict)
      : visitorFailureText(article.fail_class, dict);
    return (
      <article class="card card--failed">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <h3 class="card-title">{article.title}</h3>
        <p class="error-text">{message}</p>
        {isOwner && (
          <div class="card-failed-actions">
            {!permanent && !dailyLimit && (
              <button
                type="button"
                class="retry-button"
                onClick={() => onRetry(article.id)}
              >
                {dict.retryButton}
              </button>
            )}
            <button
              type="button"
              class={permanent ? "delete-button-prominent" : "delete-button-outline"}
              onClick={() => {
                if (confirm(dict.deleteConfirm)) onDelete(article.id);
              }}
            >
              {dict.deleteAction}
            </button>
          </div>
        )}
      </article>
    );
  }

  const fields = selectSummaryFields(article.title, article.summary_json, lang);
  const source = article.source;
  const cardClass = `card${isPickOfDay ? " card--highlighted" : ""}${
    justReady ? " card--just-ready" : ""
  }`;

  return (
    <article class={cardClass} aria-expanded={expanded}>
      {isPickOfDay && <span class="pick-chip">{dict.pickOfDay}</span>}
      <div class="card-date">{formatDate(article.added_at, lang)}</div>

      <button type="button" class="card-title-button" onClick={() => onToggleExpand(article.id)}>
        <h3 class="card-title">{fields.title}</h3>
      </button>

      {!expanded && (
        <>
          {fields.tldr && <p class="card-tldr-excerpt">{fields.tldr}</p>}
          <div class="card-footer-row">
            <div class="card-pills">
              {article.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  class="tag-pill"
                  onClick={() => onTagClick(tag)}
                >
                  {tag}
                </button>
              ))}
              {source && (
                <button
                  type="button"
                  class="source-pill"
                  onClick={() => onSourceClick(source)}
                >
                  🌐 {source}
                </button>
              )}
            </div>
            <button type="button" class="read-more" onClick={() => onToggleExpand(article.id)}>
              {dict.readMore}
            </button>
          </div>
        </>
      )}

      {expanded && (
        <div class="card-expanded-body">
          {fields.tldr && (
            <p class="tldr-paragraph">
              <span class="tldr-label">{dict.tldrLabel}</span> {fields.tldr}
            </p>
          )}
          {fields.body.length > 0 && (
            <div class="card-body">
              {fields.body.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
            </div>
          )}
          {fields.bullets.length > 0 && (
            <ul class="bullet-list">
              {fields.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
            </ul>
          )}
          <div class="expanded-tags-row">
            {article.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                class="tag-pill"
                onClick={() => onTagClick(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
          <div class="card-footer">
            <p class="card-footer-text">
              {dict.summaryByPrefix}{" "}
              <a href={article.url} target="_blank" rel="noopener">{source ?? article.url}</a> ·
              {" "}
              {dict.summaryAddedVia} {viaLabel(dict, article.added_via)}
            </p>
            <div class="card-footer-actions">
              {isOwner && (
                <button
                  type="button"
                  class="icon-button"
                  aria-label={dict.resummarizeAction}
                  onClick={() => onResummarize(article.id)}
                >
                  🔁
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  class="icon-button"
                  aria-label={article.archived ? dict.unarchiveAction : dict.archiveAction}
                  onClick={() => onArchiveToggle(article.id, !article.archived)}
                >
                  {article.archived ? "📤" : "🗄"}
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  class="icon-button"
                  aria-label={dict.deleteAction}
                  onClick={() => {
                    if (confirm(dict.deleteConfirm)) onDelete(article.id);
                  }}
                >
                  🗑
                </button>
              )}
              <button
                type="button"
                class="icon-button"
                aria-label={dict.collapseAction}
                onClick={() => onToggleExpand(article.id)}
              >
                ▲
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
