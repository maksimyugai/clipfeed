import { useEffect, useRef, useState } from "preact/hooks";
import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { viaLabel } from "../i18n.ts";
import { getAdminArticle, getArticle, translateArticle } from "../api.ts";
import { selectSummaryFields } from "../lib/summaryFields.ts";
import { formatDate, hostnameFromUrl } from "../lib/format.ts";
import { nextPollDelayMs, type PollState } from "../lib/pollSchedule.ts";
import { translateQueue } from "../lib/translateQueue.ts";
import {
  hasEnglish,
  shouldForgetTranslationRequest,
  shouldRequestTranslation,
} from "../lib/englishGate.ts";
import {
  articleErrorText,
  failClassIsPermanent,
  isDailyLimitFailure,
  isPermanentFailure,
  visitorFailureText,
} from "../lib/failureDisplay.ts";
import { scrollTitleIntoView } from "../lib/scroll.ts";
import { faithfulnessCounts, visibleFaithfulnessBadgeInfo } from "../lib/faithfulness.ts";
import { Tooltip } from "./Tooltip.tsx";
import { usePrefersReducedMotion, withMotionClass } from "../lib/motion.ts";
import { pendingCardVariant } from "../lib/agentBatch.ts";

const JUST_READY_HIGHLIGHT_MS = 2000;

// Task 41 Part A: no longer polls the network itself — a single feed-level
// poll (App.tsx's feed-poll effect, see lib/feedPoll.ts) refreshes every
// pending card from one shared snapshot on the same fast-then-slow cadence,
// replacing what used to be one GET /api/articles/:id per pending card every
// 4-10s. Every feed-poll tick also re-renders every mounted card (a fresh
// `articles` array reference from App.tsx), so this hook doesn't need its
// own timer either — it only needs to remember when THIS card's current
// pending episode started, then derive "given up" from elapsed time on each
// render using the same give-up budget as before (see pollSchedule.ts's
// nextPollDelayMs). The manual "Check now" button still fetches this one
// article directly, unaffected by any of the above.
function usePendingPoll(
  article: ArticleListItem,
  onUpdate: (article: ArticleListItem) => void,
): { pollState: PollState; checkNow: () => void } {
  // Starts (or restarts) the clock exactly when a pending episode begins —
  // covers both first-mount-while-pending and a later resummarize/retry that
  // flips status back to 'pending' after having been ready/failed.
  const pendingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    pendingSinceRef.current = article.status === "pending" ? Date.now() : null;
  }, [article.id, article.status]);

  const elapsed = pendingSinceRef.current === null ? 0 : Date.now() - pendingSinceRef.current;
  const pollState: PollState = nextPollDelayMs(elapsed) === null ? "given-up" : "polling";

  const checkNow = () => {
    getArticle(article.id).then((updated) => {
      if (updated.status !== "pending") {
        // getArticle() returns the public shape (has_error, no raw error
        // string) — merge onto the existing list item so `error` survives
        // (it was already null while pending; a newly-failed article shows
        // the generic "—" fallback until the next full list fetch).
        onUpdate({ ...article, ...updated });
      }
    }, () => {});
  };

  return { pollState, checkNow };
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

// Task 37 §6: in owner-only EN mode, a ready article missing its English
// edition (see hasEnglish in lib/englishGate.ts — en_generated_at set, or a
// pre-Task-35 row that already carries _en fields) eventually renders a
// "preparing English" skeleton — but ONLY once this specific card has actually been
// reached, never for the whole fetched list at once (that was the reported
// bug: every mounted card used to request a translation the instant
// needsEnglish became true). "Reached" means either the card scrolled into
// the viewport (IntersectionObserver, rootMargin ~200px so it starts
// slightly before) or the reader expanded it (which translates immediately,
// bypassing the observer — see the `expanded` effect below). The actual
// network call is gated by the shared translateQueue (lib/translateQueue.ts,
// now a real FIFO queue capped at 3 in flight, not a bare slot counter).
// Returns whether THIS card is currently queued/in-flight/awaiting
// completion — the caller uses that to decide whether to paint the skeleton
// or fall back to normal (Russian) rendering for a not-yet-reached card.
function useEnglishTranslation(
  article: ArticleListItem,
  needsEnglish: boolean,
  expanded: boolean,
  cardRef: { current: HTMLElement | null },
  onArticleUpdate: (article: ArticleListItem) => void,
): boolean {
  const [isTranslating, setIsTranslating] = useState(false);
  const isTranslatingRef = useRef(false);
  // Keyed on the article actually having English now, not on needsEnglish —
  // see shouldForgetTranslationRequest's doc comment: needsEnglish also
  // flips false on a plain lang-mode toggle away from "en", which must NOT
  // forget that a request already went out.
  const articleHasEnglish = hasEnglish(article);

  useEffect(() => {
    if (shouldForgetTranslationRequest(articleHasEnglish)) {
      isTranslatingRef.current = false;
      setIsTranslating(false);
    }
  }, [articleHasEnglish]);

  const requestTranslation = (priority: boolean) => {
    if (!shouldRequestTranslation(needsEnglish, isTranslatingRef.current)) return;
    isTranslatingRef.current = true;
    setIsTranslating(true);
    translateQueue.request(
      article.id,
      () => translateArticle(article.id).then(() => undefined, () => undefined),
      { priority },
    );
  };

  // Priority: the reader is looking at this card right now.
  useEffect(() => {
    if (needsEnglish && expanded) requestTranslation(true);
  }, [needsEnglish, expanded, article.id]);

  // Viewport gate: only ask once the card is actually on (or near) screen.
  // Disconnects itself the moment a request is made — by this observer
  // firing, or by the expanded-priority effect above already having
  // claimed it (the `isTranslating` dependency below then skips re-creating
  // it).
  useEffect(() => {
    if (!needsEnglish || isTranslating || expanded) return;
    const node = cardRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          requestTranslation(false);
          observer.disconnect();
        }
      },
      { rootMargin: "200px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [needsEnglish, isTranslating, expanded, article.id]);

  // If this card is unmounted while still merely queued (waiting for a
  // slot) — the reader filtered or navigated it away before its turn came
  // up — drop its own queue entry so it doesn't fire once nothing shows its
  // result anymore. A no-op once the request is already in flight; that one
  // is left to finish (see translateQueue.cancel's own doc comment).
  useEffect(() => {
    if (!isTranslating) return;
    return () => translateQueue.cancel(article.id);
  }, [isTranslating, article.id]);

  // Once triggered, poll on the same cadence as usePendingPoll
  // (lib/pollSchedule.ts) until en_generated_at appears — the POST above
  // only enqueues the actual translate job (see queue.ts), it doesn't wait
  // for it.
  useEffect(() => {
    if (!isTranslating) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let elapsed = 0;
    let cycleStartedAt = Date.now();

    const tick = async () => {
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
  }, [isTranslating, article.id]);

  return isTranslating;
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
  // effectiveLang) — a ready article that hasn't been translated yet
  // eventually gets a "preparing English" skeleton instead of silently
  // falling back to RU forever. Task 37 §6: that skeleton now only shows
  // once THIS card has actually been reached (see isTranslating below) —
  // until then it renders normally, in Russian (see effectiveContentLang).
  // Task 40: "hasn't been translated yet" is hasEnglish(article), not just
  // en_generated_at — a pre-Task-35 row can already carry real _en fields
  // with a null en_generated_at (see englishGate.ts), and treating that as
  // "needs English" caused a translate call to fire for every such row on
  // every EN-mode viewport pass.
  const needsEnglish = isOwner && lang === "en" && article.status === "ready" &&
    !hasEnglish(article);
  const cardRef = useRef<HTMLElement>(null);
  const isTranslating = useEnglishTranslation(
    article,
    needsEnglish,
    expanded,
    cardRef,
    onArticleUpdate,
  );
  // A needsEnglish card not yet reached shows its Russian content — never a
  // blank/empty render (selectSummaryFields would otherwise pick the still-
  // missing EN fields) and never the skeleton (that's reserved for a card
  // actually queued/in-flight, see the needsEnglish-and-isTranslating branch
  // below).
  const effectiveContentLang: Lang = needsEnglish ? "ru" : lang;

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
    // Task 41 Part D: a visitor never has a pending row to begin with (the
    // public API is ready-only) — this is a defensive belt, not the primary
    // guard, in case local state ever ends up holding one anyway.
    if (!isOwner) return null;

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
    // Task 41 Part D: a visitor never has a failed row to begin with (the
    // public API is ready-only) — this is a defensive belt, not the primary
    // guard, in case local state ever ends up holding one anyway. A failed
    // card ("Ошибка: timeout: processing did not complete") was making the
    // public feed look broken; the fix is server-side (see index.ts), this
    // is just the SPA not silently relying on that alone.
    if (!isOwner) return null;

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

  if (needsEnglish && isTranslating) {
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

  const fields = selectSummaryFields(article.title, article.summary_json, effectiveContentLang);
  const source = article.source;
  // Task 25 Part A point 2: a card that just finished (pending->ready,
  // whether an agent-batch member or an owner add) gets a gentle
  // slide+fade-in on top of the existing highlight glow — skipped
  // entirely under prefers-reduced-motion via withMotionClass, so a
  // reduced-motion visitor just sees the final state appear, no motion.
  const cardClass = `card${isPickOfDay ? " card--highlighted" : ""}${
    justReady ? ` ${withMotionClass("card--just-ready", "card--slide-fade-in", reducedMotion)}` : ""
  }`;

  // Task 42 Part B: the badge is now internal quality instrumentation, not
  // a reader-facing disclaimer — a visitor comes to read, not to audit the
  // pipeline, and the old copy implied doubt about the ORIGINAL article
  // rather than our own summary. Owner-mode only, for both 'weak' and
  // 'fail' ('pass'/null still get nothing at all, as before). The
  // per-claim detail line further below stays owner-only too, unchanged.
  const verdict = article.faithfulness_verdict;
  const badgeInfo = visibleFaithfulnessBadgeInfo(dict, verdict, isOwner);
  const faithfulnessBadgeText = badgeInfo?.badgeText ?? null;
  const faithfulnessDetailCounts = faithfulnessCounts(article.faithfulness_json);

  return (
    <article class={cardClass} aria-expanded={expanded} ref={cardRef}>
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
