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
  onClearAll: () => void;
  sources: SourceFacet[];
  activeSource: string | null;
  onSourceClick: (source: string | null) => void;
  totalCount: number;
  archivedView: boolean;
  onArchiveToggle: () => void;
  isOwner: boolean;
}

export function TopicPills(
  { dict, tags, activeTag, onTagClick, onClearAll }: Pick<
    SidebarProps,
    "dict" | "tags" | "activeTag" | "onTagClick" | "onClearAll"
  >,
) {
  return (
    <div class="pill-group" role="group">
      <button
        type="button"
        class={`pill${activeTag === null ? " pill--active" : ""}`}
        aria-pressed={activeTag === null}
        onClick={onClearAll}
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

// Dismissible chips summarizing the currently active tag/source filters —
// rendered above the feed so there's always a visible, one-click way back
// to an unfiltered view without relying on the "все"/"all" pill being in
// sight (it scrolls out of view in the sidebar, and isn't shown at all on
// mobile once the filter row is scrolled past). Renders nothing when
// neither filter is active.
export interface ActiveFilterChipsProps {
  activeTag: string | null;
  activeSource: string | null;
  onClearTag: () => void;
  onClearSource: () => void;
  clearTagAria: string;
  clearSourceAria: string;
}

export function ActiveFilterChips(
  { activeTag, activeSource, onClearTag, onClearSource, clearTagAria, clearSourceAria }:
    ActiveFilterChipsProps,
) {
  if (activeTag === null && activeSource === null) return null;

  return (
    <div class="active-filters-row">
      {activeTag !== null && (
        <button
          type="button"
          class="pill pill--active filter-chip"
          aria-label={clearTagAria}
          onClick={onClearTag}
        >
          {activeTag} <span aria-hidden="true">✕</span>
        </button>
      )}
      {activeSource !== null && (
        <button
          type="button"
          class="source-pill filter-chip"
          aria-label={clearSourceAria}
          onClick={onClearSource}
        >
          🌐 {activeSource} <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  );
}

export function Sidebar(
  {
    dict,
    tags,
    activeTag,
    onTagClick,
    onClearAll,
    sources,
    activeSource,
    onSourceClick,
    totalCount,
    archivedView,
    onArchiveToggle,
    isOwner,
  }: SidebarProps,
) {
  return (
    <aside class="sidebar">
      <div class="sidebar-section">
        <TopicPills
          dict={dict}
          tags={tags}
          activeTag={activeTag}
          onTagClick={onTagClick}
          onClearAll={onClearAll}
        />
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

      {isOwner && (
        <button type="button" class="archive-link" onClick={onArchiveToggle}>
          {archivedView ? dict.sidebarBackToFeed : dict.sidebarArchiveLink}
        </button>
      )}
    </aside>
  );
}
