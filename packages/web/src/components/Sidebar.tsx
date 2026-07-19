import type { Dictionary } from "../i18n.ts";

export interface TagFacet {
  tag: string;
  count: number;
}

export interface SourceFacet {
  source: string;
  count: number;
}

export interface SidebarProps {
  dict: Dictionary;
  tags: TagFacet[];
  activeTag: string | null;
  onTagClick: (tag: string | null) => void;
  sources: SourceFacet[];
  activeSource: string | null;
  onSourceClick: (source: string | null) => void;
  totalCount: number;
  archivedView: boolean;
  onArchiveToggle: () => void;
}

export function TopicPills(
  { dict, tags, activeTag, onTagClick }: Pick<
    SidebarProps,
    "dict" | "tags" | "activeTag" | "onTagClick"
  >,
) {
  return (
    <div class="pill-group" role="group">
      <button
        type="button"
        class={`pill${activeTag === null ? " pill--active" : ""}`}
        aria-pressed={activeTag === null}
        onClick={() => onTagClick(null)}
      >
        {dict.sidebarAllPill}
      </button>
      {tags.map(({ tag, count }) => (
        <button
          key={tag}
          type="button"
          class={`pill${activeTag === tag ? " pill--active" : ""}`}
          aria-pressed={activeTag === tag}
          onClick={() => onTagClick(activeTag === tag ? null : tag)}
        >
          {tag} ({count})
        </button>
      ))}
    </div>
  );
}

export function SourcePills(
  { sources, activeSource, onSourceClick }: Pick<
    SidebarProps,
    "sources" | "activeSource" | "onSourceClick"
  >,
) {
  return (
    <>
      {sources.map(({ source, count }) => (
        <button
          key={source}
          type="button"
          class={`pill${activeSource === source ? " pill--active" : ""}`}
          aria-pressed={activeSource === source}
          onClick={() => onSourceClick(activeSource === source ? null : source)}
        >
          {source} ({count})
        </button>
      ))}
    </>
  );
}

export function Sidebar(
  {
    dict,
    tags,
    activeTag,
    onTagClick,
    sources,
    activeSource,
    onSourceClick,
    totalCount,
    archivedView,
    onArchiveToggle,
  }: SidebarProps,
) {
  return (
    <aside class="sidebar">
      <div class="sidebar-section">
        <TopicPills dict={dict} tags={tags} activeTag={activeTag} onTagClick={onTagClick} />
      </div>

      <div class="sidebar-section">
        <h2 class="sidebar-heading">{dict.sidebarSourcesHeading}</h2>
        <ul class="source-list">
          {sources.map(({ source, count }) => (
            <li key={source}>
              <button
                type="button"
                class="source-item"
                aria-pressed={activeSource === source}
                onClick={() => onSourceClick(activeSource === source ? null : source)}
              >
                <span>{source}</span>
                <span class="source-count">{count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div class="sidebar-section stat-card">
        <div class="stat-value">{totalCount}</div>
        <div class="stat-label">{dict.sidebarTotalArticles}</div>
      </div>

      <button type="button" class="archive-link" onClick={onArchiveToggle}>
        {archivedView ? dict.sidebarBackToFeed : dict.sidebarArchiveLink}
      </button>
    </aside>
  );
}
