import { bucketSection } from "./dateGrouping.ts";

// The initial per-filter load fetches page after page until Today+Yesterday
// are fully covered, then stops — "Earlier" is lazy from there. Because the
// server orders `added_at DESC`, the first "earlier"-bucketed item seen in
// the stream is proof every item before it (this page and all prior ones)
// is today/yesterday: nothing later in a DESC stream can be newer. So the
// loop only needs to keep going while a page contains zero "earlier" items
// and the server says there's more to fetch.
export function shouldFetchNextInitialPage(
  pageItems: readonly { added_at: string }[],
  nextCursor: string | null,
  now: Date = new Date(),
): boolean {
  if (nextCursor === null) return false;
  return pageItems.every((item) => bucketSection(item.added_at, now) !== "earlier");
}

// "Earlier" starts collapsed; its first page loads only once the user
// expands it. If the initial-load loop above already picked up some
// "earlier" items as the tail of a boundary page, no extra fetch is needed
// on that first expand — only fetch when Earlier is still genuinely empty
// but the server has more data to give (nextCursor !== null).
export function shouldFetchOnEarlierExpand(
  earlierItemCount: number,
  nextCursor: string | null,
): boolean {
  return earlierItemCount === 0 && nextCursor !== null;
}
