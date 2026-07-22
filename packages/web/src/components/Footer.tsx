import type { Dictionary } from "../i18n.ts";

const REPO_URL = "https://github.com/maksimyugai/clipfeed";
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export interface FooterProps {
  dict: Dictionary;
}

// Copyright year is read at render time (not baked in at build time) so a
// long-lived deployment never shows a stale year.
export function Footer({ dict }: FooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer class="app-footer">
      <p class="app-footer-line">
        © {year} Maksim Yugai
        <span class="app-footer-sep" aria-hidden="true">·</span>
        <a href={LICENSE_URL} target="_blank" rel="noreferrer">{dict.footerLicenseLabel}</a>
        <span class="app-footer-sep" aria-hidden="true">·</span>
        {dict.footerContentNotice}
      </p>
    </footer>
  );
}
