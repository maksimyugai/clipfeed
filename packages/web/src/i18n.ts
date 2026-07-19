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
  emptyFeedTitle: string;
  emptyFeedHint: string;
  emptyArchiveTitle: string;
  pendingLabel: string;
  pendingStuckLabel: string;
  retryButton: string;
  errorPrefix: string;
  readMore: string;
  tldrLabel: string;
  summaryByPrefix: string;
  summaryAddedVia: string;
  archiveAction: string;
  unarchiveAction: string;
  deleteAction: string;
  collapseAction: string;
  deleteConfirm: string;
  pickOfDay: string;
  viaManual: string;
  viaExtension: string;
  viaAgent: string;
  toastErrorPrefix: string;
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
  emptyFeedTitle: "Пока пусто",
  emptyFeedHint: "Нажмите «+», чтобы добавить первую статью",
  emptyArchiveTitle: "В архиве пока ничего нет",
  pendingLabel: "Пересказ готовится…",
  pendingStuckLabel: "Обработка занимает больше времени, чем обычно…",
  retryButton: "Повторить",
  errorPrefix: "Ошибка",
  readMore: "читать далее",
  tldrLabel: "TL;DR",
  summaryByPrefix: "Пересказ Claude по статье",
  summaryAddedVia: "добавлено",
  archiveAction: "В архив",
  unarchiveAction: "Из архива",
  deleteAction: "Удалить",
  collapseAction: "Свернуть",
  deleteConfirm: "Удалить статью?",
  pickOfDay: "выбор дня",
  viaManual: "вручную",
  viaExtension: "расширением",
  viaAgent: "агентом",
  toastErrorPrefix: "Ошибка",
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
  emptyFeedTitle: "Nothing here yet",
  emptyFeedHint: 'Press "+" to add your first article',
  emptyArchiveTitle: "Nothing archived yet",
  pendingLabel: "Summary in progress…",
  pendingStuckLabel: "Still processing…",
  retryButton: "Retry",
  errorPrefix: "Error",
  readMore: "read more",
  tldrLabel: "TL;DR",
  summaryByPrefix: "Summary by Claude from",
  summaryAddedVia: "added via",
  archiveAction: "Archive",
  unarchiveAction: "Unarchive",
  deleteAction: "Delete",
  collapseAction: "Collapse",
  deleteConfirm: "Delete this article?",
  pickOfDay: "pick of the day",
  viaManual: "manually",
  viaExtension: "via extension",
  viaAgent: "by the agent",
  toastErrorPrefix: "Error",
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

export function viaLabel(dict: Dictionary, addedVia: "manual" | "extension" | "agent"): string {
  if (addedVia === "extension") return dict.viaExtension;
  if (addedVia === "agent") return dict.viaAgent;
  return dict.viaManual;
}
