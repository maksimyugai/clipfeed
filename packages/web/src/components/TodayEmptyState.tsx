import { useEffect, useState } from "preact/hooks";
import type { Dictionary } from "../i18n.ts";
import { formatCountdown, nextAgentRunMs } from "../lib/agentSchedule.ts";

const TICK_MS = 60_000;

export interface TodayEmptyStateProps {
  dict: Dictionary;
  agentHourUtc: number | null;
  onReadYesterday: () => void;
}

// Rendered in place of Today's normal (hidden-when-empty) section body —
// see Feed.tsx — when the browser-local "today" bucket has zero articles.
// Ticks its own countdown every minute rather than relying on a parent
// re-render; agentHourUtc is fetched once by App.tsx (see
// lib/agentSchedule.ts's loadAgentSchedule) and passed straight through.
export function TodayEmptyState({ dict, agentHourUtc, onReadYesterday }: TodayEmptyStateProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (agentHourUtc === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [agentHourUtc]);

  return (
    <div class="today-empty-state">
      <p class="today-empty-message">{dict.todayEmptyMessage}</p>
      {agentHourUtc === null
        ? <p class="today-empty-countdown">{dict.todayAgentDisabled}</p>
        : (() => {
          const remainingMs = nextAgentRunMs(agentHourUtc, new Date(now)) - now;
          const countdown = formatCountdown(remainingMs);
          return (
            <p class="today-empty-countdown">
              {countdown.lessThanMinute
                ? dict.todayCountdownLessThanMinute
                : `${dict.todayCountdownPrefix} ${countdown.hours}${dict.todayCountdownHoursUnit} ${countdown.minutes}${dict.todayCountdownMinutesUnit}`}
            </p>
          );
        })()}
      <button type="button" class="today-empty-yesterday-link" onClick={onReadYesterday}>
        {dict.todayReadYesterdayLink}
      </button>
    </div>
  );
}
