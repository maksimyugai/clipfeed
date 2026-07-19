import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
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
  onArticleUpdate: (article: ArticleListItem) => void;
  hasMore: boolean;
  onShowMore: () => void;
  loadingMore: boolean;
  archivedView: boolean;
  pickOfDayId: string | null;
}

export function Feed(props: FeedProps) {
  const { dict, articles, hasMore, onShowMore, loadingMore, archivedView } = props;

  if (articles.length === 0) {
    return (
      <div class="empty-state">
        <p class="empty-state-title">
          {archivedView ? dict.emptyArchiveTitle : dict.emptyFeedTitle}
        </p>
        {!archivedView && <p class="empty-state-hint">{dict.emptyFeedHint}</p>}
      </div>
    );
  }

  return (
    <div>
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
            onArticleUpdate={props.onArticleUpdate}
          />
        ))}
      </div>

      {hasMore && (
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
    </div>
  );
}
