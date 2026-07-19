export interface PickCandidate {
  id: string;
  added_via: string;
  added_at: string;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Simple heuristic for the agent's "daily pick" highlight: the article must
// be agent-added and be the newest agent-added article added today (UTC
// calendar date). Real curation logic arrives in a later task.
export function isPickOfTheDay(
  article: PickCandidate,
  articles: readonly PickCandidate[],
  now: Date = new Date(),
): boolean {
  if (article.added_via !== "agent") return false;

  const todayKey = dateKey(now);
  if (dateKey(new Date(article.added_at)) !== todayKey) return false;

  const todaysAgentArticles = articles.filter(
    (a) => a.added_via === "agent" && dateKey(new Date(a.added_at)) === todayKey,
  );
  if (todaysAgentArticles.length === 0) return false;

  const newest = todaysAgentArticles.reduce((latest, current) =>
    new Date(current.added_at).getTime() > new Date(latest.added_at).getTime() ? current : latest
  );

  return newest.id === article.id;
}
