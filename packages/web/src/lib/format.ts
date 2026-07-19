import type { Lang } from "../i18n.ts";

export function formatDate(iso: string, lang: Lang): string {
  const date = new Date(iso);
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}
