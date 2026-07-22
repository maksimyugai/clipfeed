// A Telegram drip post links to "PUBLIC_BASE_URL + /#article-<id>" (see
// README "Telegram bot") so the reader lands on that exact card instead of
// the top of the default feed. Kept pure/dependency-free so hash parsing
// and the "already loaded vs needs its own fetch" decision are both
// unit-testable without mounting App.tsx.
const HASH_PREFIX = "#article-";

export function parseArticleHash(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = hash.slice(HASH_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function isArticleInList(id: string, articles: readonly { id: string }[]): boolean {
  return articles.some((a) => a.id === id);
}
