import type { AddedVia } from "@clipfeed/shared/types";

export type Lang = "ru" | "en";

export interface Dictionary {
  brand: string;
  searchPlaceholder: string;
  themeToggleAria: string;
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
  faithfulnessDetailLabel: string;
  faithfulnessUnsupportedLabel: string;
  faithfulnessContradictedLabel: string;
  readMore: string;
  tldrLabel: string;
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
  turnstileRequiredError: string;
  turnstileFailedError: string;
  turnstileUnavailableError: string;
  turnstileClientError: string;
  signIn: string;
  visitorFeedHint: string;
  clearSearchAria: string;
  clearTagFilterAria: string;
  clearSourceFilterAria: string;
}

const ru: Dictionary = {
  brand: "clipfeed",
  searchPlaceholder: "Поиск",
  themeToggleAria: "Переключить тему",
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
  faithfulnessDetailLabel: "Проверка достоверности",
  faithfulnessUnsupportedLabel: "не подтверждено",
  faithfulnessContradictedLabel: "противоречит",
  readMore: "читать далее",
  tldrLabel: "TL;DR",
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
  turnstileRequiredError: "Требуется проверка — попробуйте ещё раз.",
  turnstileFailedError: "Проверка не пройдена — попробуйте ещё раз.",
  turnstileUnavailableError: "Сервис проверки временно недоступен — попробуйте чуть позже.",
  turnstileClientError: "Не удалось выполнить проверку — попробуйте ещё раз.",
  signIn: "войти",
  visitorFeedHint: "Публичная лента ClipFeed",
  clearSearchAria: "Очистить поиск",
  clearTagFilterAria: "Сбросить фильтр по тегу",
  clearSourceFilterAria: "Сбросить фильтр по источнику",
};

const en: Dictionary = {
  brand: "clipfeed",
  searchPlaceholder: "Search",
  themeToggleAria: "Toggle theme",
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
  faithfulnessDetailLabel: "Faithfulness check",
  faithfulnessUnsupportedLabel: "unsupported",
  faithfulnessContradictedLabel: "contradicted",
  readMore: "read more",
  tldrLabel: "TL;DR",
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
