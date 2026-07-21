// Task 24 Part D: powers the empty-Today countdown ("new articles in
// Xh Ym"). agent_hour_utc is a UTC hour (0-23) or null (agent disabled) —
// see GET /api/config in packages/api/src/index.ts.
//
// All arithmetic below works in absolute epoch milliseconds (Date.UTC /
// getTime), never local-calendar fields — that's what makes it DST-safe:
// a UTC hour occurs at exactly one absolute instant per UTC day regardless
// of the visitor's timezone or any local DST transition, so there's no
// local-midnight-boundary edge case to get wrong in the first place (unlike
// dateGrouping.ts's Today/Yesterday bucketing, which buckets by LOCAL
// calendar day and genuinely needs that care). The result naturally renders
// correctly in the visitor's own local clock once formatted, without this
// module needing to know what timezone they're in.
export function nextAgentRunMs(hourUtc: number, now: Date): number {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0,
  ));
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.getTime();
}

export interface Countdown {
  hours: number;
  minutes: number;
  // True once under a minute remains (or the target has already passed,
  // e.g. a stale fetch racing the actual agent run) — the display falls
  // back to a single "less than a minute" message instead of "0h 0m".
  lessThanMinute: boolean;
}

const ONE_MINUTE_MS = 60_000;

// Under a minute remaining is always the "less than a minute" edge case,
// checked before any rounding — otherwise Math.ceil would round e.g. 30s up
// to a misleading "1m". At or above a minute, rounds UP to the next whole
// minute so the display never undercounts (e.g. 61s left reads "2m", not
// "1m") — ticking the calling component every 60s (see
// TodayEmptyState.tsx) keeps this from visibly drifting.
export function formatCountdown(msRemaining: number): Countdown {
  const clamped = Math.max(0, msRemaining);
  if (clamped < ONE_MINUTE_MS) return { hours: 0, minutes: 0, lessThanMinute: true };
  const totalMinutes = Math.ceil(clamped / ONE_MINUTE_MS);
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    lessThanMinute: false,
  };
}

export interface AgentScheduleConfig {
  agentHourUtc: number | null;
  agentDailyPicks: number;
}

const CONFIG_URL = "/api/config";
const DEFAULT_AGENT_DAILY_PICKS = 10;

let scheduleCache: AgentScheduleConfig | undefined;

// Same fetch-once-and-cache convention as turnstile.ts's
// loadTurnstileSiteKey — a fetch failure degrades to "disabled" (null hour),
// never blocks rendering the empty-Today state.
export async function loadAgentSchedule(): Promise<AgentScheduleConfig> {
  if (scheduleCache !== undefined) return scheduleCache;
  try {
    const res = await fetch(CONFIG_URL);
    const body = await res.json() as {
      agent_hour_utc?: number | null;
      agent_daily_picks?: number;
    };
    scheduleCache = {
      agentHourUtc: typeof body.agent_hour_utc === "number" ? body.agent_hour_utc : null,
      agentDailyPicks: typeof body.agent_daily_picks === "number"
        ? body.agent_daily_picks
        : DEFAULT_AGENT_DAILY_PICKS,
    };
  } catch {
    scheduleCache = { agentHourUtc: null, agentDailyPicks: DEFAULT_AGENT_DAILY_PICKS };
  }
  return scheduleCache;
}
