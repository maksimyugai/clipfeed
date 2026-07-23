import type { Dictionary, Lang } from "../i18n.ts";
import type { SearchMode } from "../lib/searchMode.ts";
import type { Theme } from "../lib/theme.ts";

export interface HeaderProps {
  dict: Dictionary;
  lang: Lang;
  onLogoClick: () => void;
  onLangChange: (lang: Lang) => void;
  theme: Theme;
  onThemeToggle: () => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  onAddClick: () => void;
  isOwner: boolean;
  // Task 30 Part D: null (unset REPO_URL, or an invalid one — see
  // lib/repoConfig.ts's isValidRepoUrl) hides the icon entirely rather than
  // rendering a broken/placeholder link.
  repoUrl: string | null;
}

export function Header(
  {
    dict,
    lang,
    onLogoClick,
    onLangChange,
    theme,
    onThemeToggle,
    searchValue,
    onSearchChange,
    onSearchClear,
    searchMode,
    onSearchModeChange,
    onAddClick,
    isOwner,
    repoUrl,
  }: HeaderProps,
) {
  return (
    <header class="app-header">
      <div class="header-inner">
        <button
          type="button"
          class="logo logo-button"
          aria-label={dict.logoHomeAria}
          onClick={onLogoClick}
        >
          {dict.brand}
        </button>

        {
          /* Decorative — conveys nothing a screen reader needs; the visible
            text around it already carries all the meaning. */
        }
        <svg
          class="ua-flag"
          viewBox="0 0 24 16"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <clipPath id="ua-flag-clip">
              <rect width="24" height="16" rx="2" />
            </clipPath>
          </defs>
          <g clip-path="url(#ua-flag-clip)">
            <rect width="24" height="8" fill="#0057B7" />
            <rect y="8" width="24" height="8" fill="#FFD700" />
          </g>
        </svg>

        <div class="search-field">
          <input
            class="search-input"
            type="search"
            placeholder={dict.searchPlaceholder}
            value={searchValue}
            onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
            aria-label={dict.searchPlaceholder}
          />
          {searchValue !== "" && (
            <button
              type="button"
              class="search-clear"
              aria-label={dict.clearSearchAria}
              onClick={onSearchClear}
            >
              ✕
            </button>
          )}
        </div>

        {
          /* Only shown once a search is actually active — an idle search box
            has nothing for this to toggle, and keeping it out of the way
            avoids extra header clutter on every other view. */
        }
        {searchValue !== "" && (
          <div
            class="search-mode-toggle"
            role="group"
            aria-label={dict.searchModeToggleAria}
          >
            <button
              type="button"
              aria-pressed={searchMode === "keyword"}
              aria-label={dict.searchModeKeywordAria}
              onClick={() => onSearchModeChange("keyword")}
            >
              {dict.searchModeKeywordLabel}
            </button>
            <button
              type="button"
              aria-pressed={searchMode === "semantic"}
              aria-label={dict.searchModeSemanticAria}
              onClick={() => onSearchModeChange("semantic")}
            >
              {dict.searchModeSemanticLabel}
            </button>
          </div>
        )}

        {
          /* Task 35 Part A §4: the owner reads Russian only, so EN
            generation is lazy/owner-triggered — a visitor toggling this
            would just find every card stuck on "preparing English", with
            no way to trigger the translate call themselves. Owner-only. */
        }
        {isOwner && (
          <div class="lang-toggle" role="group" aria-label="RU/EN">
            <button
              type="button"
              aria-pressed={lang === "ru"}
              aria-label={dict.langToggleAriaRu}
              onClick={() => onLangChange("ru")}
            >
              RU
            </button>
            <button
              type="button"
              aria-pressed={lang === "en"}
              aria-label={dict.langToggleAriaEn}
              onClick={() => onLangChange("en")}
            >
              EN
            </button>
          </div>
        )}

        <button
          type="button"
          class="icon-button"
          aria-label={dict.themeToggleAria}
          onClick={onThemeToggle}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>

        {repoUrl && (
          <a
            class="icon-button"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={dict.githubLinkAria}
            title={dict.githubLinkAria}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        )}

        {isOwner
          ? (
            <button
              type="button"
              class="add-button"
              aria-label={dict.addButtonAria}
              onClick={onAddClick}
            >
              +
            </button>
          )
          : (
            // Top-level navigation (not a fetch/SPA route) — the browser
            // needs to complete Cloudflare Access's own hosted-login
            // redirect dance, which fetch() can't do.
            <a class="sign-in-link" href="/api/admin/login">{dict.signIn}</a>
          )}
      </div>
    </header>
  );
}
