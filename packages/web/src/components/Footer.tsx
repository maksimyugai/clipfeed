import type { Dictionary } from "../i18n.ts";

export interface FooterProps {
  dict: Dictionary;
  // Task 30 Part D: same config-sourced value the header's GitHub icon
  // uses (see lib/repoConfig.ts) — one source of truth. null (unset or
  // invalid REPO_URL) renders the license label as plain text instead of
  // a link, rather than pointing at a hardcoded, owner-specific repo.
  repoUrl: string | null;
}

// Copyright year is read at render time (not baked in at build time) so a
// long-lived deployment never shows a stale year.
export function Footer({ dict, repoUrl }: FooterProps) {
  const year = new Date().getFullYear();
  const licenseUrl = repoUrl ? `${repoUrl}/blob/main/LICENSE` : null;

  return (
    <footer class="app-footer">
      <p class="app-footer-line">
        © {year} Maksim Yugai
        <span class="app-footer-sep" aria-hidden="true">·</span>
        {licenseUrl
          ? <a href={licenseUrl} target="_blank" rel="noreferrer">{dict.footerLicenseLabel}</a>
          : dict.footerLicenseLabel}
        <span class="app-footer-sep" aria-hidden="true">·</span>
        {dict.footerContentNotice}
      </p>
    </footer>
  );
}
