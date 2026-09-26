/*
 * Date Intelligence — resolves natural-language periods to half-open business-day ranges.
 * All dates are resolved on the backend in BUSINESS_TIMEZONE; "today" is never hardcoded.
 */
import { businessToday, getDateRange, shiftDate, type DateRange, type SalesPeriodName } from "./sapSales.service";

export type CustomPeriodKind = "CUSTOM_DATE" | "CUSTOM_RANGE" | "SPECIFIC_MONTH" | "SPECIFIC_YEAR";
export type PeriodKind = SalesPeriodName | CustomPeriodKind;

export interface ResolvedPeriod {
  kind: PeriodKind;
  startDate: string;
  endDateExclusive: string;
  /** Text that matched, so callers can strip it before looking for sales order numbers. */
  matched: string;
}

export const NAMED_PERIODS: SalesPeriodName[] = [
  "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "LAST_QUARTER", "THIS_YEAR", "LAST_YEAR",
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = MONTHS.map((month) => month.slice(0, 3));
const MONTH_PATTERN = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MAX_RANGE_DAYS = 400;

function monthIndex(token: string): number {
  return MONTH_SHORT.indexOf(token.slice(0, 3).toLowerCase());
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoOf(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function nextMonthStart(year: number, month: number): string {
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

function prettyDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

/** Named relative periods (today, this month, last quarter, ...). */
export function resolveNamedPeriod(text: string): SalesPeriodName | null {
  if (/\b(last|previous|prior) year\b/.test(text)) return "LAST_YEAR";
  if (/\b(this|current) year\b|year to date|\bytd\b|yearly/.test(text)) return "THIS_YEAR";
  if (/\b(last|previous|prior) quarter\b/.test(text)) return "LAST_QUARTER";
  if (/\b(this|current) quarter\b|quarterly/.test(text)) return "THIS_QUARTER";
  if (/\b(last|previous|prior) month\b/.test(text)) return "LAST_MONTH";
  if (/\b(this|current) month\b|monthly|month to date|\bmtd\b/.test(text)) return "THIS_MONTH";
  if (/\b(last|previous|prior) week\b/.test(text)) return "LAST_WEEK";
  if (/\b(this|current) week\b|weekly/.test(text)) return "THIS_WEEK";
  if (/\byesterday\b/.test(text)) return "YESTERDAY";
  if (/\btoday\b|today'?s/.test(text)) return "TODAY";
  return null;
}

function yearFor(explicit: string | undefined, today: string): number {
  return explicit ? Number(explicit) : Number(today.slice(0, 4));
}

/**
 * Resolve custom dates, ranges, specific months and years. Returns null when the text has none.
 * Examples: "from September 1 to September 25", "between sep 1 and sep 25 2026",
 * "2026-09-01 to 2026-09-10", "on September 5", "September 2026 sales", "sales in 2025".
 */
export function resolveCustomPeriod(text: string, now = new Date()): ResolvedPeriod | null {
  const today = businessToday(now).date;

  const isoRange = text.match(/(\d{4})-(\d{2})-(\d{2})\s*(?:to|until|till|through|-|–|and)\s*(\d{4})-(\d{2})-(\d{2})/);
  if (isoRange) {
    const start = isoOf(Number(isoRange[1]), Number(isoRange[2]), Number(isoRange[3]));
    const end = isoOf(Number(isoRange[4]), Number(isoRange[5]), Number(isoRange[6]));
    if (start && end) return { kind: "CUSTOM_RANGE", startDate: start, endDateExclusive: shiftDate(end, 1), matched: isoRange[0] };
  }

  const monthDayRange = new RegExp(
    `(?:from|between)?\\s*${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\s*(?:to|until|till|through|and|-|–)\\s*(?:${MONTH_PATTERN}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`,
  );
  const mdr = text.match(monthDayRange);
  if (mdr) {
    const startMonth = monthIndex(mdr[1]) + 1;
    const endMonth = mdr[4] ? monthIndex(mdr[4]) + 1 : startMonth;
    const endYear = yearFor(mdr[6] ?? mdr[3], today);
    const startYear = mdr[3] ? Number(mdr[3]) : endYear;
    const start = isoOf(startYear, startMonth, Number(mdr[2]));
    const end = isoOf(endYear, endMonth, Number(mdr[5]));
    if (start && end) return { kind: "CUSTOM_RANGE", startDate: start, endDateExclusive: shiftDate(end, 1), matched: mdr[0] };
  }

  const isoDay = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDay) {
    const day = isoOf(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
    if (day) return { kind: "CUSTOM_DATE", startDate: day, endDateExclusive: shiftDate(day, 1), matched: isoDay[0] };
  }

  const dayMonth = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}(?:,?\\s*(\\d{4}))?\\b`));
  const monthDay = text.match(new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`));
  if (dayMonth || monthDay) {
    const [monthToken, dayToken, yearToken, matched] = dayMonth
      ? [dayMonth[2], dayMonth[1], dayMonth[3], dayMonth[0]]
      : [monthDay![1], monthDay![2], monthDay![3], monthDay![0]];
    const day = isoOf(yearFor(yearToken, today), monthIndex(monthToken) + 1, Number(dayToken));
    if (day) return { kind: "CUSTOM_DATE", startDate: day, endDateExclusive: shiftDate(day, 1), matched };
  }

  const specificMonth = text.match(new RegExp(`\\b${MONTH_PATTERN}\\b(?:\\s+(\\d{4}))?`));
  if (specificMonth && !/\bmay\s+(i|we|you)\b/.test(text)) {
    const month = monthIndex(specificMonth[1]) + 1;
    let year = yearFor(specificMonth[2], today);
    // "December sales" in September means last December, not a future month.
    if (!specificMonth[2] && `${year}-${pad(month)}-01` > today) year -= 1;
    const start = `${year}-${pad(month)}-01`;
    return { kind: "SPECIFIC_MONTH", startDate: start, endDateExclusive: nextMonthStart(year, month), matched: specificMonth[0] };
  }

  const specificYear = text.match(/\b(?:in|for|during|year|of|fy)\s+((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s+(?:sales|orders|report|summary|dashboard)\b/);
  if (specificYear) {
    const year = Number(specificYear[1] ?? specificYear[2]);
    return { kind: "SPECIFIC_YEAR", startDate: `${year}-01-01`, endDateExclusive: `${year + 1}-01-01`, matched: specificYear[0] };
  }

  return null;
}

export interface PeriodSpec {
  period: PeriodKind;
  dateRange?: { startDate: string; endDateExclusive: string };
}

/** Resolve any period (custom first, since "September 1 to 25" must beat "this month"). */
export function resolvePeriodSpec(text: string, now = new Date()): (PeriodSpec & { matched?: string }) | null {
  const lower = text.toLowerCase();
  const custom = resolveCustomPeriod(lower, now);
  if (custom) {
    return { period: custom.kind, dateRange: { startDate: custom.startDate, endDateExclusive: custom.endDateExclusive }, matched: custom.matched };
  }
  const named = resolveNamedPeriod(lower);
  return named ? { period: named } : null;
}

function customLabel(kind: CustomPeriodKind, startDate: string, endDateExclusive: string): string {
  const endInclusive = shiftDate(endDateExclusive, -1);
  switch (kind) {
    case "CUSTOM_DATE":
      return prettyDate(startDate);
    case "SPECIFIC_MONTH": {
      const [year, month] = startDate.split("-").map(Number);
      return `${MONTH_NAMES[month - 1]} ${year}`;
    }
    case "SPECIFIC_YEAR":
      return `Year ${startDate.slice(0, 4)}`;
    case "CUSTOM_RANGE":
      return `${prettyDate(startDate)} – ${prettyDate(endInclusive)}`;
  }
}

/** Build the concrete date range for a plan period. */
export function rangeForSpec(spec: PeriodSpec, now = new Date()): DateRange {
  if ((NAMED_PERIODS as string[]).includes(spec.period)) {
    return getDateRange(spec.period as SalesPeriodName, now);
  }
  if (!spec.dateRange) throw new Error("Custom period without a date range.");
  const { startDate, endDateExclusive } = spec.dateRange;
  return {
    period: spec.period as SalesPeriodName,
    start: `${startDate}T00:00:00`,
    end: `${endDateExclusive}T00:00:00`,
    startDate,
    endDateExclusive,
    label: customLabel(spec.period as CustomPeriodKind, startDate, endDateExclusive),
  };
}

/** Validate a custom range: real ISO dates, start before end, bounded span. */
export function validateDateRange(spec: PeriodSpec): string | null {
  if ((NAMED_PERIODS as string[]).includes(spec.period)) return null;
  if (!["CUSTOM_DATE", "CUSTOM_RANGE", "SPECIFIC_MONTH", "SPECIFIC_YEAR"].includes(spec.period)) return `unknown period ${spec.period}`;
  const range = spec.dateRange;
  if (!range) return "custom period needs dateRange";
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(range.startDate) || !iso.test(range.endDateExclusive)) return "dates must be YYYY-MM-DD";
  const [sy, sm, sd] = range.startDate.split("-").map(Number);
  const [ey, em, ed] = range.endDateExclusive.split("-").map(Number);
  if (!isoOf(sy, sm, sd) || !isoOf(ey, em, ed)) return "invalid calendar date";
  if (range.startDate >= range.endDateExclusive) return "start must be before end";
  const days = (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000;
  if (days > MAX_RANGE_DAYS) return `range exceeds ${MAX_RANGE_DAYS} days`;
  return null;
}

/** The comparable previous period: previous month for months, previous year for years, else same-length window. */
export function previousSpec(spec: PeriodSpec, now = new Date()): PeriodSpec {
  const named: Partial<Record<PeriodKind, SalesPeriodName>> = {
    TODAY: "YESTERDAY",
    THIS_WEEK: "LAST_WEEK",
    THIS_MONTH: "LAST_MONTH",
    THIS_QUARTER: "LAST_QUARTER",
    THIS_YEAR: "LAST_YEAR",
  };
  const mapped = named[spec.period];
  if (mapped) return { period: mapped };
  const range = rangeForSpec(spec, now);
  if (spec.period === "SPECIFIC_MONTH" || spec.period === "LAST_MONTH") {
    const [year, month] = range.startDate.split("-").map(Number);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    return { period: "SPECIFIC_MONTH", dateRange: { startDate: `${prevYear}-${pad(prevMonth)}-01`, endDateExclusive: range.startDate } };
  }
  if (spec.period === "SPECIFIC_YEAR" || spec.period === "LAST_YEAR") {
    const year = Number(range.startDate.slice(0, 4)) - 1;
    return { period: "SPECIFIC_YEAR", dateRange: { startDate: `${year}-01-01`, endDateExclusive: `${year + 1}-01-01` } };
  }
  const [sy, sm, sd] = range.startDate.split("-").map(Number);
  const [ey, em, ed] = range.endDateExclusive.split("-").map(Number);
  const days = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
  return { period: "CUSTOM_RANGE", dateRange: { startDate: shiftDate(range.startDate, -days), endDateExclusive: range.startDate } };
}

/** True when the range includes today, i.e. the period is still in progress. */
export function isInProgress(range: DateRange, now = new Date()): boolean {
  const today = businessToday(now).date;
  return range.startDate <= today && today < range.endDateExclusive && shiftDate(today, 1) !== range.endDateExclusive;
}
