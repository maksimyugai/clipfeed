import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import type { AddedVia, ArticleListItem } from "@clipfeed/shared/types";
import { dictionaries, type Lang, readStoredLang, writeStoredLang } from "./i18n.ts";
import { useTheme } from "./lib/theme.ts";
import {
  type ArticlesQueryParams,
  createArticle,
  deleteArticle,
  getAdminArticle,
  getAdminMe,
  getArticle,
  listAdminArticles,
  listArticles,
  patchArticle,
  resummarizeArticle,
  retryArticle,
  searchAdminArticles,
  searchArticles,
} from "./api.ts";
import { readStoredSearchMode, type SearchMode, writeStoredSearchMode } from "./lib/searchMode.ts";
import { isShowingSemanticFallback, shouldRunSemanticFallback } from "./lib/searchFallback.ts";
import { computeLogoResetState } from "./lib/feedReset.ts";
import { canMutate, classifyMeOutcome, resolveEffectiveLang } from "./lib/ownerMode.ts";
import { isPickOfTheDay } from "./lib/pickOfTheDay.ts";
import { EMPTY_FILTER_STATE, filterReducer } from "./lib/filterState.ts";
import { bucketSection, type DateSection, groupArticlesBySection } from "./lib/dateGrouping.ts";
import {
  readStoredSectionState,
  type SectionOpenState,
  writeStoredSectionState,
} from "./lib/sectionState.ts";
import { shouldFetchNextInitialPage, shouldFetchOnEarlierExpand } from "./lib/pagination.ts";
import { loadAgentSchedule } from "./lib/agentSchedule.ts";
import { loadRepoUrl } from "./lib/repoConfig.ts";
import { classifyApiError, localizedErrorMessage } from "./lib/errorMessages.ts";
import { mergeRefreshedArticles, pickFailedIds } from "./lib/failedRefresh.ts";
import { isArticleInList, parseDeepLinkId } from "./lib/deepLink.ts";
import { applyFeedPollSnapshot, feedPollDelayMs, hasPendingArticles } from "./lib/feedPoll.ts";
import { translateQueue } from "./lib/translateQueue.ts";
import { Header } from "./components/Header.tsx";
import { AddModal } from "./components/AddModal.tsx";
import { ActiveFilterChips, Sidebar, SourcePills, TopicPills } from "./components/Sidebar.tsx";
import { Feed } from "./components/Feed.tsx";
import { Toast } from "./components/Toast.tsx";
import { Footer } from "./components/Footer.tsx";
import { ScrollToTopButton } from "./components/ScrollToTopButton.tsx";
import { DeepLinkedArticle } from "./components/DeepLinkedArticle.tsx";

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
    items: res.items.map((item) => ({
      ...item,
      error: null,
      faithfulness_json: null,
      faithfulness_enforced_at: null,
    })),
    next_cursor: res.next_cursor,
  };
}

// Semantic search's counterpart to fetchArticleList above — same
// owner/visitor redaction split, but no pagination (GET /api/search is a
// single bounded top-K list, already ranked by similarity — see search.ts
// on the API side) and no tag/source/archived filters, since the endpoint
// doesn't take any. Scores are dropped here on purpose: this repo's own SPA
// deliberately never shows them (see README "Semantic dedup & search") —
// ordering alone carries the ranking.
async function fetchSemanticSearch(isOwner: boolean, query: string): Promise<ArticleListItem[]> {
  if (isOwner) {
    const res = await searchAdminArticles(query, PAGE_LIMIT);
    return res.items.map((item) => item.article);
  }
  const res = await searchArticles(query, PAGE_LIMIT);
  return res.items.map((item) => ({
    ...item.article,
    error: null,
    faithfulness_json: null,
    faithfulness_enforced_at: null,
  }));
}

// Same owner/visitor redaction split as fetchArticleList above, but for a
// single row by id — used by the deep-link resolution effect below when a
// Telegram-post link (#article-<id>, see lib/deepLink.ts) points at an
// article that isn't in the currently loaded page(s).
async function fetchArticleById(isOwner: boolean, id: string): Promise<ArticleListItem> {
  if (isOwner) return await getAdminArticle(id);
  const article = await getArticle(id);
  return { ...article, error: null, faithfulness_json: null, faithfulness_enforced_at: null };
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

  const [searchInput, setSearchInput] = useState("");
  const [searchMode, setSearchModeState] = useState<SearchMode>(() =>
    readStoredSearchMode(localStorage)
  );
  const [filters, dispatchFilter] = useReducer(filterReducer, EMPTY_FILTER_STATE);
  const { tag: activeTag, source: activeSource, query } = filters;
  const [archivedView, setArchivedView] = useState(false);

  const setSearchMode = (next: SearchMode) => {
    setSearchModeState(next);
    writeStoredSearchMode(localStorage, next);
  };

  // Task 43 Part 3: the query a currently-shown semantic result set came
  // from via the automatic keyword->semantic fallback (null when not in a
  // fallback state — e.g. the user picked semantic mode themselves). Drives
  // Feed.tsx's "no keyword matches — here's what's similar by meaning"
  // heading via isShowingSemanticFallback. fallbackAttemptedForRef tracks
  // which query the fallback has already been tried for, so it only ever
  // fires once per query (see shouldRunSemanticFallback); skipNextSemanticFetchRef
  // tells the main data-fetch effect below to skip its own semantic fetch
  // the one time the fallback itself just flipped searchMode — the results
  // are already in `articles`, a second fetch would be redundant.
  const [fallbackQuery, setFallbackQuery] = useState<string | null>(null);
  const fallbackAttemptedForRef = useRef<string | null>(null);
  const skipNextSemanticFetchRef = useRef(false);

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
  const effectiveLang = resolveEffectiveLang(lang, isOwner);
  const dict = dictionaries[effectiveLang];

  // Task 37 §6 point 4: switching back to RU (or losing owner mode, which
  // forces the same effective language — see resolveEffectiveLang) drops
  // every not-yet-started translate request. Already in-flight ones are
  // left alone; their results are still stored/reused if they land after
  // the switch (see ArticleCard's onArticleUpdate).
  useEffect(() => {
    if (effectiveLang !== "en") translateQueue.cancelQueued();
  }, [effectiveLang]);
  const [sectionOpen, setSectionOpen] = useState<SectionOpenState>(() =>
    readStoredSectionState(localStorage)
  );
  const [agentHourUtc, setAgentHourUtc] = useState<number | null>(null);
  // Task 30 Part D: null hides both the header's GitHub icon and the
  // footer's license link (see repoConfig.ts, Header.tsx, Footer.tsx).
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  // Deep-link resolution (Task 29 Part B, extended in Task 32 Part B: a
  // Telegram drip post links to "/a/<id>" now — a real path, required for
  // link previews — but the legacy "#article-<id>" hash from
  // already-published posts is still parsed; see lib/deepLink.ts).
  // deepLinkPending is the id still waiting to be resolved (consumed
  // exactly once, either by finding it in the loaded list or by fetching
  // it standalone); deepLinkedArticle holds the standalone-fetched result,
  // which REPLACES the normal Feed view entirely while set (see the render
  // below); forceOpenSection is a session-only override so a deep-linked
  // article's date section renders open even if its persisted default is
  // closed, without ever writing that override into localStorage (see
  // Feed.tsx's `open` computation).
  const [deepLinkPending, setDeepLinkPending] = useState<string | null>(() =>
    parseDeepLinkId(globalThis.location?.pathname ?? "", globalThis.location?.hash ?? "")
  );
  const [deepLinkedArticle, setDeepLinkedArticle] = useState<ArticleListItem | null>(null);
  const [forceOpenSection, setForceOpenSection] = useState<DateSection | null>(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  const setLang = (next: Lang) => {
    setLangState(next);
    writeStoredLang(localStorage, next);
  };

  // Never interpolates the raw error message — localizedErrorMessage maps
  // every known ApiError shape (409 already-ready/duplicate/similar-title,
  // 401, 429, 5xx) to localized copy, and anything else (including a
  // non-ApiError like a network failure) to a generic "something went
  // wrong" string. See lib/errorMessages.ts.
  const showError = (err: unknown) => {
    setToastMessage(`${dict.toastErrorPrefix}: ${localizedErrorMessage(err, dict)}`);
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

  // Powers the header's GitHub icon link and the footer's license link
  // (see lib/repoConfig.ts) — fetched once and cached, same convention.
  useEffect(() => {
    loadRepoUrl().then(setRepoUrl);
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
  // instead. A non-empty query in "semantic" mode takes a completely
  // different path (fetchSemanticSearch, no pagination, no tag/source/
  // archived filters — the endpoint doesn't support them) rather than
  // folding into the loop below.
  useEffect(() => {
    let cancelled = false;
    setExpandedId(null);
    setInitialLoadDone(false);

    if (query.trim() !== "" && searchMode === "semantic") {
      // Task 43 Part 3: when the keyword->semantic fallback below just
      // flipped searchMode itself, `articles` already holds its results —
      // skip this effect's own fetch instead of firing a redundant second
      // request for the exact same query.
      if (skipNextSemanticFetchRef.current) {
        skipNextSemanticFetchRef.current = false;
        setInitialLoadDone(true);
        return;
      }
      fetchSemanticSearch(isOwner, query)
        .then((items) => {
          if (cancelled) return;
          setArticles(items);
          setNextCursor(null);
        })
        .catch((err) => {
          if (!cancelled) showError(err);
        })
        .finally(() => {
          if (!cancelled) setInitialLoadDone(true);
        });
      return () => {
        cancelled = true;
      };
    }

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
    })()
      .catch((err) => {
        if (!cancelled) showError(err);
      })
      .finally(() => {
        if (!cancelled) setInitialLoadDone(true);
      });

    return () => {
      cancelled = true;
    };
  }, [query, activeTag, activeSource, archivedView, isOwner, searchMode]);

  // Task 43 Part 3: a KEYWORD search that comes back empty runs the same
  // query once in SEMANTIC mode in the background; if that finds anything,
  // flip into semantic mode with those results already in hand (see the
  // skipNextSemanticFetchRef check above) and tag them via fallbackQuery so
  // Feed.tsx shows the "no keyword matches — here's what's similar by
  // meaning" heading instead of the normal semantic-matches count line. If
  // semantic finds nothing either, this silently leaves the existing empty
  // state alone — shouldRunSemanticFallback's alreadyAttemptedQuery check
  // means it's never retried for the same query again.
  useEffect(() => {
    if (
      !shouldRunSemanticFallback({
        searchMode,
        query,
        initialLoadDone,
        resultCount: articles.length,
        alreadyAttemptedQuery: fallbackAttemptedForRef.current,
      })
    ) {
      return;
    }

    const trimmed = query.trim();
    fallbackAttemptedForRef.current = trimmed;
    let cancelled = false;
    fetchSemanticSearch(isOwner, query)
      .then((items) => {
        if (cancelled || items.length === 0) return;
        skipNextSemanticFetchRef.current = true;
        setArticles(items);
        setNextCursor(null);
        setFallbackQuery(trimmed);
        setSearchMode("semantic");
      })
      .catch(() => {
        // Best-effort convenience — a failed fallback just leaves the
        // normal empty state showing, same as if it had found nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [searchMode, query, initialLoadDone, articles.length, isOwner]);

  // Task 41 Part A: replaces what used to be one GET /api/articles/:id per
  // pending card, every 4s, independently (N pending == N requests/tick) —
  // now a single feed-level poll refreshes every pending card from one
  // shared snapshot, on the same fast-then-slow cadence (see
  // lib/feedPoll.ts). The effect's own dependency is just the boolean
  // "is anything pending right now", not the `articles` array itself — so
  // it restarts (a fresh fast-phase clock) exactly when a new pending
  // episode begins, and its cleanup stops the timer entirely the instant
  // nothing is pending anymore, rather than re-triggering on every snapshot
  // update the poll itself produces.
  const anyPending = hasPendingArticles(articles);
  // Read via a ref inside the timer closure so a filter/mode change doesn't
  // need to restart this effect (that's already handled by the initial-load
  // effect above) — this poll just always refetches with whatever's current.
  const feedPollParamsRef = useRef({
    isOwner,
    activeTag,
    activeSource,
    query,
    archivedView,
    searchMode,
  });
  feedPollParamsRef.current = { isOwner, activeTag, activeSource, query, archivedView, searchMode };

  useEffect(() => {
    if (!anyPending) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let cycleStartedAt = Date.now();
    let elapsed = 0;

    const stopTimer = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
    };

    const scheduleNext = () => {
      stopTimer();
      timerId = setTimeout(tick, feedPollDelayMs(elapsed));
    };

    async function tick() {
      const params = feedPollParamsRef.current;
      // Semantic search has no pagination/pending concept in the same sense
      // (see fetchSemanticSearch) — skip fetching while in that mode; the
      // timer keeps running so it resumes correctly on leaving it.
      const inSemanticMode = params.query.trim() !== "" && params.searchMode === "semantic";
      if (!inSemanticMode) {
        try {
          const res = await fetchArticleList(params.isOwner, {
            limit: PAGE_LIMIT,
            tag: params.activeTag ?? undefined,
            source: params.activeSource ?? undefined,
            q: params.query || undefined,
            archived: params.archivedView,
          });
          if (!cancelled) {
            setArticles((current) => applyFeedPollSnapshot(current, res.items));
          }
        } catch {
          // A single failed tick isn't fatal — just try again next tick.
        }
      }
      if (cancelled) return;
      elapsed += Date.now() - cycleStartedAt;
      cycleStartedAt = Date.now();
      scheduleNext();
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopTimer();
      } else {
        cycleStartedAt = Date.now();
        scheduleNext();
      }
    };

    if (!document.hidden) scheduleNext();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [anyPending]);

  // Resolves the deep link exactly once, after the initial (unfiltered,
  // default-view) load has actually settled — a hash present at mount
  // always lands on the default view first (nothing persists query/filter
  // state across a reload), so waiting for initialLoadDone here is waiting
  // for that one real load, not a filtered one. If the article is already
  // in the loaded page(s), just expand + force its section open (its own
  // ArticleCard scrolls its title into view on the expand transition — see
  // scroll.ts). Otherwise fetch it standalone for the focused single-card
  // view (see the render below).
  useEffect(() => {
    if (!deepLinkPending || !initialLoadDone) return;
    const id = deepLinkPending;

    if (isArticleInList(id, articles)) {
      const found = articles.find((a) => a.id === id)!;
      setForceOpenSection(bucketSection(found.added_at));
      setExpandedId(id);
      setDeepLinkPending(null);
      return;
    }

    let cancelled = false;
    fetchArticleById(isOwner, id)
      .then((article) => {
        if (!cancelled) setDeepLinkedArticle(article);
      })
      .catch(() => {
        // Deleted/bad id — silently fall back to the normal default feed
        // rather than a scary error toast for a stale link.
      })
      .finally(() => {
        if (!cancelled) setDeepLinkPending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deepLinkPending, initialLoadDone, articles, isOwner]);

  // Resets the visible URL back to "/" — covers both deep-link shapes
  // (the "/a/<id>" path and the legacy "#article-<id>" hash) so a stale
  // deep link never fights the feed's own (in-memory, not URL-driven)
  // filter state on a later reload.
  const clearDeepLinkUrl = () => {
    if (globalThis.location && (globalThis.location.hash || globalThis.location.pathname !== "/")) {
      history.replaceState(null, "", "/");
    }
  };

  // Any explicit filter/search interaction drops deep-link state — a user
  // who starts filtering clearly isn't interested in the linked article
  // anymore, and leaving the URL as-is would otherwise re-resolve it (or
  // just look stale) the next time initialLoadDone flips. Skips its own
  // first run so mount doesn't immediately clear the very deep link it's
  // meant to resolve.
  const skipFirstDeepLinkClear = useRef(true);
  useEffect(() => {
    if (skipFirstDeepLinkClear.current) {
      skipFirstDeepLinkClear.current = false;
      return;
    }
    clearDeepLinkUrl();
    setDeepLinkPending(null);
    setDeepLinkedArticle(null);
    setForceOpenSection(null);
  }, [activeTag, activeSource, query, archivedView]);

  const handleBackToFeed = () => {
    setDeepLinkedArticle(null);
    clearDeepLinkUrl();
  };

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

  // `currentlyOpen` is the section's *effective* open value at click time
  // (Feed.tsx computes it via isSectionOpenTodayEmptyAware, which may be
  // showing a computed default rather than a persisted choice — e.g.
  // Yesterday auto-opened because Today is empty). Flipping from that
  // effective value, not from the raw (possibly-undefined) stored one, is
  // what makes a user's very first click on such a section actually close
  // it instead of writing `true` right back (see Task 26 Part 0).
  const handleToggleSection = (section: DateSection, currentlyOpen: boolean) => {
    setSectionOpen((current) => {
      const next = { ...current, [section]: !currentlyOpen };
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
      section === "earlier" && !currentlyOpen &&
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
          embedded_at: null,
          telegram_published_at: null,
          en_generated_at: null,
          image_key: null,
          image_source_url: null,
          processing_started_at: null,
          faithfulness_enforced_at: null,
        },
        ...current,
      ]);
      setModalOpen(false);
      refreshFailedArticles();
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
      refreshFailedArticles();
    } catch (err) {
      showError(err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteArticle(id);
      setArticles((current) => current.filter((a) => a.id !== id));
      refreshFailedArticles();
    } catch (err) {
      showError(err);
    }
  };

  // Refetches ONE article from the server and merges it into local state —
  // used both when a 409-on-ready retry means the client's view was simply
  // stale (see handleRetry) and by the periodic failed-card refresh below.
  // Returns whether the refetch itself succeeded, so a caller can decide
  // whether a fallback toast is warranted.
  const refetchOneArticle = async (id: string): Promise<boolean> => {
    try {
      const fresh = await getAdminArticle(id);
      setArticles((current) => current.map((a) => (a.id === id ? fresh : a)));
      return true;
    } catch {
      return false;
    }
  };

  // failed cards never poll on their own (unlike pending — see
  // usePendingPoll in ArticleCard.tsx), so a card that self-healed in the
  // background (the hourly healing sweep, see healing.ts) stays showing
  // 'failed' with a stale Retry button until something explicitly re-syncs
  // it. Runs on window focus/tab visibility (see the effect below) and
  // after a successful admin action (see the call sites above/below) —
  // never a polling timer.
  const refreshFailedArticles = async () => {
    const failedIds = pickFailedIds(articles);
    if (failedIds.length === 0) return;
    const results = await Promise.allSettled(failedIds.map((id) => getAdminArticle(id)));
    setArticles((current) => mergeRefreshedArticles(current, failedIds, results));
  };

  // The listener below is registered once (empty deps) and must still see
  // the LATEST refreshFailedArticles (which itself closes over the latest
  // `articles`) — a ref sidesteps re-adding the listener on every render
  // just to keep its closure fresh.
  const refreshFailedArticlesRef = useRef(refreshFailedArticles);
  refreshFailedArticlesRef.current = refreshFailedArticles;

  useEffect(() => {
    if (!isOwner) return;
    const handler = () => {
      if (document.visibilityState === "visible") refreshFailedArticlesRef.current();
    };
    globalThis.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      globalThis.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [isOwner]);

  const handleRetry = async (id: string) => {
    // Guard against a stale client view: if the card's local status isn't
    // actually 'failed' anymore (a background heal completed since the
    // last render), there's nothing to retry — just resync this one row
    // instead of calling an endpoint that by design 409s on a ready
    // article.
    const current = articles.find((a) => a.id === id);
    if (current && current.status !== "failed") {
      await refetchOneArticle(id);
      return;
    }

    try {
      await retryArticle(id);
      setArticles((current) =>
        current.map((a) => (a.id === id ? { ...a, status: "pending", error: null } : a))
      );
      refreshFailedArticles();
    } catch (err) {
      if (classifyApiError(err) === "already-ready") {
        // The server says it's already done — the client's view was
        // stale, not an actual error. Silently sync instead of surfacing
        // a scary toast for a non-problem; only fall back to a neutral
        // error if the resync itself fails too.
        const synced = await refetchOneArticle(id);
        if (!synced) showError(err);
        return;
      }
      showError(err);
    }
  };

  const handleResummarize = async (id: string) => {
    try {
      await resummarizeArticle(id);
      setArticles((current) =>
        current.map((a) => (a.id === id ? { ...a, status: "pending", error: null } : a))
      );
      refreshFailedArticles();
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
  // The "clipfeed" wordmark: resets to the default feed view — filters,
  // search, mode, and archived view all clear at once, same spirit as
  // handleClearAll but also covering the two pieces of state that pill
  // doesn't touch (searchMode, archivedView). Section open/closed state is
  // deliberately left alone — it's the user's persisted preference, not
  // part of "back to default".
  const handleLogoClick = () => {
    dispatchFilter({ type: "clear-all" });
    setSearchInput("");
    const reset = computeLogoResetState();
    setSearchMode(reset.searchMode);
    setArchivedView(reset.archivedView);
    globalThis.scrollTo({ top: 0, behavior: "smooth" });
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
        lang={effectiveLang}
        onLogoClick={handleLogoClick}
        onLangChange={setLang}
        theme={theme}
        onThemeToggle={toggleTheme}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onSearchClear={handleSearchClear}
        searchMode={searchMode}
        onSearchModeChange={setSearchMode}
        onAddClick={() => setModalOpen(true)}
        isOwner={isOwner}
        repoUrl={repoUrl}
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

          {deepLinkedArticle
            ? (
              <DeepLinkedArticle
                dict={dict}
                lang={effectiveLang}
                article={deepLinkedArticle}
                isOwner={isOwner}
                onBackToFeed={handleBackToFeed}
                onTagClick={handleTagClick}
                onSourceClick={handleSourceClick}
                onArchiveToggle={handleArchiveToggle}
                onDelete={handleDelete}
                onRetry={handleRetry}
                onResummarize={handleResummarize}
                onArticleUpdate={setDeepLinkedArticle}
              />
            )
            : (
              <Feed
                dict={dict}
                lang={effectiveLang}
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
                forceOpenSection={forceOpenSection}
                isSearching={query.trim() !== ""}
                searchMode={searchMode}
                isSemanticFallback={isShowingSemanticFallback(searchMode, query, fallbackQuery)}
                agentHourUtc={agentHourUtc}
                activeTag={activeTag}
                activeSource={activeSource}
                onResetFilters={handleClearAll}
              />
            )}
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

      <Footer dict={dict} repoUrl={repoUrl} />

      <ScrollToTopButton dict={dict} />

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
