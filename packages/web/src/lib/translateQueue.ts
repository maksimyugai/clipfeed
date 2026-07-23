// Task 35 Part A §4: caps how many POST .../translate calls the SPA fires
// at once when the owner switches to EN mode and several visible cards lack
// an English edition — "max 5 concurrently, never in bulk" per the task.
// Kept as a small factory (not bare module state) so tests get a fresh,
// isolated queue per case instead of fighting shared mutable state between
// runs; the app itself uses a single module-level instance (see
// ArticleCard.tsx) since concurrency must be capped across every mounted
// card, not per card.
export const MAX_CONCURRENT_TRANSLATIONS = 5;

export interface TranslateQueue {
  // True when this id isn't already in flight and there's a free slot.
  canEnqueue(id: string): boolean;
  start(id: string): void;
  finish(id: string): void;
}

export function createTranslateQueue(
  maxConcurrent: number = MAX_CONCURRENT_TRANSLATIONS,
): TranslateQueue {
  const inFlight = new Set<string>();
  return {
    canEnqueue(id: string): boolean {
      return !inFlight.has(id) && inFlight.size < maxConcurrent;
    },
    start(id: string): void {
      inFlight.add(id);
    },
    finish(id: string): void {
      inFlight.delete(id);
    },
  };
}

// Single shared queue for the whole SPA — every mounted ArticleCard needing
// a translation checks/reserves slots against this same instance.
export const translateQueue: TranslateQueue = createTranslateQueue();
