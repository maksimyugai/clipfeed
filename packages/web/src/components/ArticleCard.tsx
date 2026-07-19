import { useEffect, useState } from "preact/hooks";
import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { viaLabel } from "../i18n.ts";
import { getArticle } from "../api.ts";
import { selectSummaryFields } from "../lib/summaryFields.ts";
import { formatDate } from "../lib/format.ts";

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_ATTEMPTS = 30; // ~2 minutes of visible time at 4s/poll

// Polls GET /api/articles/:id while status is 'pending', pausing while the
// tab is hidden (via visibilitychange) so it doesn't burn through the
// attempt budget or make requests nobody can see the result of.
function usePendingPoll(
  article: ArticleListItem,
  onUpdate: (article: ArticleListItem) => void,
): boolean {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (article.status !== "pending") return;

    let attempts = 0;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const stopInterval = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    const tick = async () => {
      attempts += 1;
      try {
        const updated = await getArticle(article.id);
        if (cancelled) return;
        if (updated.status !== "pending") {
          stopInterval();
          // getArticle() returns the public shape (has_error, no raw error
          // string) — merge onto the existing list item so `error` survives
          // (it was already null while pending; a newly-failed article
          // shows the generic "—" fallback until the next full list fetch).
          onUpdate({ ...article, ...updated });
          return;
        }
      } catch {
        // Transient network error — keep trying until the attempt budget runs out.
      }
      if (attempts >= MAX_POLL_ATTEMPTS) {
        stopInterval();
        setStuck(true);
      }
    };

    const startInterval = () => {
      if (intervalId === undefined) {
        intervalId = setInterval(tick, POLL_INTERVAL_MS);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopInterval();
      } else {
        startInterval();
      }
    };

    if (!document.hidden) startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [article.id, article.status]);

  return stuck;
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

  const stuck = usePendingPoll(article, onArticleUpdate);

  if (article.status === "pending") {
    return (
      <article class="card card--pending">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <h3 class="card-title">{article.title}</h3>
        <div class="pending-row">
          <span class="spinner" aria-hidden="true" />
          <span>{dict.pendingLabel}</span>
        </div>
        {stuck && <div class="pending-stuck-note">{dict.pendingStuckLabel}</div>}
      </article>
    );
  }

  if (article.status === "failed") {
    return (
      <article class="card card--failed">
        <div class="card-date">{formatDate(article.added_at, lang)}</div>
        <h3 class="card-title">{article.title}</h3>
        <p class="error-text">{dict.errorPrefix}: {article.error ?? "—"}</p>
        {isOwner && (
          <div class="card-failed-actions">
            <button type="button" class="retry-button" onClick={() => onRetry(article.id)}>
              {dict.retryButton}
            </button>
            <button
              type="button"
              class="delete-button-outline"
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
  const cardClass = `card${isPickOfDay ? " card--highlighted" : ""}`;

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
