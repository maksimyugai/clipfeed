import { useState } from "preact/hooks";
import type { ArticleListItem } from "@clipfeed/shared/types";
import type { Dictionary, Lang } from "../i18n.ts";
import { ArticleCard } from "./ArticleCard.tsx";

export interface DeepLinkedArticleProps {
  dict: Dictionary;
  lang: Lang;
  article: ArticleListItem;
  isOwner: boolean;
  onBackToFeed: () => void;
  onTagClick: (tag: string) => void;
  onSourceClick: (source: string) => void;
  onArchiveToggle: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onResummarize: (id: string) => void;
  onArticleUpdate: (article: ArticleListItem) => void;
}

// Rendered instead of the normal Feed when a Telegram drip post's deep link
// (#article-<id>, see lib/deepLink.ts) points at an article that isn't in
// the currently loaded page(s) — fetched standalone (see App.tsx) and shown
// as its own focused card, with a link back to the ordinary feed view
// rather than an unbounded "keep paging until we find it" fetch loop.
export function DeepLinkedArticle(props: DeepLinkedArticleProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div class="deep-link-focus">
      <ArticleCard
        dict={props.dict}
        lang={props.lang}
        article={props.article}
        isPickOfDay={false}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        onTagClick={props.onTagClick}
        onSourceClick={props.onSourceClick}
        onArchiveToggle={props.onArchiveToggle}
        onDelete={props.onDelete}
        onRetry={props.onRetry}
        onResummarize={props.onResummarize}
        onArticleUpdate={props.onArticleUpdate}
        isOwner={props.isOwner}
      />
      <button type="button" class="back-to-feed-link" onClick={props.onBackToFeed}>
        {props.dict.backToFeedLink}
      </button>
    </div>
  );
}
