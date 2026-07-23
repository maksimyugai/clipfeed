import { useEffect, useRef, useState } from "preact/hooks";
import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { viaLabel } from "../i18n.ts";
import { getAdminArticle, getArticle, translateArticle } from "../api.ts";
import { selectSummaryFields } from "../lib/summaryFields.ts";
import { formatDate, hostnameFromUrl } from "../lib/format.ts";
import { nextPollDelayMs, pollReducer, type PollState } from "../lib/pollSchedule.ts";
import { translateQueue } from "../lib/translateQueue.ts";
import {
  articleErrorText,
  failClassIsPermanent,
  isDailyLimitFailure,
  isPermanentFailure,
  visitorFailureText,
} from "../lib/failureDisplay.ts";
import { scrollTitleIntoView } from "../lib/scroll.ts";
import { faithfulnessBadgeInfo, faithfulnessCounts } from "../lib/faithfulness.ts";
import { Tooltip } from "./Tooltip.tsx";
import { usePrefersReducedMotion, withMotionClass } from "../lib/motion.ts";
import { pendingCardVariant } from "../lib/agentBatch.ts";

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

// Task 35 Part A §4: in owner-only EN mode, a ready article missing its
// English edition (en_generated_at is null) renders a "preparing English"
// skeleton (see the needsEnglish branch below) instead of blocking on a
// bulk translate. This hook is what makes that skeleton self-resolving: it
// fires POST .../translate for this one card (subject to the shared
// translateQueue's concurrency cap — see lib/translateQueue.ts, "max 5
// concurrently, never in bulk") and polls on the same cadence as
// usePendingPoll (lib/pollSchedule.ts) until en_generated_at appears. A card
// that can't get a queue slot yet still polls without re-triggering the
// endpoint — each tick re-checks the queue, so it opportunistically starts
// its own translate call the moment a slot frees up, without any central
// coordinator besides the shared queue.
function useEnglishTranslation(
  article: ArticleListItem,
  needsEnglish: boolean,
  onArticleUpdate: (article: ArticleListItem) => void,
): void {
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (!needsEnglish) {
      triggeredRef.current = false;
      return;
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let elapsed = 0;
    let cycleStartedAt = Date.now();

    const maybeTrigger = () => {
      if (triggeredRef.current || !translateQueue.canEnqueue(article.id)) return;
      triggeredRef.current = true;
      translateQueue.start(article.id);
      translateArticle(article.id)
        .catch(() => {
          // A failed trigger just means this cycle's polling won't be
          // backed by a fresh job — the existing poll loop below keeps
          // checking regardless, and a later tick may re-trigger once
          // triggeredRef is reset (e.g. on unmount/remount).
        })
        .finally(() => translateQueue.finish(article.id));
    };

    const tick = async () => {
      maybeTrigger();
      try {
        const updated = await getAdminArticle(article.id);
        if (cancelled) return;
        if (updated.en_generated_at) {
          onArticleUpdate({ ...article, ...updated });
          return;
        }
      } catch {
        // Network hiccup — keep polling on the same schedule rather than
        // giving up on a single failed check.
      }
      elapsed += Date.now() - cycleStartedAt;
      const delay = nextPollDelayMs(elapsed);
      if (delay === null || cancelled) return;
      cycleStartedAt = Date.now();
      timerId = setTimeout(tick, delay);
    };

    tick();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [needsEnglish, article.id]);
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
  const reducedMotion = usePrefersReducedMotion();

  // Task 35 Part A §4: EN mode is owner-only (see Header.tsx/App.tsx's
  // effectiveLang) — a ready article that hasn't been translated yet gets a
  // "preparing English" skeleton instead of silently falling back to RU
  // (which selectSummaryFields would otherwise do).
  const needsEnglish = isOwner && lang === "en" && article.status === "ready" &&
    !article.en_generated_at;
  useEnglishTranslation(article, needsEnglish, onArticleUpdate);

  // Task 35 Part C §4: article.image_key is only ever set once /img/:id
  // (index.ts) actually has something to serve — see downloadAndStoreImage
  // (images.ts). imageError is a one-way flag: onError hides the element
  // gracefully for the rest of this card's lifetime rather than retrying, so
  // a broken/expired R2 object doesn't leave a permanently-spinning broken
  // image icon.
  const [imageError, setImageError] = useState(false);
  const hasImage = article.image_key !== null && !imageError;
  const imageUrl = `/img/${article.id}`;

  // Only scroll on the transition INTO expanded — collapsing must stay put
  // (jumpy otherwise), and this only fires on the `expanded` flip, not on
  // every render while already expanded.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (expanded) scrollTitleIntoView(titleRef.current);
  }, [expanded]);

  if (article.status === "pending") {
    // Task 25 Part A: an agent-added pending article is never rendered as
    // its own card — usePendingPoll above still runs (this component stays
    // mounted), so the pending->ready transition is still detected; it's
    // just represented by the aggregate AgentBatchIndicator at the top of
    // the section instead (see Feed.tsx/lib/agentBatch.ts) rather than by
    // ten individual spinner cards.
    if (pendingCardVariant(article) === "hidden") return null;

    // Task 25 Part B: the owner deliberately added this one (manual,
    // extension, or Telegram) and wants "received, working on it"
    // feedback — a skeleton card, never the raw source title (that would
    // flip to the Russian title once summarization finishes, which is
    // exactly the visual noise this task removes).
    const shimmerClass = withMotionClass(
      "skeleton-shimmer",
      "skeleton-shimmer--animated",
      reducedMotion,
    );
    return (
      <article class="card card--skeleton">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <div class={shimmerClass} aria-hidden="true">
          <div class="skeleton-line skeleton-line--title" />
          <div class="skeleton-line skeleton-line--body" />
          <div class="skeleton-line skeleton-line--body skeleton-line--short" />
          <div class="skeleton-tags-row">
            <span class="skeleton-pill" />
            <span class="skeleton-pill" />
          </div>
        </div>
        {givenUpPolling
          ? (
            <div class="pending-stuck-note">
              <span>{dict.pendingStuckLabel}</span>
              <button type="button" class="check-now-button" onClick={checkNow}>
                {dict.checkNowButton}
              </button>
            </div>
          )
          : <p class="pending-processing-caption">{dict.pendingProcessingCaption}</p>}
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

  if (needsEnglish) {
    const shimmerClass = withMotionClass(
      "skeleton-shimmer",
      "skeleton-shimmer--animated",
      reducedMotion,
    );
    return (
      <article class="card card--skeleton">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <div class={shimmerClass} aria-hidden="true">
          <div class="skeleton-line skeleton-line--title" />
          <div class="skeleton-line skeleton-line--body" />
          <div class="skeleton-line skeleton-line--body skeleton-line--short" />
        </div>
        <p class="pending-processing-caption">{dict.preparingEnglishLabel}</p>
      </article>
    );
  }

  const fields = selectSummaryFields(article.title, article.summary_json, lang);
  const source = article.source;
  // Task 25 Part A point 2: a card that just finished (pending->ready,
  // whether an agent-batch member or an owner add) gets a gentle
  // slide+fade-in on top of the existing highlight glow — skipped
  // entirely under prefers-reduced-motion via withMotionClass, so a
  // reduced-motion visitor just sees the final state appear, no motion.
  const cardClass = `card${isPickOfDay ? " card--highlighted" : ""}${
    justReady ? ` ${withMotionClass("card--just-ready", "card--slide-fade-in", reducedMotion)}` : ""
  }`;

  // 'pass' and null (check disabled/not run) get no badge at all — only
  // 'weak'/'fail' are worth a reader's attention (see faithfulnessBadgeInfo
  // in lib/faithfulness.ts). Shown in BOTH owner and visitor mode
  // (transparency is the point); the per-claim detail line below it is
  // owner-only. The tooltip (Task 34 Part B) explains what the badge
  // means, for everyone — a shared trailing line names the check as a
  // separate AI judge, distinct from the summary itself.
  const verdict = article.faithfulness_verdict;
  const badgeInfo = faithfulnessBadgeInfo(dict, verdict);
  const faithfulnessBadgeText = badgeInfo?.badgeText ?? null;
  const faithfulnessDetailCounts = faithfulnessCounts(article.faithfulness_json);

  return (
    <article class={cardClass} aria-expanded={expanded}>
      {(isPickOfDay || badgeInfo) && (
        <div class="card-badges-row">
          {isPickOfDay && <span class="pick-chip">{dict.pickOfDay}</span>}
          {badgeInfo && (
            <Tooltip
              text={badgeInfo.tooltipText}
              trigger={
                <span class={`faithfulness-badge faithfulness-badge--${verdict}`}>
                  {badgeInfo.badgeText}
                </span>
              }
            />
          )}
        </div>
      )}
      <div class="card-date">{formatDate(article.added_at, lang)}</div>

      <div class={!expanded && hasImage ? "card-collapsed-row" : undefined}>
        <div class={!expanded && hasImage ? "card-collapsed-text" : undefined}>
          <button
            type="button"
            class="card-title-button"
            onClick={() => onToggleExpand(article.id)}
          >
            <h3 class="card-title" ref={titleRef}>{fields.title}</h3>
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
        </div>

        {!expanded && hasImage && (
          <img
            class="card-thumb"
            src={imageUrl}
            alt={dict.imageAlt}
            width={112}
            height={84}
            loading="lazy"
            decoding="async"
            onError={() => setImageError(true)}
          />
        )}
      </div>

      {expanded && (
        <div class="card-expanded-body">
          {hasImage && (
            <>
              <img
                class="card-expanded-image"
                src={imageUrl}
                alt={dict.imageAlt}
                width={800}
                height={320}
                loading="lazy"
                decoding="async"
                onError={() => setImageError(true)}
              />
              {article.image_source_url && hostnameFromUrl(article.image_source_url) && (
                <p class="card-image-caption">
                  {dict.imageSourcePrefix}: {hostnameFromUrl(article.image_source_url)}
                </p>
              )}
            </>
          )}
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
            <div class="key-takeaways">
              <p class="key-takeaways-heading">{dict.keyTakeawaysHeading}</p>
              <ul class="bullet-list">
                {fields.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
              </ul>
            </div>
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
            {isOwner && faithfulnessBadgeText && faithfulnessDetailCounts && (
              <p class="card-footer-text faithfulness-footnote">
                {dict.faithfulnessDetailLabel}: {faithfulnessBadgeText} —{" "}
                {dict.faithfulnessUnsupportedLabel} {faithfulnessDetailCounts.unsupported},{" "}
                {dict.faithfulnessContradictedLabel} {faithfulnessDetailCounts.contradicted}
              </p>
            )}
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
