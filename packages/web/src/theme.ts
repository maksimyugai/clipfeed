import { useEffect, useState } from "preact/hooks";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "clipfeed-theme";

export function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

export function readStoredTheme(storage: Pick<Storage, "getItem">): Theme | null {
  const stored = storage.getItem(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : null;
}

export function writeStoredTheme(storage: Pick<Storage, "setItem">, theme: Theme): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
}

// Explicit user choice (localStorage) wins; otherwise fall back to the
// system preference.
export function resolveInitialTheme(
  storage: Pick<Storage, "getItem">,
  prefersDark: boolean,
): Theme {
  return readStoredTheme(storage) ?? (prefersDark ? "dark" : "light");
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveInitialTheme(localStorage, matchMedia("(prefers-color-scheme: dark)").matches)
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writeStoredTheme(localStorage, theme);
  }, [theme]);

  const toggle = () => setTheme((current) => (current === "dark" ? "light" : "dark"));
  return [theme, toggle];
}
