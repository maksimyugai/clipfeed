import { useEffect, useMemo, useReducer, useState } from "preact/hooks";
import type { AddedVia, ArticleListItem } from "@clipfeed/shared/types";
import { dictionaries, type Lang, readStoredLang, writeStoredLang } from "./i18n.ts";
import { useTheme } from "./theme.ts";
import {
  ApiError,
  type ArticlesQueryParams,
  createArticle,
  deleteArticle,
  getAdminMe,
  listAdminArticles,
  listArticles,
  patchArticle,
  resummarizeArticle,
  retryArticle,
} from "./api.ts";
import { canMutate, classifyMeOutcome } from "./ownerMode.ts";
import { isPickOfTheDay } from "./lib/pickOfTheDay.ts";
import { EMPTY_FILTER_STATE, filterReducer } from "./lib/filterState.ts";
import { type DateSection, groupArticlesBySection } from "./lib/dateGrouping.ts";
import {
  readStoredSectionState,
  type SectionOpenState,
  writeStoredSectionState,
} from "./lib/sectionState.ts";
import { shouldFetchNextInitialPage, shouldFetchOnEarlierExpand } from "./lib/pagination.ts";
import { loadAgentSchedule } from "./lib/agentSchedule.ts";
import { Header } from "./components/Header.tsx";
import { AddModal } from "./components/AddModal.tsx";
import { ActiveFilterChips, Sidebar, SourcePills, TopicPills } from "./components/Sidebar.tsx";
import { Feed } from "./components/Feed.tsx";
import { Toast } from "./components/Toast.tsx";

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 20;
// Safety valve for the initial "keep fetching until Today+Yesterday are
// covered" loop (see the effect below) — real daily volume is nowhere near
// this many pages (DAILY_SUMMARY_LIMIT caps it well under 100/day), so this
// only guards against a pathological/misconfigured dataset ever turning
// into an unbounded fetch loop.
const MAX_INITIAL_PAGES = 25;

function computeTagFacets(articles: ArticleListItem[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    for (const tag of article.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Owner mode fetches the full row (real `error`/`faithfulness_json`
// included) from /api/admin/articles; visitor mode fetches the redacted
// public shape from /api/articles and fills in `error: null` and
// `faithfulness_json: null` since neither is genuinely available —
// ArticleCard never renders either field directly in visitor mode (error
// uses fail_class instead, which both shapes carry; faithfulness_json's
// per-claim detail is owner-mode-only, see ArticleCard's
// faithfulness-footnote), so these nulls are inert, not a re-introduction
// of the stale-empty-error bug this same field once had.
async function fetchArticleList(
  isOwner: boolean,
  params: ArticlesQueryParams,
): Promise<{ items: ArticleListItem[]; next_cursor: string | null }> {
  if (isOwner) return await listAdminArticles(params);
  const res = await listArticles(params);
  return {
    items: res.items.map((item) => ({ ...item, error: null, faithfulness_json: null })),
    next_cursor: res.next_cursor,
  };
}

function computeSourceFacets(articles: ArticleListItem[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    if (!article.source) continue;
    counts.set(article.source, (counts.get(article.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function App() {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang(localStorage));
  const [theme, toggleTheme] = useTheme();
  const dict = dictionaries[lang];

  const [searchInput, setSearchInput] = useState("");
  const [filters, dispatchFilter] = useReducer(filterReducer, EMPTY_FILTER_STATE);
  const { tag: activeTag, source: activeSource, query } = filters;
  const [archivedView, setArchivedView] = useState(false);

  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [ownerModeState, setOwnerModeState] = useState<"loading" | "owner" | "visitor">(
    "loading",
  );
  const isOwner = canMutate(ownerModeState);
  const [sectionOpen, setSectionOpen] = useState<SectionOpenState>(() =>
    readStoredSectionState(localStorage)
  );
  const [agentHourUtc, setAgentHourUtc] = useState<number | null>(null);

  const setLang = (next: Lang) => {
    setLangState(next);
    writeStoredLang(localStorage, next);
  };

  const showError = (err: unknown) => {
    const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    setToastMessage(`${dict.toastErrorPrefix}: ${message}`);
  };

  // The instance is public-read: this only decides which owner-only
  // controls to show (add/archive/delete/retry, the archive toggle) — a
  // visitor's 401 here is expected, not an error to surface as a toast.
  // Re-runs on every fresh load, including the one after a top-level
  // navigation back from /api/admin/login.
  useEffect(() => {
    getAdminMe()
      .then(() => setOwnerModeState(classifyMeOutcome("success")))
      .catch(() => setOwnerModeState(classifyMeOutcome("error")));
  }, []);

  // Powers the empty-Today countdown card (see Feed.tsx/TodayEmptyState.tsx)
  // — fetched once and cached (see loadAgentSchedule), same as the
  // Turnstile site key fetch elsewhere.
  useEffect(() => {
    loadAgentSchedule().then((config) => setAgentHourUtc(config.agentHourUtc));
  }, []);

  // Debounce the raw search input into the value that actually drives fetches.
  useEffect(() => {
    const timer = setTimeout(
      () => dispatchFilter({ type: "set-query", query: searchInput }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Any filter change is a fresh query: reset pagination and refetch until
  // Today+Yesterday are fully covered (see shouldFetchNextInitialPage) —
  // "Earlier" stays lazy from there, loaded on section-expand/show-more
  // instead (see handleToggleSection/handleShowMore below). Also re-runs
  // once ownerModeState resolves from "loading" — the very first fetch
  // (before /api/admin/me settles) always uses the visitor path, so an
  // owner's feed needs this second pass to pick up the admin-list endpoint
  // instead.
  useEffect(() => {
    let cancelled = false;
    setExpandedId(null);

    (async () => {
      let cursor: string | undefined;
      let accumulated: ArticleListItem[] = [];
      for (let page = 0; page < MAX_INITIAL_PAGES; page++) {
        const res = await fetchArticleList(isOwner, {
          limit: PAGE_LIMIT,
          cursor,
          tag: activeTag ?? undefined,
          source: activeSource ?? undefined,
          q: query || undefined,
          archived: archivedView,
        });
        if (cancelled) return;
        accumulated = accumulated.concat(res.items);
        setArticles(accumulated);
        setNextCursor(res.next_cursor);
        if (!shouldFetchNextInitialPage(res.items, res.next_cursor)) break;
        cursor = res.next_cursor ?? undefined;
      }
    })().catch((err) => {
      if (!cancelled) showError(err);
    });

    return () => {
      cancelled = true;
    };
  }, [query, activeTag, activeSource, archivedView, isOwner]);

  const handleShowMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchArticleList(isOwner, {
        limit: PAGE_LIMIT,
        cursor: nextCursor,
        tag: activeTag ?? undefined,
        source: activeSource ?? undefined,
        q: query || undefined,
        archived: archivedView,
      });
      setArticles((current) => [...current, ...res.items]);
      setNextCursor(res.next_cursor);
    } catch (err) {
      showError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleToggleSection = (section: DateSection) => {
    setSectionOpen((current) => {
      const next = { ...current, [section]: !current[section] };
      writeStoredSectionState(localStorage, next);
      return next;
    });
    // Opening "Earlier" for the first time: if it has no items loaded yet
    // (the initial-load loop stopped before ever seeing one — see
    // shouldFetchNextInitialPage) but the server has more to give, this is
    // the trigger that fetches its first page. If a boundary page already
    // handed us some "earlier" items, there's nothing to fetch yet — the
    // user just sees those until they hit "show more".
    if (
      section === "earlier" && !sectionOpen.earlier &&
      shouldFetchOnEarlierExpand(groupArticlesBySection(articles).earlier.length, nextCursor)
    ) {
      handleShowMore();
    }
  };

  const handleAdd = async (url: string, tags: string[]) => {
    try {
      const created = await createArticle({ url, tags, added_via: "manual" as AddedVia });
      setArticles((current) => [
        {
          id: created.id,
          url,
          canonical_url: null,
          title: url,
          source: null,
          author: null,
          published_at: null,
          added_at: new Date().toISOString(),
          added_via: "manual",
          lang_original: null,
          summary_ru: null,
          summary_en: null,
          summary_json: null,
          tags,
          status: created.status,
          archived: false,
          error: null,
          fail_class: null,
          heal_attempts: 0,
          faithfulness_verdict: null,
          faithfulness_json: null,
          faithfulness_checked_at: null,
        },
        ...current,
      ]);
      setModalOpen(false);
    } catch (err) {
      showError(err);
    }
  };

  const handleArchiveToggle = async (id: string, archived: boolean) => {
    try {
      const updated = await patchArticle(id, { archived });
      if (archived !== archivedView) {
        setArticles((current) => current.filter((a) => a.id !== id));
      } else {
        setArticles((current) => current.map((a) => (a.id === id ? { ...a, ...updated } : a)));
      }
    } catch (err) {
      showError(err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteArticle(id);
      setArticles((current) => current.filter((a) => a.id !== id));
    } catch (err) {
      showError(err);
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await retryArticle(id);
      setArticles((current) =>
        current.map((a) => (a.id === id ? { ...a, status: "pending", error: null } : a))
      );
    } catch (err) {
      showError(err);
    }
  };

  const handleResummarize = async (id: string) => {
    try {
      await resummarizeArticle(id);
      setArticles((current) =>
        current.map((a) => (a.id === id ? { ...a, status: "pending", error: null } : a))
      );
    } catch (err) {
      showError(err);
    }
  };

  const handleArticleUpdate = (updated: ArticleListItem) => {
    setArticles((current) => current.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleTagClick = (tag: string | null) => dispatchFilter({ type: "set-tag", tag });
  const handleSourceClick = (source: string | null) =>
    dispatchFilter({ type: "set-source", source });
  // The "все"/"all" pill: unlike toggling a single pill off, this resets
  // the whole filter set at once — tag, source, AND the search box, since
  // a visitor landing here from a source/tag filter with no way back
  // (previously the actual bug) should get a genuinely empty feed view.
  const handleClearAll = () => {
    dispatchFilter({ type: "clear-all" });
    setSearchInput("");
  };
  const handleSearchClear = () => {
    setSearchInput("");
    dispatchFilter({ type: "set-query", query: "" });
  };

  const tagFacets = useMemo(() => computeTagFacets(articles), [articles]);
  const sourceFacets = useMemo(() => computeSourceFacets(articles), [articles]);
  const pickOfDayId = useMemo(() => {
    const pick = articles.find((a) => isPickOfTheDay(a, articles));
    return pick?.id ?? null;
  }, [articles]);

  return (
    <>
      <div class="top-strip" />
      <Header
        dict={dict}
        lang={lang}
        onLangChange={setLang}
        theme={theme}
        onThemeToggle={toggleTheme}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onSearchClear={handleSearchClear}
        onAddClick={() => setModalOpen(true)}
        isOwner={isOwner}
      />

      <div class="layout">
        <main class="main-column">
          <div class="filter-row-mobile">
            <TopicPills
              dict={dict}
              tags={tagFacets}
              activeTag={activeTag}
              onTagClick={handleTagClick}
              onClearAll={handleClearAll}
            />
            <SourcePills
              sources={sourceFacets}
              activeSource={activeSource}
              onSourceClick={handleSourceClick}
            />
          </div>

          <ActiveFilterChips
            activeTag={activeTag}
            activeSource={activeSource}
            onClearTag={() => handleTagClick(null)}
            onClearSource={() => handleSourceClick(null)}
            clearTagAria={dict.clearTagFilterAria}
            clearSourceAria={dict.clearSourceFilterAria}
          />

          <Feed
            dict={dict}
            lang={lang}
            articles={articles}
            expandedId={expandedId}
            onToggleExpand={(id) => setExpandedId((current) => (current === id ? null : id))}
            onTagClick={handleTagClick}
            onSourceClick={handleSourceClick}
            onArchiveToggle={handleArchiveToggle}
            onDelete={handleDelete}
            onRetry={handleRetry}
            onResummarize={handleResummarize}
            onArticleUpdate={handleArticleUpdate}
            hasMore={nextCursor !== null}
            onShowMore={handleShowMore}
            loadingMore={loadingMore}
            archivedView={archivedView}
            pickOfDayId={pickOfDayId}
            isOwner={isOwner}
            sectionOpen={sectionOpen}
            onToggleSection={handleToggleSection}
            isSearching={query.trim() !== ""}
            agentHourUtc={agentHourUtc}
          />
        </main>

        <Sidebar
          dict={dict}
          tags={tagFacets}
          activeTag={activeTag}
          onTagClick={handleTagClick}
          onClearAll={handleClearAll}
          sources={sourceFacets}
          activeSource={activeSource}
          onSourceClick={handleSourceClick}
          totalCount={articles.length}
          archivedView={archivedView}
          onArchiveToggle={() => {
            setArchivedView((current) => !current);
          }}
          isOwner={isOwner}
        />
      </div>

      {modalOpen && isOwner && (
        <AddModal
          dict={dict}
          onClose={() => setModalOpen(false)}
          onSubmit={handleAdd}
        />
      )}

      {toastMessage && <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />}
    </>
  );
}
