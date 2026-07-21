import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { DATE_SECTIONS, type DateSection, groupArticlesBySection } from "../lib/dateGrouping.ts";
import { isSectionOpen, type SectionOpenState } from "../lib/sectionState.ts";
import { ArticleCard } from "./ArticleCard.tsx";

export interface FeedProps {
  dict: Dictionary;
  lang: Lang;
  articles: ArticleListItem[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onTagClick: (tag: string) => void;
  onSourceClick: (source: string) => void;
  onArchiveToggle: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onResummarize: (id: string) => void;
  onArticleUpdate: (article: ArticleListItem) => void;
  hasMore: boolean;
  onShowMore: () => void;
  loadingMore: boolean;
  archivedView: boolean;
  pickOfDayId: string | null;
  isOwner: boolean;
  sectionOpen: SectionOpenState;
  onToggleSection: (section: DateSection) => void;
  isSearching: boolean;
}

export function Feed(props: FeedProps) {
  const {
    dict,
    articles,
    hasMore,
    onShowMore,
    loadingMore,
    archivedView,
    isOwner,
    sectionOpen,
    onToggleSection,
    isSearching,
  } = props;

  if (articles.length === 0) {
    return (
      <div class="empty-state">
        <p class="empty-state-title">
          {archivedView ? dict.emptyArchiveTitle : dict.emptyFeedTitle}
        </p>
        {!archivedView && (
          <p class="empty-state-hint">{isOwner ? dict.emptyFeedHint : dict.visitorFeedHint}</p>
        )}
      </div>
    );
  }

  const grouped = groupArticlesBySection(articles);
  const sectionLabel: Record<DateSection, string> = {
    today: dict.sectionToday,
    yesterday: dict.sectionYesterday,
    earlier: dict.sectionEarlier,
  };

  return (
    <div class="feed-sections">
      {DATE_SECTIONS.map((section) => {
        const items = grouped[section];
        // "Earlier" stays visible (collapsed, empty) as long as there's
        // more data the user hasn't fetched yet — otherwise there'd be no
        // way to discover it exists. Today/Yesterday are fully loaded by
        // the time this renders, so an empty bucket for them really is
        // empty and hides entirely.
        const isEarlierPending = section === "earlier" && items.length === 0 && hasMore;
        if (items.length === 0 && !isEarlierPending) return null;

        const open = isSectionOpen(section, sectionOpen, isSearching);

        return (
          <div class="feed-section" key={section}>
            <button
              type="button"
              class="feed-section-header"
              aria-expanded={open}
              onClick={() => onToggleSection(section)}
            >
              <span class="feed-section-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
              <span class="feed-section-label">{sectionLabel[section]}</span>
              <span class="feed-section-count">{items.length}</span>
            </button>

            {open && (
              <>
                {items.length > 0 && (
                  <div class="feed">
                    {items.map((article) => (
                      <ArticleCard
                        key={article.id}
                        dict={props.dict}
                        lang={props.lang}
                        article={article}
                        isPickOfDay={props.pickOfDayId === article.id}
                        expanded={props.expandedId === article.id}
                        onToggleExpand={props.onToggleExpand}
                        onTagClick={props.onTagClick}
                        onSourceClick={props.onSourceClick}
                        onArchiveToggle={props.onArchiveToggle}
                        onDelete={props.onDelete}
                        onRetry={props.onRetry}
                        onResummarize={props.onResummarize}
                        onArticleUpdate={props.onArticleUpdate}
                        isOwner={isOwner}
                      />
                    ))}
                  </div>
                )}

                {section === "earlier" && items.length === 0 && loadingMore && (
                  <div class="section-loading-row">
                    <span class="spinner" aria-hidden="true" />
                  </div>
                )}

                {section === "earlier" && hasMore && (
                  <div class="show-more-row">
                    <button
                      type="button"
                      class="show-more-button"
                      onClick={onShowMore}
                      disabled={loadingMore}
                    >
                      {dict.showMore}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
