import type { Dictionary, Lang } from "../i18n.ts";
import type { SearchMode } from "../lib/searchMode.ts";
import type { Theme } from "../theme.ts";

export interface HeaderProps {
  dict: Dictionary;
  lang: Lang;
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
}

export function Header(
  {
    dict,
    lang,
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
  }: HeaderProps,
) {
  return (
    <header class="app-header">
      <div class="header-inner">
        <span class="logo">{dict.brand}</span>

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

        <button
          type="button"
          class="icon-button"
          aria-label={dict.themeToggleAria}
          onClick={onThemeToggle}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>

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
