import type { Dictionary, Lang } from "../i18n.ts";
import type { Theme } from "../theme.ts";

export interface HeaderProps {
  dict: Dictionary;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  theme: Theme;
  onThemeToggle: () => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddClick: () => void;
}

export function Header(
  { dict, lang, onLangChange, theme, onThemeToggle, searchValue, onSearchChange, onAddClick }:
    HeaderProps,
) {
  return (
    <header class="app-header">
      <div class="header-inner">
        <span class="logo">{dict.brand}</span>

        <div class="search-field">
          <input
            class="search-input"
            type="search"
            placeholder={dict.searchPlaceholder}
            value={searchValue}
            onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
            aria-label={dict.searchPlaceholder}
          />
        </div>

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

        <button
          type="button"
          class="add-button"
          aria-label={dict.addButtonAria}
          onClick={onAddClick}
        >
          +
        </button>
      </div>
    </header>
  );
}
