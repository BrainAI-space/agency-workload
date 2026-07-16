import { type DateOrdinal, parseLocalDate, validateIanaTimezone } from "@agency-workload/domain";
import { HttpError } from "./errors.js";

export function parsePlanningDate(value: string): DateOrdinal {
  try {
    return parseLocalDate(value);
  } catch {
    throw new HttpError(400, "invalid_calendar_date");
  }
}

export function validatePlanningRange(start: string, end?: string | null): DateOrdinal {
  const startOrdinal = parsePlanningDate(start);
  if (end !== undefined && end !== null && parsePlanningDate(end) < startOrdinal) {
    throw new HttpError(400, "invalid_date_range");
  }
  return startOrdinal;
}

export function validatePlanningTimezone(timezone: string): string {
  try {
    return validateIanaTimezone(timezone);
  } catch {
    throw new HttpError(400, "invalid_timezone");
  }
}
