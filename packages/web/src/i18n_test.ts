import { assertEquals } from "@std/assert";
import { dictionaries, isLang, readStoredLang, viaLabel, writeStoredLang } from "./i18n.ts";

Deno.test("dictionaries: ru and en have exactly the same set of keys", () => {
  const ruKeys = Object.keys(dictionaries.ru).sort();
  const enKeys = Object.keys(dictionaries.en).sort();
  assertEquals(ruKeys, enKeys);
});

Deno.test("dictionaries: no value is an empty string in either language", () => {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      if (value.trim() === "") {
        throw new Error(`${lang}.${key} is empty`);
      }
    }
  }
});

Deno.test("isLang: accepts only 'ru' and 'en'", () => {
  assertEquals(isLang("ru"), true);
  assertEquals(isLang("en"), true);
  assertEquals(isLang("fr"), false);
  assertEquals(isLang(null), false);
  assertEquals(isLang(""), false);
});

function makeFakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
}

Deno.test("readStoredLang: defaults to 'ru' when nothing stored", () => {
  const storage = makeFakeStorage();
  assertEquals(readStoredLang(storage), "ru");
});

Deno.test("readStoredLang: defaults to 'ru' when stored value is invalid", () => {
  const storage = makeFakeStorage({ "clipfeed-lang": "fr" });
  assertEquals(readStoredLang(storage), "ru");
});

Deno.test("readStoredLang: reads a valid stored value", () => {
  const storage = makeFakeStorage({ "clipfeed-lang": "en" });
  assertEquals(readStoredLang(storage), "en");
});

Deno.test("writeStoredLang: round-trips through readStoredLang", () => {
  const storage = makeFakeStorage();
  writeStoredLang(storage, "en");
  assertEquals(readStoredLang(storage), "en");
});

Deno.test("viaLabel: maps each added_via value per language", () => {
  assertEquals(viaLabel(dictionaries.ru, "manual"), "вручную");
  assertEquals(viaLabel(dictionaries.ru, "extension"), "расширением");
  assertEquals(viaLabel(dictionaries.ru, "agent"), "агентом");
  assertEquals(viaLabel(dictionaries.en, "manual"), "manually");
  assertEquals(viaLabel(dictionaries.en, "extension"), "via extension");
  assertEquals(viaLabel(dictionaries.en, "agent"), "by the agent");
});
