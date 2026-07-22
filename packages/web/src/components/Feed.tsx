import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { DATE_SECTIONS, type DateSection, groupArticlesBySection } from "../lib/dateGrouping.ts";
import { isSectionOpenTodayEmptyAware, type SectionOpenState } from "../lib/sectionState.ts";
import { scrollElementIntoView } from "../lib/scroll.ts";
import { computeAgentBatchIndicator, shouldShowEmptyCountdown } from "../lib/agentBatch.ts";
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
  isSearching: boolean;
  agentHourUtc: number | null;
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
    agentHourUtc,
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
  // Task 24 Part D: Today keeps rendering (with its live countdown card)
  // even at zero articles — overriding the hide-empty-sections rule below
  // for "today" specifically — but only in the normal feed view; an
  // archived view showing "new articles soon" would be nonsensical, and the
  // all-articles-empty case above already has its own dedicated empty state.
  //
  // Task 25 precedence: shouldShowEmptyCountdown accounts for the case
  // where Today has agent-pending articles but nothing visible YET (they
  // render as null — see ArticleCard.tsx's Part A branch) — in that case
  // the AgentBatchIndicator below takes over the "something is happening"
  // signal instead of the countdown (see lib/agentBatch.ts's doc comment).
  const todayIsEmpty = !archivedView && shouldShowEmptyCountdown(grouped.today);

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

        const open = isSectionOpenTodayEmptyAware(section, sectionOpen, isSearching, todayIsEmpty);
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

                {agentBatch.visible && (
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
