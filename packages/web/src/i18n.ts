import type { AddedVia } from "@clipfeed/shared/types";

export type Lang = "ru" | "en";

export interface Dictionary {
  brand: string;
  searchPlaceholder: string;
  themeToggleAria: string;
  githubLinkAria: string;
  scrollToTopAria: string;
  langToggleAriaRu: string;
  langToggleAriaEn: string;
  addButtonAria: string;
  modalTitle: string;
  urlLabel: string;
  urlPlaceholder: string;
  tagsLabel: string;
  tagsPlaceholder: string;
  modalSubmit: string;
  modalCancelAria: string;
  sidebarAllPill: string;
  sidebarSourcesHeading: string;
  sidebarTotalArticles: string;
  sidebarArchiveLink: string;
  sidebarBackToFeed: string;
  showMore: string;
  sectionToday: string;
  sectionYesterday: string;
  sectionEarlier: string;
  emptyFeedTitle: string;
  emptyFeedHint: string;
  emptyArchiveTitle: string;
  pendingLabel: string;
  pendingStuckLabel: string;
  checkNowButton: string;
  retryButton: string;
  errorPrefix: string;
  couldNotProcessLabel: string;
  permanentFailurePrefix: string;
  permanentReasonInsufficientText: string;
  permanentReasonNotFound: string;
  permanentReasonRemoved: string;
  permanentReasonSsrfBlocked: string;
  permanentReasonPaywalled: string;
  permanentReasonUnfaithful: string;
  dailyLimitFailureLabel: string;
  faithfulnessBadgeWeak: string;
  faithfulnessBadgeFail: string;
  faithfulnessTooltipWeak: string;
  faithfulnessTooltipFail: string;
  faithfulnessTooltipTrailer: string;
  faithfulnessDetailLabel: string;
  faithfulnessUnsupportedLabel: string;
  faithfulnessContradictedLabel: string;
  readMore: string;
  tldrLabel: string;
  keyTakeawaysHeading: string;
  summaryByPrefix: string;
  summaryAddedVia: string;
  archiveAction: string;
  unarchiveAction: string;
  deleteAction: string;
  collapseAction: string;
  deleteConfirm: string;
  resummarizeAction: string;
  pickOfDay: string;
  viaManual: string;
  viaExtension: string;
  viaAgent: string;
  viaTelegram: string;
  toastErrorPrefix: string;
  errorAlreadyReady: string;
  errorDuplicateUrl: string;
  errorSimilarTitle: string;
  errorUnauthorized: string;
  errorRateLimited: string;
  errorServerError: string;
  errorGeneric: string;
  turnstileRequiredError: string;
  turnstileFailedError: string;
  turnstileUnavailableError: string;
  turnstileClientError: string;
  signIn: string;
  visitorFeedHint: string;
  clearSearchAria: string;
  clearTagFilterAria: string;
  clearSourceFilterAria: string;
  todayEmptyMessage: string;
  todayCountdownPrefix: string;
  todayCountdownHoursUnit: string;
  todayCountdownMinutesUnit: string;
  todayCountdownLessThanMinute: string;
  todayAgentDisabled: string;
  todayReadYesterdayLink: string;
  agentBatchPreparingPrefix: string;
  agentBatchPreparingSuffix: string;
  agentBatchReadyLabel: string;
  agentBatchOfLabel: string;
  pendingProcessingCaption: string;
  searchModeToggleAria: string;
  searchModeKeywordLabel: string;
  searchModeSemanticLabel: string;
  searchModeKeywordAria: string;
  searchModeSemanticAria: string;
  emptySearchTitle: string;
  emptySearchHint: string;
  semanticMatchesPrefix: string;
  semanticMatchesSuffix: string;
  logoHomeAria: string;
  footerLicenseLabel: string;
  footerContentNotice: string;
  backToFeedLink: string;
  resetFiltersAction: string;
  preparingEnglishLabel: string;
  imageSourcePrefix: string;
  imageAlt: string;
}

const ru: Dictionary = {
  brand: "clipfeed",
  searchPlaceholder: "Поиск",
  themeToggleAria: "Переключить тему",
  githubLinkAria: "Исходный код на GitHub",
  scrollToTopAria: "Наверх",
  langToggleAriaRu: "Переключить на русский",
  langToggleAriaEn: "Переключить на английский",
  addButtonAria: "Добавить статью",
  modalTitle: "Добавить статью",
  urlLabel: "Ссылка",
  urlPlaceholder: "https://example.com/article",
  tagsLabel: "Теги (через запятую)",
  tagsPlaceholder: "технологии, наука",
  modalSubmit: "Добавить",
  modalCancelAria: "Закрыть",
  sidebarAllPill: "все",
  sidebarSourcesHeading: "Источники",
  sidebarTotalArticles: "Всего статей",
  sidebarArchiveLink: "Архив",
  sidebarBackToFeed: "К ленте",
  showMore: "Показать ещё",
  sectionToday: "Сегодня",
  sectionYesterday: "Вчера",
  sectionEarlier: "Ранее",
  emptyFeedTitle: "Пока пусто",
  emptyFeedHint: "Нажмите «+», чтобы добавить первую статью",
  emptyArchiveTitle: "В архиве пока ничего нет",
  pendingLabel: "Пересказ готовится…",
  pendingStuckLabel: "Долго обрабатывается…",
  checkNowButton: "Проверить",
  retryButton: "Повторить",
  errorPrefix: "Ошибка",
  couldNotProcessLabel: "Не удалось обработать",
  permanentFailurePrefix: "Не обработать",
  permanentReasonInsufficientText: "на странице нет текста статьи",
  permanentReasonNotFound: "страница не найдена",
  permanentReasonRemoved: "страница удалена источником",
  permanentReasonSsrfBlocked: "ссылка заблокирована политикой безопасности",
  permanentReasonPaywalled: "страница закрыта платным доступом",
  permanentReasonUnfaithful: "пересказ не подтверждён источником",
  dailyLimitFailureLabel: "Дневной лимит выжимок исчерпан — обработается автоматически завтра",
  faithfulnessBadgeWeak: "требует проверки",
  faithfulnessBadgeFail: "возможны неточности",
  faithfulnessTooltipWeak:
    "Часть утверждений выжимки не удалось подтвердить по тексту оригинала. Проверьте по ссылке на источник.",
  faithfulnessTooltipFail:
    "Выжимка может содержать неточности: значительная часть утверждений не подтверждается оригиналом или противоречит ему.",
  faithfulnessTooltipTrailer: "Проверку делает отдельная ИИ-модель.",
  faithfulnessDetailLabel: "Проверка достоверности",
  faithfulnessUnsupportedLabel: "не подтверждено",
  faithfulnessContradictedLabel: "противоречит",
  readMore: "читать далее",
  tldrLabel: "TL;DR",
  keyTakeawaysHeading: "Итог",
  summaryByPrefix: "Пересказ Claude по статье",
  summaryAddedVia: "добавлено",
  archiveAction: "В архив",
  unarchiveAction: "Из архива",
  deleteAction: "Удалить",
  collapseAction: "Свернуть",
  deleteConfirm: "Удалить статью?",
  resummarizeAction: "Пересжать",
  pickOfDay: "выбор дня",
  viaManual: "вручную",
  viaExtension: "расширением",
  viaAgent: "агентом",
  viaTelegram: "из телеграма",
  toastErrorPrefix: "Ошибка",
  errorAlreadyReady: "Статья уже обработана.",
  errorDuplicateUrl: "Эта ссылка уже добавлена в ленту.",
  errorSimilarTitle: "Похожая статья уже добавлена недавно.",
  errorUnauthorized: "Требуется вход в систему.",
  errorRateLimited: "Слишком много запросов — попробуйте чуть позже.",
  errorServerError: "Сервер временно недоступен — попробуйте позже.",
  errorGeneric: "Что-то пошло не так.",
  turnstileRequiredError: "Требуется проверка — попробуйте ещё раз.",
  turnstileFailedError: "Проверка не пройдена — попробуйте ещё раз.",
  turnstileUnavailableError: "Сервис проверки временно недоступен — попробуйте чуть позже.",
  turnstileClientError: "Не удалось выполнить проверку — попробуйте ещё раз.",
  signIn: "войти",
  visitorFeedHint: "Публичная лента ClipFeed",
  clearSearchAria: "Очистить поиск",
  clearTagFilterAria: "Сбросить фильтр по тегу",
  clearSourceFilterAria: "Сбросить фильтр по источнику",
  todayEmptyMessage: "Сегодняшние выжимки ещё готовятся",
  todayCountdownPrefix: "Свежие статьи через",
  todayCountdownHoursUnit: "ч",
  todayCountdownMinutesUnit: "мин",
  todayCountdownLessThanMinute: "Свежие статьи вот-вот появятся",
  todayAgentDisabled: "Автоподбор отключён",
  todayReadYesterdayLink: "Пока почитайте вчерашние",
  agentBatchPreparingPrefix: "Готовится",
  agentBatchPreparingSuffix: "свежих выжимок…",
  agentBatchReadyLabel: "готово",
  agentBatchOfLabel: "из",
  pendingProcessingCaption: "Обрабатывается…",
  searchModeToggleAria: "Режим поиска",
  searchModeKeywordLabel: "по словам",
  searchModeSemanticLabel: "по смыслу",
  searchModeKeywordAria: "Искать по словам",
  searchModeSemanticAria: "Искать по смыслу",
  emptySearchTitle: "Ничего не найдено",
  emptySearchHint: "Попробуйте другой режим поиска — «по словам» или «по смыслу»",
  semanticMatchesPrefix: "Найдено",
  semanticMatchesSuffix: "по смыслу",
  logoHomeAria: "На главную",
  footerLicenseLabel: "код под MIT",
  footerContentNotice: "Выжимки созданы ИИ. Права на исходные статьи принадлежат их авторам.",
  backToFeedLink: "показать всю ленту",
  resetFiltersAction: "Сбросить фильтры",
  preparingEnglishLabel: "Готовим английскую версию…",
  imageSourcePrefix: "Изображение",
  imageAlt: "Изображение к статье",
};

const en: Dictionary = {
  brand: "clipfeed",
  searchPlaceholder: "Search",
  themeToggleAria: "Toggle theme",
  githubLinkAria: "Source code on GitHub",
  scrollToTopAria: "Back to top",
  langToggleAriaRu: "Switch to Russian",
  langToggleAriaEn: "Switch to English",
  addButtonAria: "Add article",
  modalTitle: "Add article",
  urlLabel: "URL",
  urlPlaceholder: "https://example.com/article",
  tagsLabel: "Tags (comma separated)",
  tagsPlaceholder: "technology, science",
  modalSubmit: "Add",
  modalCancelAria: "Close",
  sidebarAllPill: "all",
  sidebarSourcesHeading: "Sources",
  sidebarTotalArticles: "Total articles",
  sidebarArchiveLink: "Archive",
  sidebarBackToFeed: "Back to feed",
  showMore: "Show more",
  sectionToday: "Today",
  sectionYesterday: "Yesterday",
  sectionEarlier: "Earlier",
  emptyFeedTitle: "Nothing here yet",
  emptyFeedHint: 'Press "+" to add your first article',
  emptyArchiveTitle: "Nothing archived yet",
  pendingLabel: "Summary in progress…",
  pendingStuckLabel: "Taking a while…",
  checkNowButton: "Check now",
  retryButton: "Retry",
  errorPrefix: "Error",
  couldNotProcessLabel: "Could not be processed",
  permanentFailurePrefix: "Could not process",
  permanentReasonInsufficientText: "the page has no article text",
  permanentReasonNotFound: "the page was not found",
  permanentReasonRemoved: "the page was removed by the source",
  permanentReasonSsrfBlocked: "the link was blocked by security policy",
  permanentReasonPaywalled: "the page is behind a paywall",
  permanentReasonUnfaithful: "the summary wasn't supported by the source",
  dailyLimitFailureLabel: "Daily summary limit reached — this will process automatically tomorrow",
  faithfulnessBadgeWeak: "needs review",
  faithfulnessBadgeFail: "possibly inaccurate",
  faithfulnessTooltipWeak:
    "Some claims in the summary could not be confirmed against the original text. Check the source link.",
  faithfulnessTooltipFail:
    "The summary may contain inaccuracies: a significant portion of its claims aren't supported by the original or contradict it.",
  faithfulnessTooltipTrailer: "Checked by a separate AI model.",
  faithfulnessDetailLabel: "Faithfulness check",
  faithfulnessUnsupportedLabel: "unsupported",
  faithfulnessContradictedLabel: "contradicted",
  readMore: "read more",
  tldrLabel: "TL;DR",
  keyTakeawaysHeading: "Key points",
  summaryByPrefix: "Summary by Claude from",
  summaryAddedVia: "added via",
  archiveAction: "Archive",
  unarchiveAction: "Unarchive",
  deleteAction: "Delete",
  collapseAction: "Collapse",
  deleteConfirm: "Delete this article?",
  resummarizeAction: "Re-summarize",
  pickOfDay: "pick of the day",
  viaManual: "manually",
  viaExtension: "via extension",
  viaAgent: "by the agent",
  viaTelegram: "via telegram",
  toastErrorPrefix: "Error",
  errorAlreadyReady: "This article has already been processed.",
  errorDuplicateUrl: "That link is already in the feed.",
  errorSimilarTitle: "A similar article was already added recently.",
  errorUnauthorized: "Sign-in required.",
  errorRateLimited: "Too many requests — please try again shortly.",
  errorServerError: "The server is temporarily unavailable — please try again later.",
  errorGeneric: "Something went wrong.",
  turnstileRequiredError: "Verification required — please try again.",
  turnstileFailedError: "Verification failed — please try again.",
  turnstileUnavailableError:
    "Verification service is temporarily unavailable — please try again shortly.",
  turnstileClientError: "Could not complete the verification check — please try again.",
  signIn: "sign in",
  visitorFeedHint: "Public ClipFeed feed",
  clearSearchAria: "Clear search",
  clearTagFilterAria: "Clear tag filter",
  clearSourceFilterAria: "Clear source filter",
  todayEmptyMessage: "Today's picks aren't in yet",
  todayCountdownPrefix: "New articles in",
  todayCountdownHoursUnit: "h",
  todayCountdownMinutesUnit: "m",
  todayCountdownLessThanMinute: "New articles any moment now",
  todayAgentDisabled: "Auto-picks are off",
  todayReadYesterdayLink: "Read yesterday's meanwhile",
  agentBatchPreparingPrefix: "Preparing",
  agentBatchPreparingSuffix: "fresh summaries…",
  agentBatchReadyLabel: "ready",
  agentBatchOfLabel: "of",
  pendingProcessingCaption: "Processing…",
  searchModeToggleAria: "Search mode",
  searchModeKeywordLabel: "by words",
  searchModeSemanticLabel: "by meaning",
  searchModeKeywordAria: "Search by words",
  searchModeSemanticAria: "Search by meaning",
  emptySearchTitle: "No results found",
  emptySearchHint: 'Try the other search mode — "by words" or "by meaning"',
  semanticMatchesPrefix: "Found",
  semanticMatchesSuffix: "semantic matches",
  logoHomeAria: "Go to home feed",
  footerLicenseLabel: "code under MIT",
  footerContentNotice:
    "Summaries are AI-generated. Rights to the source articles belong to their authors.",
  backToFeedLink: "back to feed",
  resetFiltersAction: "Reset filters",
  preparingEnglishLabel: "Preparing English version…",
  imageSourcePrefix: "Image",
  imageAlt: "Article image",
};

export const dictionaries: Record<Lang, Dictionary> = { ru, en };

const LANG_STORAGE_KEY = "clipfeed-lang";
const DEFAULT_LANG: Lang = "ru";

export function isLang(value: string | null): value is Lang {
  return value === "ru" || value === "en";
}

export function readStoredLang(storage: Pick<Storage, "getItem">): Lang {
  const stored = storage.getItem(LANG_STORAGE_KEY);
  return isLang(stored) ? stored : DEFAULT_LANG;
}

export function writeStoredLang(storage: Pick<Storage, "setItem">, lang: Lang): void {
  storage.setItem(LANG_STORAGE_KEY, lang);
}

export function viaLabel(dict: Dictionary, addedVia: AddedVia): string {
  if (addedVia === "extension") return dict.viaExtension;
  if (addedVia === "agent") return dict.viaAgent;
  if (addedVia === "telegram") return dict.viaTelegram;
  return dict.viaManual;
}
