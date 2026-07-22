// A Telegram drip post links to "PUBLIC_BASE_URL + /a/<id>" (see README
// "Telegram bot") — a real path, required so link-preview crawlers (which
// only ever fetch raw HTML, never a hash fragment) can see it; see
// GET /a/:id in packages/api/src/index.ts. The legacy hash form
// ("#article-<id>", Task 29) is still parsed so already-published posts
// keep working. Kept pure/dependency-free so parsing and the "already
// loaded vs needs its own fetch" decision are both unit-testable without
// mounting App.tsx.
const HASH_PREFIX = "#article-";
const PATH_PREFIX = "/a/";

export function parseArticleHash(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = hash.slice(HASH_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function parseArticlePath(pathname: string): string | null {
  if (!pathname.startsWith(PATH_PREFIX)) return null;
  const id = pathname.slice(PATH_PREFIX.length);
  return id.length > 0 ? id : null;
}

// The path form takes priority — a URL can't meaningfully have both, but
// if it somehow did, the real path is the more deliberate signal.
export function parseDeepLinkId(pathname: string, hash: string): string | null {
  return parseArticlePath(pathname) ?? parseArticleHash(hash);
}

export function isArticleInList(id: string, articles: readonly { id: string }[]): boolean {
  return articles.some((a) => a.id === id);
}
