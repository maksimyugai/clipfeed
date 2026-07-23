import type { Lang } from "../i18n.ts";

export function formatDate(iso: string, lang: Lang): string {
  const date = new Date(iso);
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}

// Task 35 Part C §4: the expanded card's image caption names the source
// domain the og:image was fetched from (image_source_url) — same
// lowercase/no-www normalization as the API's url-host.ts, kept as a
// separate copy since the web package doesn't share a bundle with the API.
export function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
