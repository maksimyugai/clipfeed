// Task 37 §6: caps how many POST .../translate calls the SPA fires at once
// when the owner switches to EN mode — "max 3 in flight, queued FIFO, never
// in bulk". Replaces Task 35 Part A §4's bare slot-counter (which only
// gated concurrency, not *when* a card was even allowed to ask): every
// mounted card used to attempt a request the instant it needed English,
// which is what caused the reported bug (19 cards all showing "Preparing
// English version…" simultaneously). Callers (ArticleCard.tsx) are now
// expected to gate the request itself on viewport visibility (an
// IntersectionObserver) or the card being expanded, and only ask this queue
// to run the actual network call once that condition is met.
export const MAX_CONCURRENT_TRANSLATIONS = 3;

export interface TranslateQueue {
  // Runs `run()` for `id` once a slot is available — immediately if the
  // queue has capacity, otherwise FIFO-queued behind whatever's already
  // waiting. A no-op if `id` is already queued or in flight (dedupe): a
  // card that re-requests before its first request settles doesn't get a
  // second concurrent call. `priority` (an expanded card — the reader is
  // looking at it right now) queues ahead of every non-priority entry,
  // though never ahead of requests already in flight (their slots are
  // already committed).
  request(id: string, run: () => Promise<void>, options?: { priority?: boolean }): void;
  // Drops every not-yet-started (queued) id — used when the reader
  // switches back to RU, so no further pending requests fire. Already-in-
  // flight calls are left alone; whatever they return is still stored and
  // reused (see ArticleCard's onArticleUpdate).
  cancelQueued(): void;
  // Drops a single id if it's still queued (a no-op if it's already in
  // flight, or not listed at all) — used when a card that was merely
  // waiting for a slot unmounts (the reader navigated/filtered it away)
  // before its turn came up, so it doesn't fire once it's no longer shown.
  cancel(id: string): void;
  isQueued(id: string): boolean;
  isInFlight(id: string): boolean;
  // Queued OR in flight — what the "preparing English version…" skeleton
  // should key off of (see ArticleCard.tsx).
  isPending(id: string): boolean;
}

interface QueueItem {
  id: string;
  run: () => Promise<void>;
}

export function createTranslateQueue(
  maxConcurrent: number = MAX_CONCURRENT_TRANSLATIONS,
): TranslateQueue {
  // Two FIFO lists instead of one so priority entries can always be drained
  // ahead of ordinary ones without disturbing FIFO order within either
  // group — see the `pump` loop below.
  const priorityQueued: QueueItem[] = [];
  const normalQueued: QueueItem[] = [];
  const inFlight = new Set<string>();

  function isListed(id: string): boolean {
    return priorityQueued.some((item) => item.id === id) ||
      normalQueued.some((item) => item.id === id);
  }

  function pump(): void {
    while (inFlight.size < maxConcurrent) {
      const item = priorityQueued.shift() ?? normalQueued.shift();
      if (!item) return;
      inFlight.add(item.id);
      item.run().finally(() => {
        inFlight.delete(item.id);
        pump();
      });
    }
  }

  return {
    request(id, run, options) {
      if (inFlight.has(id)) return;

      const priority = options?.priority ?? false;
      if (priority) {
        // An already-queued (non-priority) card that just got expanded
        // jumps to the front instead of being requested twice.
        const existingIndex = normalQueued.findIndex((item) => item.id === id);
        if (existingIndex !== -1) {
          const [item] = normalQueued.splice(existingIndex, 1);
          priorityQueued.push(item);
          pump();
          return;
        }
      }

      if (isListed(id)) return;
      (priority ? priorityQueued : normalQueued).push({ id, run });
      pump();
    },
    cancelQueued() {
      priorityQueued.length = 0;
      normalQueued.length = 0;
    },
    cancel(id) {
      const priorityIndex = priorityQueued.findIndex((item) => item.id === id);
      if (priorityIndex !== -1) {
        priorityQueued.splice(priorityIndex, 1);
        return;
      }
      const normalIndex = normalQueued.findIndex((item) => item.id === id);
      if (normalIndex !== -1) normalQueued.splice(normalIndex, 1);
    },
    isQueued(id) {
      return priorityQueued.some((item) => item.id === id) ||
        normalQueued.some((item) => item.id === id);
    },
    isInFlight(id) {
      return inFlight.has(id);
    },
    isPending(id) {
      return inFlight.has(id) || isListed(id);
    },
  };
}

// Single shared queue for the whole SPA — every mounted ArticleCard needing
// a translation requests against this same instance.
export const translateQueue: TranslateQueue = createTranslateQueue();
