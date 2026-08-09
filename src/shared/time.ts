/**
 * Timezone-correct wall-clock helpers (no external tz library; IANA data
 * comes from Intl). All scheduling logic computes in the property's zone.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function tzOffsetMs(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/**
 * The UTC instant at which the given wall clock occurs in the zone.
 * Two-pass so DST transition days resolve to the post-shift offset.
 */
export function wallClockToUtc(
  timeZone: string,
  date: LocalDate,
  hour: number,
  minute: number,
): Date {
  const base = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let ts = base - tzOffsetMs(timeZone, new Date(base));
  ts = base - tzOffsetMs(timeZone, new Date(ts));
  return new Date(ts);
}

/** The local calendar date of an instant in the zone. */
export function localDateOf(timeZone: string, at: Date): LocalDate {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = dtf.format(at).split('-').map(Number);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
