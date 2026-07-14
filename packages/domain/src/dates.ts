export type DateOrdinal = number & { readonly __dateOrdinal: unique symbol };

const isoPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

// Howard Hinnant's civil-date algorithms keep planner dates independent of runtime time zones.
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(ordinal: number): { year: number; month: number; day: number } {
  const shifted = ordinal + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

export function parseLocalDate(value: string): DateOrdinal {
  const match = isoPattern.exec(value);
  if (!match) throw new Error("Date must use strict YYYY-MM-DD format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new Error("Date is not a valid calendar day");
  }
  return daysFromCivil(year, month, day) as DateOrdinal;
}

export function formatLocalDate(ordinal: DateOrdinal): string {
  if (!Number.isSafeInteger(ordinal)) throw new Error("Date ordinal must be an integer");
  const { year, month, day } = civilFromDays(ordinal);
  if (year < 1 || year > 9999) throw new Error("Date ordinal is outside supported range");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(ordinal: DateOrdinal, days: number): DateOrdinal {
  if (!Number.isSafeInteger(days)) throw new Error("Day offset must be an integer");
  return (ordinal + days) as DateOrdinal;
}

export function isoWeekday(ordinal: DateOrdinal): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  return (((((ordinal + 3) % 7) + 7) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export function eachDate(start: DateOrdinal, end: DateOrdinal): DateOrdinal[] {
  if (end < start) throw new Error("Date range end must not precede start");
  return Array.from({ length: end - start + 1 }, (_, index) => addDays(start, index));
}

const supportedTimezones = new Set<string>([
  "UTC",
  ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
]);

export function validateIanaTimezone(timezone: string): string {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timezone) && timezone !== "UTC") {
    throw new Error("Timezone must be an allowlisted IANA identifier");
  }
  if (!supportedTimezones.has(timezone))
    throw new Error("Timezone is not supported by this runtime");
  return timezone;
}

export function plannerDateForInstant(instant: Date, timezone: string): string {
  if (Number.isNaN(instant.getTime())) throw new Error("Planner instant is invalid");
  const safeTimezone = validateIanaTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Planner date formatting failed");
  const localDate = `${year}-${month}-${day}`;
  parseLocalDate(localDate);
  return localDate;
}
