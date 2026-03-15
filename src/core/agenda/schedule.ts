import type { AssistantAgendaSchedule } from "./types";

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

const MINUTE_MS = 60_000;

export function computeNextWakeAt(params: {
  schedule: AssistantAgendaSchedule;
  timezone: string;
  afterIso: string;
}): string | null {
  if (params.schedule.type === "once") {
    const local = parseLocalDateTime(params.schedule.atLocal);
    const utc = zonedLocalToUtc(local, params.timezone);
    return utc > Date.parse(params.afterIso) ? new Date(utc).toISOString() : null;
  }

  const interval = Math.max(1, Math.trunc(params.schedule.interval ?? 1));
  const nowMs = Date.parse(params.afterIso);
  const afterLocal = getLocalDateTime(nowMs, params.timezone);
  const candidates = buildRecurringCandidates(afterLocal, params.schedule, interval);
  for (const candidate of candidates) {
    const utc = zonedLocalToUtc(candidate, params.timezone);
    if (utc > nowMs) return new Date(utc).toISOString();
  }
  return null;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function buildRecurringCandidates(
  afterLocal: LocalDateTime,
  schedule: Extract<AssistantAgendaSchedule, { type: "recurring" }>,
  interval: number,
): LocalDateTime[] {
  const [hour, minute] = parseLocalTime(schedule.atLocalTime);
  const start = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day);
  const candidates: LocalDateTime[] = [];

  for (let offset = 0; offset <= 550; offset += 1) {
    const date = new Date(start + offset * 86_400_000);
    const localDate = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    } satisfies LocalDate;
    if (!matchesCadence(localDate, afterLocal, schedule, interval)) continue;
    candidates.push({ ...localDate, hour, minute });
  }

  return candidates;
}

function matchesCadence(
  candidate: LocalDate,
  anchor: LocalDateTime,
  schedule: Extract<AssistantAgendaSchedule, { type: "recurring" }>,
  interval: number,
): boolean {
  switch (schedule.cadence) {
    case "daily":
      return daysBetween(anchor, candidate) % interval === 0;
    case "weekdays": {
      const weekday = dayOfWeek(candidate);
      return weekday >= 1 && weekday <= 5 && daysBetween(anchor, candidate) % interval === 0;
    }
    case "weekly": {
      const days = (schedule.daysOfWeek?.length ? schedule.daysOfWeek : [dayOfWeek(anchor)]).filter(
        (value, index, list) => value >= 0 && value <= 6 && list.indexOf(value) === index,
      );
      if (!days.includes(dayOfWeek(candidate))) return false;
      return weeksBetween(anchor, candidate) % interval === 0;
    }
    case "monthly": {
      const dayOfMonth = Math.max(1, Math.min(31, Math.trunc(schedule.dayOfMonth ?? anchor.day)));
      const expectedDay = Math.min(dayOfMonth, daysInMonth(candidate.year, candidate.month));
      if (candidate.day !== expectedDay) return false;
      return monthsBetween(anchor, candidate) % interval === 0;
    }
  }
}

function parseLocalDateTime(input: string): LocalDateTime {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error(`Invalid local datetime: ${input}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function parseLocalTime(input: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error(`Invalid local time: ${input}`);
  return [Number(match[1]), Number(match[2])];
}

function zonedLocalToUtc(local: LocalDateTime, timezone: string): number {
  let guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  for (let index = 0; index < 4; index += 1) {
    const zoned = getLocalDateTime(guess, timezone);
    const deltaMinutes = compareLocalDateTime(local, zoned);
    if (deltaMinutes === 0) return guess;
    guess += deltaMinutes * MINUTE_MS;
  }
  return guess;
}

function getLocalDateTime(timestamp: number, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year") ?? 0),
    month: Number(values.get("month") ?? 0),
    day: Number(values.get("day") ?? 0),
    hour: Number(values.get("hour") ?? 0),
    minute: Number(values.get("minute") ?? 0),
  };
}

function compareLocalDateTime(left: LocalDateTime, right: LocalDateTime): number {
  const leftValue = Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute);
  const rightValue = Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
  return Math.round((leftValue - rightValue) / MINUTE_MS);
}

function dayOfWeek(date: LocalDate | LocalDateTime): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function daysBetween(anchor: LocalDate, candidate: LocalDate): number {
  const left = Date.UTC(anchor.year, anchor.month - 1, anchor.day);
  const right = Date.UTC(candidate.year, candidate.month - 1, candidate.day);
  return Math.floor((right - left) / 86_400_000);
}

function weeksBetween(anchor: LocalDate, candidate: LocalDate): number {
  return Math.floor(daysBetween(anchor, candidate) / 7);
}

function monthsBetween(anchor: LocalDate, candidate: LocalDate): number {
  return (candidate.year - anchor.year) * 12 + (candidate.month - anchor.month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
