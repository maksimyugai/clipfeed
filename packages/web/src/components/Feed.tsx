import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { DATE_SECTIONS, type DateSection, groupArticlesBySection } from "../lib/dateGrouping.ts";
import { isSectionOpenTodayEmptyAware, type SectionOpenState } from "../lib/sectionState.ts";
import { scrollElementIntoView } from "../lib/scroll.ts";
import { computeAgentBatchIndicator, computeTodayIsEmpty } from "../lib/agentBatch.ts";
import { isFlatSemanticView, type SearchMode } from "../lib/searchMode.ts";
import { hasActiveFilters } from "../lib/filterState.ts";
import { ArticleCard } from "./ArticleCard.tsx";
import { TodayEmptyState } from "./TodayEmptyState.tsx";
import { AgentBatchIndicator } from "./AgentBatchIndicator.tsx";

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
  // Carries the section's currently-*effective* open value (as computed by
  // isSectionOpenTodayEmptyAware below), not the raw stored value — see
  // App.tsx's handleToggleSection for why: the raw stored value can be
  // undefined (no explicit choice yet) while the section is still showing
  // open via the Today-empty default, and toggling from the wrong baseline
  // would invert the user's intent on their very first click.
  onToggleSection: (section: DateSection, currentlyOpen: boolean) => void;
  // Task 29 Part B: a deep-linked article's section renders open for this
  // render only, regardless of sectionOpen/its computed default — never
  // written to localStorage (see App.tsx's forceOpenSection state).
  forceOpenSection: DateSection | null;
  isSearching: boolean;
  searchMode: SearchMode;
  agentHourUtc: number | null;
  // Task 29 Part C: whether a tag/source filter is active, so the Today
  // countdown and the generic empty state both know the difference between
  // "genuinely nothing yet" and "the filter excludes everything".
  activeTag: string | null;
  activeSource: string | null;
  onResetFilters: () => void;
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
    forceOpenSection,
    isSearching,
    searchMode,
    agentHourUtc,
    activeTag,
    activeSource,
    onResetFilters,
  } = props;

  // Any active tag/source filter OR a search query counts as "filtered" —
  // under either, an empty result means the filter excludes everything,
  // not that the feed itself has nothing (see computeTodayIsEmpty and the
  // empty-state branch below, both of which key off this).
  const isFilteredView = isSearching || hasActiveFilters({ tag: activeTag, source: activeSource });

  if (articles.length === 0) {
    if (isFilteredView) {
      return (
        <div class="empty-state">
          <p class="empty-state-title">{dict.emptySearchTitle}</p>
          <p class="empty-state-hint">{dict.emptySearchHint}</p>
          <button type="button" class="empty-state-reset" onClick={onResetFilters}>
            {dict.resetFiltersAction}
          </button>
        </div>
      );
    }
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

  // Relevance beats chronology when searching by meaning — see
  // isFlatSemanticView's doc comment in lib/searchMode.ts. Results already
  // arrive ordered by score DESC from GET /api/search, so this is a straight
  // render, no re-sorting here.
  if (isFlatSemanticView(isSearching, searchMode)) {
    const countText =
      `${dict.semanticMatchesPrefix} ${articles.length} ${dict.semanticMatchesSuffix}`;

    return (
      <div class="feed-sections">
        <div class="feed-section">
          <p class="semantic-matches-count">{countText}</p>
          <div class="feed">
            {articles.map((article) => (
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
        </div>
      </div>
    );
  }

  const grouped = groupArticlesBySection(articles);
  const sectionLabel: Record<DateSection, string> = {
    today: dict.sectionToday,
    yesterday: dict.sectionYesterday,
    earlier: dict.sectionEarlier,
  };
  // Task 24 Part D: Today keeps rendering (with its live countdown card)
  // even at zero articles — overriding the hide-empty-sections rule below
  // for "today" specifically — but only in the normal, UNFILTERED feed
  // view; an archived view showing "new articles soon" would be
  // nonsensical, and Task 29 Part C extends that same reasoning to any
  // active tag/source filter or search query — a filter excluding
  // everything isn't "something is being prepared" either. The
  // all-articles-empty case above already has its own dedicated empty
  // state either way.
  //
  // Task 25 precedence (still applies within the unfiltered case):
  // shouldShowEmptyCountdown accounts for Today having agent-pending
  // articles but nothing visible YET (they render as null — see
  // ArticleCard.tsx's Part A branch) — in that case the AgentBatchIndicator
  // below takes over the "something is happening" signal instead of the
  // countdown (see lib/agentBatch.ts's doc comment).
  const todayIsEmpty = computeTodayIsEmpty(archivedView, isFilteredView, grouped.today);

  const handleReadYesterday = () => {
    scrollElementIntoView(document.getElementById("feed-section-yesterday"));
  };

  return (
    <div class="feed-sections">
      {DATE_SECTIONS.map((section) => {
        const items = grouped[section];
        // "Earlier" stays visible (collapsed, empty) as long as there's
        // more data the user hasn't fetched yet — otherwise there'd be no
        // way to discover it exists. "Today" stays visible even fully
        // empty (see todayIsEmpty above). Yesterday is fully loaded by the
        // time this renders, so an empty bucket for it really is empty and
        // hides entirely.
        const isEarlierPending = section === "earlier" && items.length === 0 && hasMore;
        const isTodayEmptyState = section === "today" && todayIsEmpty;
        if (items.length === 0 && !isEarlierPending && !isTodayEmptyState) return null;

        // Task 29 Part B: a deep-linked article's section always renders
        // open, overriding both the persisted choice and the computed
        // default — see App.tsx's forceOpenSection doc comment for why
        // this is deliberately NOT threaded through sectionOpen/localStorage.
        const open = section === forceOpenSection
          ? true
          : isSectionOpenTodayEmptyAware(section, sectionOpen, isSearching, todayIsEmpty);
        // Task 25 Part A: the header count reflects what's actually
        // visible, not the raw row count — an agent-pending row renders as
        // null (see ArticleCard.tsx), so counting it here would show e.g.
        // "12" when only 2 cards and a "0 of 10 ready" indicator are on
        // screen.
        const agentBatch = computeAgentBatchIndicator(items);
        const visibleCount = items.length - (agentBatch.total - agentBatch.ready);

        return (
          <div class="feed-section" key={section} id={`feed-section-${section}`}>
            <button
              type="button"
              class="feed-section-header"
              aria-expanded={open}
              onClick={() => onToggleSection(section, open)}
            >
              <span class="feed-section-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
              <span class="feed-section-label">{sectionLabel[section]}</span>
              <span class="feed-section-count">
                {isTodayEmptyState ? "—" : visibleCount}
              </span>
            </button>

            {open && (
              <>
                {isTodayEmptyState && (
                  <TodayEmptyState
                    dict={dict}
                    agentHourUtc={agentHourUtc}
                    onReadYesterday={handleReadYesterday}
                  />
                )}

                {agentBatch.visible && isOwner && (
                  <AgentBatchIndicator
                    dict={dict}
                    lang={props.lang}
                    ready={agentBatch.ready}
                    total={agentBatch.total}
                  />
                )}

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
