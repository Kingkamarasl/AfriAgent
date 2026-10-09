/**
 * Tenant-local date boundaries.
 *
 * A shop in Lagos asking for "today's sales" means their today, not UTC's --
 * at 22:00 local, UTC is already tomorrow and the report would be empty or,
 * worse, wrong. Every reporting query resolves its window through here using
 * the tenant's configured IANA timezone.
 */

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );
  return asUTC - date.getTime();
}

/** The UTC instant of midnight in `timeZone` on the day containing `date`. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes converge because the first offset is within a few hours of truth.
  const firstPass = new Date(guess - tzOffsetMs(new Date(guess), timeZone));
  return new Date(guess - tzOffsetMs(firstPass, timeZone));
}

export function endOfDayInZone(date: Date, timeZone: string): Date {
  const start = startOfDayInZone(date, timeZone);
  // +24h in wall-clock terms is not +24h in UTC across DST; resolve via the zone.
  return startOfDayInZone(new Date(start.getTime() + 26 * 60 * 60 * 1000), timeZone);
}

export function daysAgoInZone(n: number, timeZone: string, from = new Date()): Date {
  return startOfDayInZone(new Date(from.getTime() - n * 86_400_000), timeZone);
}
