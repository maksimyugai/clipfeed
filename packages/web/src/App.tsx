import { useEffect, useMemo, useState } from "preact/hooks";
import type { AddedVia, ArticleListItem } from "@clipfeed/shared/types";
import { dictionaries, type Lang, readStoredLang, writeStoredLang } from "./i18n.ts";
import { useTheme } from "./theme.ts";
import {
  ApiError,
  createArticle,
  deleteArticle,
  getAdminMe,
  listArticles,
  patchArticle,
  retryArticle,
} from "./api.ts";
import { canMutate, classifyMeOutcome } from "./ownerMode.ts";
import { isPickOfTheDay } from "./lib/pickOfTheDay.ts";
import { Header } from "./components/Header.tsx";
import { AddModal } from "./components/AddModal.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SourcePills } from "./components/Sidebar.tsx";
import { Feed } from "./components/Feed.tsx";
import { Toast } from "./components/Toast.tsx";

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 20;

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
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
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

  // Debounce the raw search input into the value that actually drives fetches.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Any filter change is a fresh query: reset pagination and refetch page 1.
  useEffect(() => {
    let cancelled = false;
    setExpandedId(null);
    listArticles({
      limit: PAGE_LIMIT,
      tag: activeTag ?? undefined,
      source: activeSource ?? undefined,
      q: query || undefined,
      archived: archivedView,
    })
      .then((res) => {
        if (cancelled) return;
        setArticles(res.items);
        setNextCursor(res.next_cursor);
      })
      .catch((err) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [query, activeTag, activeSource, archivedView]);

  const handleShowMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listArticles({
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

  const handleArticleUpdate = (updated: ArticleListItem) => {
    setArticles((current) => current.map((a) => (a.id === updated.id ? updated : a)));
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
        onAddClick={() => setModalOpen(true)}
        isOwner={isOwner}
      />

      <div class="layout">
        <main class="main-column">
          <div class="filter-row-mobile">
            <button
              type="button"
              class={`pill${activeTag === null ? " pill--active" : ""}`}
              onClick={() => setActiveTag(null)}
            >
              {dict.sidebarAllPill}
            </button>
            {tagFacets.map(({ tag }) => (
              <button
                key={tag}
                type="button"
                class={`pill${activeTag === tag ? " pill--active" : ""}`}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              >
                {tag}
              </button>
            ))}
            <SourcePills
              sources={sourceFacets}
              activeSource={activeSource}
              onSourceClick={setActiveSource}
            />
          </div>

          <Feed
            dict={dict}
            lang={lang}
            articles={articles}
            expandedId={expandedId}
            onToggleExpand={(id) => setExpandedId((current) => (current === id ? null : id))}
            onTagClick={(tag) => setActiveTag(tag)}
            onSourceClick={(source) => setActiveSource(source)}
            onArchiveToggle={handleArchiveToggle}
            onDelete={handleDelete}
            onRetry={handleRetry}
            onArticleUpdate={handleArticleUpdate}
            hasMore={nextCursor !== null}
            onShowMore={handleShowMore}
            loadingMore={loadingMore}
            archivedView={archivedView}
            pickOfDayId={pickOfDayId}
            isOwner={isOwner}
          />
        </main>

        <Sidebar
          dict={dict}
          tags={tagFacets}
          activeTag={activeTag}
          onTagClick={setActiveTag}
          sources={sourceFacets}
          activeSource={activeSource}
          onSourceClick={setActiveSource}
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
