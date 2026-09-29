/*
 * Evolv Sales Assistant (prompt v3.0): read-only answers about SAP Sales order items.
 * With a real AI_API_KEY the LLM follows the v3.0 prompt and calls the six sales tools.
 * Without one (or if the LLM fails) a rule planner calls the same tools and answers in the same style.
 * Role / allowed plants come from the signed portal context (salesAccess.service), never from the chat.
 */
import { buildSalesAssistantPrompt } from "../prompts/salesAssistant.prompt";
import { obs } from "./audit.service";
import { allowedPlantsText, canSeeCost, currentSalesAccess } from "./salesAccess.service";
import { businessToday, shiftDate } from "./sapSales.service";
import {
  comparePeriods,
  displayDate,
  getItemStatus,
  getOrderDetails,
  getSalesSummary,
  runSalesTool,
  SALES_TOOL_DEFINITIONS,
  searchMaterial,
  ToolInputError,
  topN,
  type Dimension,
  type GroupBy,
  type Metric,
  type SalesFilters,
  type StatusType,
} from "./salesAssistantTools.service";
import type { StructuredView } from "./salesPlanner.service";
import { compareOrdersView, orderView, periodView, viewModeFrom, type SalesViewMode, type SalesViewResult } from "./salesViews.service";

export interface SalesAssistantTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SalesAssistantReply {
  message: string;
  suggestions?: Array<{ label: string; question: string }>;
  view?: StructuredView;
}

type Lang = "en" | "ta";

// ---------------------------------------------------------------------------
// LLM path

function llmConfigured(): boolean {
  const key = process.env.AI_API_KEY?.trim();
  return Boolean(key && key !== "your_api_key_here") && process.env.SALES_ASSISTANT_LLM !== "off";
}

function systemPrompt(now: Date): string {
  const today = businessToday(now).date;
  const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const access = currentSalesAccess();
  const prompt = buildSalesAssistantPrompt({
    today: `${displayDate(today)} (${weekday}; tool date arguments use YYYY-MM-DD, today = ${today})`,
    userRole: access.role,
    allowedPlants: allowedPlantsText(access),
    dataAsOf: "Live SAP read at request time (cached up to 2 minutes). Each tool result has data_as_of.",
  });
  return `${prompt}\n# APPLICATION NOTES\nTool results already exclude TAG rows from totals, report FOC separately and hide cost fields for roles without access. Use markdown tables with a header separator row (| --- |).`;
}

interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

async function callLlm(messages: LlmMessage[]): Promise<{ content?: string | null; tool_calls?: LlmToolCall[] }> {
  const baseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY?.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      messages,
      tools: SALES_TOOL_DEFINITIONS,
      tool_choice: "auto",
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`LLM status ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: LlmToolCall[] } }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("LLM returned no message");
  return message;
}

function toolError(error: unknown): { error: string } {
  if (error instanceof ToolInputError) return { error: error.message };
  const kind = (error as { kind?: string }).kind;
  return { error: kind === "timeout" ? "SAP timeout" : "SAP data could not be retrieved" };
}

async function answerWithLlm(message: string, history: SalesAssistantTurn[], now: Date): Promise<string> {
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt(now) },
    ...history.slice(-12).map((turn) => ({ role: turn.role, content: turn.content.slice(0, 4000) })),
    { role: "user", content: message },
  ];
  for (let round = 0; round < 6; round += 1) {
    const reply = await callLlm(messages);
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      const content = reply.content?.trim();
      if (!content) throw new Error("LLM returned an empty answer");
      return content;
    }
    obs("AI_REQUEST", { assistant: "sales", tools: calls.map((call) => call.function.name) });
    messages.push({ role: "assistant", content: reply.content ?? "", tool_calls: calls });
    for (const call of calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        result = await runSalesTool(call.function.name, args, now);
      } catch (error) {
        result = toolError(error);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 60000) });
    }
  }
  throw new Error("Tool calling did not finish");
}

// ---------------------------------------------------------------------------
// Formatting

const amt = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (value: number) => Math.round(value).toLocaleString("en-US");
const code = (value: string) => `\`${value}\``;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function table(headers: string[], rows: string[][]): string {
  return ["", `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`), ""].join("\n");
}

function say(lang: Lang, en: string, ta: string): string {
  return lang === "ta" ? ta : en;
}

const followUps = new Map<string, string>();

function followUp(lang: Lang, en: string, ta: string, question: string): { line: string; suggestion: { label: string; question: string } } {
  const line = say(lang, en, ta);
  followUps.set(line.trim().toLowerCase(), question);
  if (followUps.size > 500) followUps.delete(followUps.keys().next().value as string);
  return { line, suggestion: { label: question.length > 44 ? `${question.slice(0, 42)}…` : question, question } };
}

function finish(lines: Array<string | null | undefined | false>, next?: { line: string; suggestion: { label: string; question: string } }): SalesAssistantReply {
  const body = lines.filter((line): line is string => typeof line === "string" && line.length > 0);
  if (next) body.push(next.line);
  return { message: body.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ...(next ? { suggestions: [next.suggestion] } : {}) };
}

function notesLine(notes: string[]): string | null {
  const unique = [...new Set(notes.filter(Boolean))];
  return unique.length ? `Data notes: ${unique.join(" ")}` : null;
}

function basisLine(period: { from: string; to: string }, dataAsOf?: string): string {
  const when = period.from === period.to ? `on ${displayDate(period.from)}` : `from ${displayDate(period.from)} to ${displayDate(period.to)}`;
  return `Based on items created ${when}.${dataAsOf ? ` Data as of ${dataAsOf}.` : ""}`;
}

function asOfLine(dataAsOf?: string): string | null {
  return dataAsOf ? `Data as of ${dataAsOf}.` : null;
}

// ---------------------------------------------------------------------------
// Parsing

const TANGLISH =
  /\b(evlo|evvalavu|evalo|kaatu|kaattu|kaatava|sollu|solunga|sollunga|irukku|iruku|irukka|pannu|pannunga|venum|venuma|vendum|nethu|netru|inniku|inniki|innaiku|indru|paakanum|paakanuma|paaru|paarunga|aachu|achu|aagirukku|ippo|enna|eppadi|epdi|kudu|kudunga|podu|theriyuma|mudiyuma|mudiyum|evvlo|ethana|ethanai|yenna|aama|illa|irundhuchu|vandhuchu|mattum|adhula|athula|anuppala|anuppitanga|naalaiku|aagumaa|aaguma|vaaram|maasam)\b/i;

function detectLang(text: string): Lang {
  return /[\u0B80-\u0BFF]/.test(text) || TANGLISH.test(text) || /\b(ah|aa|ahh)\s*\?/i.test(text) ? "ta" : "en";
}

interface Period {
  from: string;
  to: string;
  /** Sentence opener, e.g. "Yesterday (27-Sep-2026)". */
  label: string;
  /** Re-askable text for follow-up questions. */
  query: string;
  kind: "day" | "range" | "keyword";
}

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function withYear(month: number, day: number, year: number | undefined, today: string): string | null {
  const current = Number(today.slice(0, 4));
  const value = iso(year ?? current, month, day);
  if (!value) return null;
  return !year && value > today ? iso(current - 1, month, day) : value;
}

function dayPeriod(date: string, today: string): Period {
  const yesterday = shiftDate(today, -1);
  if (date === today) return { from: date, to: date, label: `Today (${displayDate(date)})`, query: "today", kind: "keyword" };
  if (date === yesterday) return { from: date, to: date, label: `Yesterday (${displayDate(date)})`, query: "yesterday", kind: "keyword" };
  return { from: date, to: date, label: `On ${displayDate(date)}`, query: `on ${displayDate(date)}`, kind: "day" };
}

function rangePeriod(from: string, to: string, label?: string, query?: string): Period {
  const text = `${displayDate(from)} to ${displayDate(to)}`;
  return { from, to, label: label ? `${label} (${text})` : `From ${text}`, query: query ?? `from ${text}`, kind: label ? "keyword" : "range" };
}

function monthPeriod(month: number, year: number, today: string): Period {
  const from = iso(year, month, 1)!;
  const nextMonth = month === 12 ? iso(year + 1, 1, 1)! : iso(year, month + 1, 1)!;
  const end = shiftDate(nextMonth, -1);
  const to = end > today ? today : end;
  const name = new Date(`${from}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return rangePeriod(from, to, name);
}

const COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const COUNT_RE = `(\\d{1,2}|${COUNT_WORDS.slice(1).join("|")})`;

function countValue(value: string): number {
  const count = /^\d+$/.test(value) ? Number(value) : COUNT_WORDS.indexOf(value.toLowerCase());
  return count > 0 ? count : 0;
}

interface Found {
  index: number;
  period: Period;
}

function findPeriods(input: string, today: string): { found: Found[]; masked: string; unclear: boolean } {
  let text = input.toLowerCase();
  const found: Found[] = [];
  const unclear = /\b(last|past|previous) (few|couple of|some) (days|weeks)\b|\brecent(ly)? days\b|\bkonja naal\b/.test(text);
  const monday = (() => {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    return shiftDate(today, -((weekday + 6) % 7));
  })();

  const take = (regex: RegExp, build: (match: RegExpExecArray) => Period | null) => {
    const global = new RegExp(regex.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = global.exec(text))) {
      const period = build(match);
      if (!period) continue;
      found.push({ index: match.index, period });
      text = text.slice(0, match.index) + " ".repeat(match[0].length) + text.slice(match.index + match[0].length);
      global.lastIndex = match.index + match[0].length;
    }
  };

  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => {
    const value = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return value ? dayPeriod(value, today) : null;
  });
  take(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/, (m) => {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const value = iso(year, Number(m[2]), Number(m[1]));
    return value ? dayPeriod(value, today) : null;
  });
  take(/\b(\d{1,2})\/(\d{1,2})\b/, (m) => {
    const value = withYear(Number(m[2]), Number(m[1]), undefined, today);
    return value ? dayPeriod(value, today) : null;
  });
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*(?:of\\s+)?${MONTH_RE}[a-z]*(?:[\\s,-]+(\\d{4}))?\\b`), (m) => {
    const value = withYear(MONTH_KEYS.indexOf(m[2].slice(0, 3)) + 1, Number(m[1]), m[3] ? Number(m[3]) : undefined, today);
    return value ? dayPeriod(value, today) : null;
  });
  take(new RegExp(`\\b${MONTH_RE}[a-z]*[\\s-]+(\\d{1,2})(?:st|nd|rd|th)?(?:[\\s,]+(\\d{4}))?\\b`), (m) => {
    const value = withYear(MONTH_KEYS.indexOf(m[1].slice(0, 3)) + 1, Number(m[2]), m[3] ? Number(m[3]) : undefined, today);
    return value ? dayPeriod(value, today) : null;
  });
  take(/\bday before yesterday\b/, () => dayPeriod(shiftDate(today, -2), today));
  take(/\b(today|todays|today's|inniku|inniki|innaiku|indru)\b/, () => dayPeriod(today, today));
  take(/\b(yesterday|yesterdays|yesterday's|nethu|netru|neththu)\b/, () => dayPeriod(shiftDate(today, -1), today));
  take(/\b(this|current|indha) (week|vaaram)\b/, () => rangePeriod(monday, today, "This week", "this week"));
  take(/\b(last|previous|pona|kadandha) (week|vaaram)\b/, () => rangePeriod(shiftDate(monday, -7), shiftDate(monday, -1), "Last week", "last week"));
  take(/\b(this|current|indha) (month|maasam)\b/, () => rangePeriod(`${today.slice(0, 7)}-01`, today, "This month", "this month"));
  take(/\b(last|previous|pona|kadandha) (month|maasam)\b/, () => {
    const first = `${today.slice(0, 7)}-01`;
    const previous = shiftDate(first, -1);
    return rangePeriod(`${previous.slice(0, 7)}-01`, previous, "Last month", "last month");
  });
  take(/\b(last|past) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/, (m) => {
    const target = WEEKDAYS.indexOf(m[2]);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const back = ((weekday - target + 7) % 7) || 7;
    return dayPeriod(shiftDate(today, -back), today);
  });
  take(/\b(this|current) year\b/, () => rangePeriod(`${today.slice(0, 4)}-01-01`, today, "This year", "this year"));
  take(new RegExp(`\\b(?:(?:last|past|previous|pona|kadandha)\\s*)?${COUNT_RE}\\s*(months?|mnths?|mths?|maasam)\\b`), (m) => {
    const months = countValue(m[1]);
    if (!months) return null;
    const [year, month] = today.split("-").map(Number);
    const from = new Date(Date.UTC(year, month - months, 1)).toISOString().slice(0, 10);
    const label = months === 1 ? "This month" : `Last ${months} months`;
    return rangePeriod(from, today, label, months === 1 ? "this month" : `last ${months} months`);
  });
  take(new RegExp(`\\b(?:last|past|previous|pona|kadandha)\\s*${COUNT_RE}\\s*(weeks?|wks?|vaaram)\\b`), (m) => {
    const weeks = countValue(m[1]);
    if (!weeks) return null;
    return rangePeriod(shiftDate(today, -(weeks * 7 - 1)), today, `Last ${weeks} weeks`, `last ${weeks} weeks`);
  });
  take(/\b(this|current|last|previous) quarter\b/, (m) => {
    const [year, month] = today.split("-").map(Number);
    const startMonth = Math.floor((month - 1) / 3) * 3 - (/this|current/.test(m[1]) ? 0 : 3);
    const from = new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10);
    const end = shiftDate(new Date(Date.UTC(year, startMonth + 3, 1)).toISOString().slice(0, 10), -1);
    const current = /this|current/.test(m[1]);
    return rangePeriod(from, end > today ? today : end, current ? "This quarter" : "Last quarter", current ? "this quarter" : "last quarter");
  });
  take(new RegExp(`\\b(?:last|past|previous)\\s*${COUNT_RE}\\s*(years?|yrs?)\\b`), (m) => {
    const years = countValue(m[1]);
    if (!years) return null;
    return rangePeriod(shiftDate(today, -(years * 365 - 1)), today, `Last ${years} years`, `last ${years} years`);
  });
  take(/\b(?:last|past|previous) year\b/, () => {
    const year = Number(today.slice(0, 4)) - 1;
    return rangePeriod(`${year}-01-01`, `${year}-12-31`, String(year));
  });
  take(/\b(last|past) (\d{1,3})\s*days?\b/, (m) => {
    const days = Math.max(1, Math.min(Number(m[2]), 366));
    return rangePeriod(shiftDate(today, -(days - 1)), today, `Last ${days} days`, `last ${days} days`);
  });
  take(new RegExp(`\\b${MONTH_RE}[a-z]*(?:[\\s,-]+(\\d{4}))?\\b`), (m) => {
    const key = m[1].slice(0, 3);
    const hasYear = Boolean(m[2]);
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (key === "may" && !hasYear && !/\b(in|for|of)\s*$/.test(before)) return null;
    if (m[1].length === 3 && !hasYear && !/\b(in|for|of)\s*$/.test(before)) return null;
    const month = MONTH_KEYS.indexOf(key) + 1;
    const currentYear = Number(today.slice(0, 4));
    let year = hasYear ? Number(m[2]) : currentYear;
    if (!hasYear && iso(year, month, 1)! > today) year -= 1;
    return monthPeriod(month, year, today);
  });
  take(/\b(?:in|for|year)\s+(20\d{2})\b/, (m) => {
    const year = Number(m[1]);
    const to = `${year}-12-31` > today ? today : `${year}-12-31`;
    return rangePeriod(`${year}-01-01`, to, String(year));
  });

  found.sort((a, b) => a.index - b.index);
  return { found, masked: text, unclear };
}

function isFullMonth(period: { from: string; to: string }): boolean {
  return period.from.endsWith("-01") && period.from.slice(0, 7) === period.to.slice(0, 7) && shiftDate(period.to, 1).endsWith("-01");
}

function previousPeriod(period: Period, today: string): Period {
  if (period.query === "today") return dayPeriod(shiftDate(today, -1), today);
  if (period.query === "yesterday") return dayPeriod(shiftDate(today, -2), today);
  if (period.query === "this week") {
    const days = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000);
    const from = shiftDate(period.from, -7);
    return rangePeriod(from, shiftDate(from, days), "Same days last week", `from ${displayDate(from)} to ${displayDate(shiftDate(from, days))}`);
  }
  if (period.query === "this month") {
    const first = period.from;
    const prevFirst = `${shiftDate(first, -1).slice(0, 7)}-01`;
    const day = Number(period.to.slice(8, 10));
    const prevEnd = shiftDate(first, -1);
    const to = Number(prevEnd.slice(8, 10)) < day ? prevEnd : `${prevFirst.slice(0, 8)}${String(day).padStart(2, "0")}`;
    return rangePeriod(prevFirst, to, "Same days last month", `from ${displayDate(prevFirst)} to ${displayDate(to)}`);
  }
  if (isFullMonth(period)) {
    const previous = shiftDate(period.from, -1);
    return monthPeriod(Number(previous.slice(5, 7)), Number(previous.slice(0, 4)), today);
  }
  const days = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000);
  const to = shiftDate(period.from, -1);
  const from = shiftDate(to, -days);
  return from === to ? dayPeriod(from, today) : rangePeriod(from, to);
}

function orderFrom(masked: string): string | null {
  const labelled = masked.match(/\b(?:sales\s*order|order|ordr|so)\s*(?:no\.?|number|#)?\s*[:#-]?\s*(\d{3,10})\b/i) ?? masked.match(/#\s*(\d{3,10})\b/);
  if (labelled) return labelled[1];
  return ordersFrom(masked)[0] ?? null;
}

function ordersFrom(masked: string): string[] {
  const bare = [...masked.matchAll(/(^|[^\w-])(\d{3,10})\b(?!-)/g)]
    .filter((match) => !/\b(top|first|last|bottom)\s*$/i.test(masked.slice(Math.max(0, (match.index ?? 0) - 8), (match.index ?? 0) + match[1].length)))
    .map((match) => match[2])
    .filter((value) => value.length >= 4 || /\b(orders?|so)\b|#/i.test(masked));
  return [...new Set(bare)];
}

const COMPARE_WORDS = /\b(compare|comparison|vs|versus|difference|diff|between|against)\b/;

function withView(result: SalesViewResult, next?: { line: string; suggestion: { label: string; question: string } }): SalesAssistantReply {
  return { message: result.message, ...(result.view ? { view: result.view } : {}), ...(next ? { suggestions: [next.suggestion] } : {}) };
}

function viewFollowUp(lang: Lang, mode: SalesViewMode | null, subject: string) {
  if (mode === "dashboard") return followUp(lang, "Want the full report table?", "Full report table venuma?", `${subject} report`);
  return followUp(lang, "Want the dashboard view?", "Dashboard view paakanuma?", `${subject} dashboard`);
}

export function needsStructuredView(message: string): boolean {
  const text = message.toLowerCase();
  if (wantsFocText(text) && viewModeFrom(text) === "count") return false;
  return Boolean(viewModeFrom(text)) || (COMPARE_WORDS.test(text) && ordersFrom(findPeriods(text, businessToday().date).masked).length >= 2);
}

const PLANT_RE = /\bP\d{3}\b/gi;
const CURRENCY_RE = /\b(EUR|INR|USD|euros?|rupees?|rs\.?|dollars?)\b/gi;
const GROUP_RE = /\bMC\d{6}\b/gi;
const ROUTE_RE = /\bZ\d{5}\b/gi;
const CATEGORY_RE = /\b(ZTAM|ZTAN|YTAN)\b/gi;
const EXPLICIT_MATERIAL_RE = /\b(?:material|style|article|sku|item code)\s+(?!group|wise|by|per|summary|details?)([A-Z0-9][A-Z0-9-]{4,})\b/gi;
/** Codes need a digit so "customer group wise" / "division wise" are not read as codes. */
const CUSTOMER_GROUP_RE = /\bcustomer[- ]?group\s*(?:no\.?|code)?\s*[:#-]?\s*([A-Z0-9]*\d[A-Z0-9]*)\b/gi;
const DIVISION_RE = /\bdivision\s*(?:no\.?|code)?\s*[:#-]?\s*([A-Z0-9]*\d[A-Z0-9]*)\b/gi;
const DISTRICT_RE = /\b(?:sales[- ]?)?district\s*(?:no\.?|code)?\s*[:#-]?\s*([A-Z0-9]*\d[A-Z0-9]*)\b/gi;
const RETURNS_RE = /\breturns?(?:[- ]?(?:items?|orders?|lines?|qty|quantity))?\b/i;

function stripCodeFilters(text: string): string {
  return text.replace(CUSTOMER_GROUP_RE, " ").replace(DIVISION_RE, " ").replace(DISTRICT_RE, " ");
}

function firstCode(regex: RegExp, text: string): string | undefined {
  return [...text.matchAll(regex)][0]?.[1]?.toUpperCase();
}

/** Style / material codes typed without a label: mixed letters + digits, 7+ chars, not a plant, group, route or order. */
function materialToken(masked: string): string | null {
  for (const match of masked.matchAll(/\b([a-z0-9][a-z0-9-]{6,}[a-z0-9])\b/gi)) {
    const token = match[1].toUpperCase();
    if (!/[A-Z]/.test(token) || !/\d/.test(token)) continue;
    if (/^(P\d{3}|MC\d{6}|Z\d{5})$/.test(token) || /^\d+$/.test(token.replace(/-/g, ""))) continue;
    return token;
  }
  return null;
}

function filtersFrom(text: string, masked = text.toLowerCase()): SalesFilters {
  const filters: SalesFilters = {};
  const plants = [...text.matchAll(PLANT_RE)].map((match) => match[0].toUpperCase());
  if (plants.length) filters.plant = [...new Set(plants)];
  const currency = text.match(/\b(EUR|INR|USD)\b/i)?.[1] ?? (/\beuros?\b/i.test(text) ? "EUR" : /\b(rupees?|rs\.?)\b/i.test(text) ? "INR" : /\bdollars?\b/i.test(text) ? "USD" : undefined);
  if (currency) filters.currency = currency.toUpperCase();
  const group = text.match(/\bMC\d{6}\b/i)?.[0];
  if (group) filters.material_group = group.toUpperCase();
  const route = text.match(/\bZ\d{5}\b/i)?.[0];
  if (route) filters.route = route.toUpperCase();
  const category = text.match(/\b(ZTAM|ZTAN|YTAN)\b/i)?.[1];
  if (category) filters.item_category = category.toUpperCase();
  const customerGroup = firstCode(CUSTOMER_GROUP_RE, text);
  if (customerGroup) filters.customer_group = customerGroup;
  const division = firstCode(DIVISION_RE, text);
  if (division) filters.division = division;
  const district = firstCode(DISTRICT_RE, text);
  if (district) filters.sales_district = district;
  if (RETURNS_RE.test(text)) filters.returns = true;
  const explicit = [...text.matchAll(EXPLICIT_MATERIAL_RE)][0]?.[1];
  const material = explicit ?? materialToken(stripCodeFilters(masked));
  if (material && !/^MC\d{6}$/i.test(material)) filters.material = material.toUpperCase();
  return filters;
}

function filterText(filters: SalesFilters): string {
  const parts: string[] = [];
  if (filters.plant) parts.push(`plant ${([] as string[]).concat(filters.plant).join(", ")}`);
  if (filters.currency) parts.push(filters.currency);
  if (filters.material_group) parts.push(`material group ${filters.material_group}`);
  if (filters.material) parts.push(`material ${filters.material}`);
  if (filters.route) parts.push(`route ${filters.route}`);
  if (filters.item_category) parts.push(filters.item_category);
  if (filters.division) parts.push(`division ${filters.division}`);
  if (filters.sales_district) parts.push(`sales district ${filters.sales_district}`);
  if (filters.customer_group) parts.push(`customer group ${filters.customer_group}`);
  if (filters.returns) parts.push("return items only");
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function filterQuery(filters: SalesFilters): string {
  const parts: string[] = [];
  if (filters.plant) parts.push(([] as string[]).concat(filters.plant).join(" "));
  if (filters.currency) parts.push(filters.currency);
  if (filters.material_group) parts.push(filters.material_group);
  if (filters.material) parts.push(`material ${filters.material}`);
  if (filters.route) parts.push(filters.route);
  if (filters.item_category) parts.push(filters.item_category);
  if (filters.division) parts.push(`division ${filters.division}`);
  if (filters.sales_district) parts.push(`sales district ${filters.sales_district}`);
  if (filters.customer_group) parts.push(`customer group ${filters.customer_group}`);
  if (filters.returns) parts.push("returns");
  return parts.length ? ` ${parts.join(" ")}` : "";
}

const GROUP_LABEL: Record<GroupBy, string> = {
  plant: "Plant",
  material: "Material",
  material_group: "Material Group",
  item_category: "Item Category",
  route: "Route",
  shipping_point: "Shipping Point",
  division: "Division",
  sales_district: "Sales District",
  customer_group: "Customer Group",
  date: "Date",
  month: "Month",
  hour: "Hour",
  none: "",
  currency: "",
};

function groupByFrom(text: string): GroupBy | null {
  if (/\bmaterial[- ]?group/.test(text)) return "material_group";
  if (/\bcustomer[- ]?group/.test(text)) return "customer_group";
  if (/\bsales[- ]?district|\bdistrict[- ]?wise\b|\b(by|per) district\b/.test(text)) return "sales_district";
  if (/\bdivision[- ]?wise|\b(by|per|each) division\b|\bdivisions\b/.test(text)) return "division";
  if (/\bplant[- ]?(wise|split)|\b(by|per|each) plant\b/.test(text)) return "plant";
  if (/\bitem[- ]?category|\bcategory[- ]?wise\b/.test(text)) return "item_category";
  if (/\broute[- ]?wise|\b(by|per) route\b/.test(text)) return "route";
  if (/\bshipping[- ]?point/.test(text)) return "shipping_point";
  if (/\bhour(ly)?[- ]?wise|\bhourly\b|\b(by|per) hour\b/.test(text)) return "hour";
  if (/\bmonth[- ]?wise|\bmonthly\b|\b(by|per|each) month\b|\bmaasam[- ]?vaariya/.test(text)) return "month";
  if (/\b(date|day)[- ]?wise|\bdaily\b|\b(by|per|each) (date|day)\b|\btrend\b/.test(text)) return "date";
  if (/\bmaterial[- ]?wise|\b(by|per) material\b|\bstyle[- ]?wise\b/.test(text)) return "material";
  if (/\bcurrency[- ]?wise|\b(by|per) currency\b/.test(text)) return "currency";
  return null;
}

function statusFrom(text: string): StatusType | null {
  if (/\bdelivery[- ]?block/.test(text)) return "delivery_blocked";
  if (/\bbilling[- ]?block/.test(text)) return "billing_blocked";
  if (/\bblock(ed|s)?\b|\b(hold|on hold|stuck)\b/.test(text)) return "blocked";
  if (/\bpricing[- ]?(incomplete|incompletion|error)|\bprice incomplete\b/.test(text)) return "pricing_incomplete";
  if (/\bincomplet(e|ion)\b/.test(text)) return "incomplete";
  if (/\b(zero|0)[- ]?(value|amount|price)\b|\bwithout (price|value)\b|\bno value\b/.test(text)) return "zero_value";
  if (/\bbilling[- ]?pending|\bpending[- ]?billing|\bnot (yet )?billed\b|\bto be billed\b|\bbill (aagala|pannala)\b/.test(text)) return "billing_pending";
  if (/\bpartial(ly)?[- ]?deliver|\bpartly deliver/.test(text)) return "delivery_partial";
  if (/\b(pending|open|undelivered)[- ]?(deliver|delivery|dispatch|items?|orders?)\b|\bdelivery[- ]?pending\b|\bnot (yet )?delivered\b|\byet to (be )?deliver|\banuppala\b|\binnum vara(la)?\b|^pending\b|\bpending$/.test(text)) return "delivery_pending";
  if (/\b(delivered|delivery (complete|completed|done)|anuppitanga|anupiyachu)\b/.test(text)) return "delivery_complete";
  return null;
}

function wantsFocText(text: string): boolean {
  return /\b(foc|free of charge|free items?|free|samples?|no charge)\b/.test(text);
}

function wantsCostText(text: string): boolean {
  return /\b(cost|margin|profit|labam|laabam)\b/.test(text);
}

function isYesNo(text: string): boolean {
  return /\b(ah|aa|ahh|a|aa)\s*\?*\s*$/.test(text) || /^(is|are|was|were|did|does|do|has|have|can)\b/.test(text) || (/\?\s*$/.test(text) && /\b(delivered|blocked|billed|complete|incomplete)\b/.test(text));
}

// ---------------------------------------------------------------------------
// Rule answers

const SAP_DOWN = {
  en: "I couldn't fetch the data right now. Please try again in a little while.",
  ta: "Data eduka mudiyala right now. Konjam neram kazhichu try pannunga.",
};

function notAvailable(lang: Lang): string {
  return say(lang, "This detail is not available in the Sales data yet.", "Indha detail Sales data la ippo illa.");
}

function costDenied(lang: Lang): string {
  return say(lang, "Cost/margin details are not available for your role.", "Cost/margin details ungalukku available illa.");
}

function outOfScope(text: string, lang: Lang): SalesAssistantReply | null {
  if (/\b(ignore|forget|override|bypass)\b.*\b(rules?|instructions?|prompt)\b|\b(system|your) prompt\b|\braw (data|json)\b|\bdump\b|\b(api|endpoint|url|credentials?|password|hostname)\b|\ball (the )?data\b/.test(text)) {
    return { message: say(lang, "I can't do that. Ask me anything about sales data and I'll share a summary or order-wise view.", "Adhu ennala panna mudiyadhu. Sales data pathi enna vena kelunga, summary or order-wise solren.") };
  }
  if (/\b(i am|i'm|as an?|my role is)\s+(an? )?(admin|manager|finance)\b/.test(text)) {
    return { message: say(lang, "I can only use the role set by the portal login. Ask your admin if you need more access.", "Portal login la set aana role mattum dhaan use panna mudiyum. Access venumna admin kitta kelunga.") };
  }
  if (/\b(what|which) (did )?(other users?|others|someone else) ask/.test(text)) {
    return { message: say(lang, "I can't share other users' questions.", "Matha users kettadha share panna mudiyadhu.") };
  }
  if (/\b(customer|client|buyer) (name|details?|address)\b|\bwho is the (customer|client|buyer)\b/.test(text)) {
    return finish(
      [say(lang, "Customer name is not available in the current Sales API response. I can provide Customer Group-wise analysis.", "Customer name Sales API la illa. Customer Group-wise analysis kaatalaam.")],
      followUp(lang, "Want customer group-wise sales for this month?", "Indha maasam customer group-wise sales paakanuma?", "Customer group-wise sales this month"),
    );
  }
  if (/\bmaterial description\b|\b(invoice|delivery) (no|number)\b|\bsales ?(org|organi[sz]ation)\b|\border type\b|\bcreated by\b|\bwho created\b/.test(text)) {
    return { message: notAvailable(lang) };
  }
  if (/\bcustomers?\b(?![- ]?groups?)|\bclients?\b|\bbuyers?\b/.test(text)) {
    return finish(
      [say(lang, "Customer name is not available in the current Sales API response. I can provide Customer Group-wise analysis.", "Customer name Sales API la illa. Customer Group-wise analysis kaatalaam.")],
      followUp(lang, "Want customer group-wise sales for this month?", "Indha maasam customer group-wise sales paakanuma?", "Customer group-wise sales this month"),
    );
  }
  if (/\boutstanding\b|\bpayments?\b|\breceivables?\b|\bdues?\b|\bcollections?\b/.test(text)) {
    return { message: say(lang, "Payment and outstanding details are not available in the current Sales API response.", "Payment / outstanding details Sales API la illa.") };
  }
  if (/\b(stock|inventory|warehouse)\b/.test(text)) {
    return { message: say(lang, "Stock information is not in the Sales module. For now I can help only with Sales data.", "Stock information Sales module la illa. Ippodhaiku Sales data pathi mattum help panna mudiyum.") };
  }
  if (/\b(forecast|predict(ion)?|projection|will .* (increase|decrease|grow|drop)|next (week|month|year)|naalaiku|tomorrow|aagumaa|aaguma)\b/.test(text)) {
    return finish(
      [say(lang, "I can't forecast sales.", "Forecast panna ennala mudiyadhu.")],
      followUp(lang, "Want me to compare the last 7 days instead?", "Last 7 days trend compare pannitu kaatalaama?", "Compare last 7 days vs previous 7 days"),
    );
  }
  if (/\b(is|are|was) (our |the )?sales (good|bad|ok|okay|healthy|poor)\b|\bhow (good|bad) (is|are|was)\b|\bperformance (good|bad)\b/.test(text)) {
    return finish(
      [say(lang, "I don't give opinions on performance — I can show the numbers.", "Performance pathi opinion solla mudiyadhu — numbers kaatalaam.")],
      followUp(lang, "Want this month vs last month?", "Indha maasam vs pona maasam compare pannalaama?", "Compare this month vs last month"),
    );
  }
  const topic = /\b(production|manufacturing)\b/.test(text)
    ? "Production"
    : /\b(purchase|purchasing|vendors?|suppliers?)\b/.test(text)
      ? "Purchase"
      : /\b(salary|salaries|employees?|attendance|payroll|hr)\b/.test(text)
        ? "HR"
        : /\b(ledger|journal|gl|general ledger|accounting|balance sheet|finance|posting)\b/.test(text)
          ? "Finance"
          : /\bsales ?(person|persons|people|man|men|rep|reps|executive|executives)\b/.test(text)
            ? "Salesperson performance"
            : null;
  if (topic) {
    return { message: say(lang, `${topic} data is not supported yet. I can help with Sales order and item data.`, `Idhu Sales data la ippo illa (${topic} not supported yet). Sales order and item data pathi help panna mudiyum.`) };
  }
  if (/\b(should (i|we)|advice|advise|legal|tax rate|gst rate)\b/.test(text)) {
    return { message: say(lang, "I can't give legal, tax or accounting advice — I only report values present in the Sales data.", "Legal, tax or accounting advice ennala kudukka mudiyadhu. Sales data la irukka values mattum solluven.") };
  }
  return null;
}

function isWrite(text: string): boolean {
  return /\b(delete|remove|cancel|create|change|modify|update|edit|approve|release|unblock|block panna|post)\b/.test(text) && /\b(order|item|sales|data|so|record|pannu|pannunga)\b/.test(text);
}

async function orderAnswer(order: string, text: string, lang: Lang): Promise<SalesAssistantReply> {
  const data = await getOrderDetails({ sales_order: order });
  if (!data.found) {
    return { message: say(lang, `No records found for order ${code(order)}. Try another order number?`, `No records found for order ${code(order)}. Vera order number try pannalaama?`) };
  }
  const id = data.sales_order;
  const notes = [...data.data_notes, ...data.warnings];
  if (data.currencies.length > 1) notes.push(`This order shows ${data.currencies.length} currencies (${data.currencies.join(", ")}).`);
  if (data.counts.tag_rows) notes.push(`${plural(data.counts.tag_rows, "parent (TAG) row")} excluded from totals.`);
  const items = data.items.filter((item) => !item.type.startsWith("Header"));
  const regular = items.filter((item) => item.type.startsWith("Sales"));
  const asOf = asOfLine(data.data_as_of);
  const yesNo = isYesNo(text);
  const no = say(lang, "No", "Illa");
  const valueText = data.order_value.map((row) => `${amt(row.net_amount)} ${row.currency}`).join(" + ");

  if (/\b(customer|client|buyer|description|sales ?person|salesman|order type|sales org|organi[sz]ation|delivery (no|number|document)|invoice (no|number)|created by)\b/.test(text)) {
    return { message: notAvailable(lang) };
  }

  if (/\b(why|reason|yen|yean)\b|(?:^|\s)ஏன்/.test(text)) {
    const blockCounts = Object.entries(data.blocks).filter(([word]) => word !== "No block");
    const allBoth = blockCounts.length === 1 && blockCounts[0][0] === "Delivery + Billing" && blockCounts[0][1] === items.length;
    const blockText = !blockCounts.length
      ? "with no delivery or billing block"
      : allBoth
        ? "and delivery and billing are both blocked"
        : `and ${blockCounts.map(([word, count]) => `${count} item(s) have a ${word.toLowerCase()} block`).join(", ")}`;
    const quantity = regular.reduce((sum, item) => sum + item.quantity, 0);
    return finish([
      `Data shows order ${code(id)} (data available for ${plural(regular.length, "item")}, ${qty(quantity)} units) has net amount ${valueText || "0.00"}, ${blockText}.`,
      notesLine(notes),
      say(lang, "The reason is not in the Sales data — please check in SAP.", "Reason Sales data la illa, SAP la check pannanum."),
      asOf,
    ]);
  }

  if (/\bblock|\b(hold|stuck)\b/.test(text)) {
    const blocked = items.filter((item) => item.block !== "No block");
    if (!blocked.length) {
      return finish(
        [`${yesNo ? `${no}, o` : "O"}rder ${code(id)} has no delivery or billing block.`, asOf],
        followUp(lang, "Want the delivery status?", "Delivery status paakanuma?", `Order ${id} delivered?`),
      );
    }
    const counts = Object.entries(data.blocks).filter(([word]) => word !== "No block");
    return finish(
      [
        `${yesNo ? "Yes, o" : "O"}rder ${code(id)}: ${plural(blocked.length, "item")} of ${items.length} are blocked.`,
        table(["Block", "Items"], counts.map(([word, count]) => [word, String(count)])),
        asOf,
      ],
      followUp(lang, "Want the blocked item list?", "Blocked items list venuma?", `Blocked items of order ${id}`),
    );
  }

  if (/\bincomplet/.test(text)) {
    const incomplete = items.filter((item) => item.incomplete.length > 0);
    if (!incomplete.length) return finish([`${yesNo ? `${no}, o` : "O"}rder ${code(id)} is complete — no incompletion on any item.`, asOf]);
    return finish([
      `${yesNo ? "Yes, o" : "O"}rder ${code(id)}: ${plural(incomplete.length, "item")} incomplete.`,
      table(["Item", "Material", "Incomplete"], incomplete.slice(0, 10).map((item) => [code(item.item.padStart(6, "0")), code(item.material), item.incomplete.join(", ")])),
      incomplete.length > 10 ? `Showing top 10 of ${incomplete.length}.` : null,
      asOf,
    ]);
  }

  const wantsList = /\b(items?|list|lines?|materials?)\b/.test(text) && !/\b(how many|count|evlo|ethana)\b/.test(text);
  const openOnly = /\b(open|pending|not delivered|undelivered|anuppala)\b/.test(text);
  const blockedOnly = /\bblocked items\b/.test(text);
  if (wantsList || openOnly) {
    const list = items.filter((item) => (openOnly ? item.delivery === "Open" || item.delivery === "Partially delivered" : blockedOnly ? item.block !== "No block" : true));
    if (!list.length) return { message: say(lang, `Order ${code(id)} has no open items.`, `Order ${code(id)} la open items illa.`) };
    const title = openOnly ? `Order ${code(id)} has ${plural(list.length, "open item")}.` : `Order ${code(id)} has ${plural(list.length, "item")} (TAG header rows excluded).`;
    return finish(
      [
        title,
        table(
          ["Item", "Material", "Qty", "Net Amount", "Delivery"],
          list.slice(0, 10).map((item) => [
            item.item,
            code(item.material),
            qty(item.quantity),
            item.type.startsWith("Free") ? `FOC (${item.currency})` : `${amt(item.net_amount)} ${item.currency}`,
            item.delivery,
          ]),
        ),
        list.length > 10 ? say(lang, `Showing top 10 of ${list.length}. I can filter by material or plant.`, `Showing top 10 of ${list.length}. Material or plant vachu filter pannalama?`) : null,
        notesLine(notes),
        asOf,
      ],
      followUp(lang, "Want the order value?", "Order value paakanuma?", `Order ${id} value`),
    );
  }

  if (/\b(deliver|delivery|delivered|dispatch|shipped|ship|anuppitanga|anupiyachu)\b/.test(text)) {
    const group = (word: string) => items.filter((item) => item.delivery === word);
    const delivered = group("Delivered");
    const partial = group("Partially delivered");
    const open = group("Open");
    const blocks = items.some((item) => item.block !== "No block")
      ? `Blocks: ${Object.entries(data.blocks).filter(([word]) => word !== "No block").map(([word, count]) => `${word} (${count})`).join(", ")}.`
      : say(lang, "No delivery or billing block.", "No delivery/billing block.");
    const state = delivered.length === items.length ? "fully delivered" : delivered.length + partial.length === 0 ? "not delivered yet" : "partially delivered";
    const prefix = yesNo ? (state === "fully delivered" ? "Yes, o" : `${no}, o`) : "O";
    const detail =
      state === "partially delivered"
        ? `. ${delivered.length} of ${items.length} items delivered, ${open.length + partial.length} still open`
        : ` (${plural(items.length, "item")})`;
    const sumQty = (list: typeof items) => qty(list.reduce((sum, item) => sum + item.quantity, 0));
    return finish(
      [
        `${prefix}rder ${code(id)} ${lang === "ta" ? "" : "is "}${state}${detail}. ${blocks}`,
        table(
          ["Status", "Items", "Quantity"],
          [
            ["Delivered", delivered],
            ["Partially delivered", partial],
            ["Open", open],
          ]
            .filter(([, list]) => (list as typeof items).length > 0)
            .map(([word, list]) => [String(word), String((list as typeof items).length), sumQty(list as typeof items)]),
        ),
        valueText ? `Net value ${valueText}.` : null,
        notesLine(notes),
        asOf,
      ],
      open.length + partial.length > 0 ? followUp(lang, "Want the open items list?", "Open items list venuma?", `Open items of order ${id}`) : followUp(lang, "Want the order value?", "Order value paakanuma?", `Order ${id} value`),
    );
  }

  if (/\b(bill|billing|billed|invoice)\b/.test(text)) {
    const counts = Object.entries(data.billing_status);
    return finish(
      [`Order ${code(id)} billing status across ${plural(items.length, "item")}:`, table(["Billing status", "Items"], counts.map(([word, count]) => [word, String(count)])), notesLine(notes), asOf],
      followUp(lang, "Want the delivery status?", "Delivery status paakanuma?", `Order ${id} delivered?`),
    );
  }

  const wantsCost = wantsCostText(text) && canSeeCost();
  const created = data.created_on ? `created ${data.created_on}` : null;
  const plants = data.plants.length ? `plant ${data.plants.join(", ")}` : null;
  const values = data.order_value;
  const quantity = values.reduce((sum, row) => sum + row.quantity, 0);
  const taxText = values.map((row) => `${amt(row.tax_amount)} ${row.currency}`).join(" + ");
  const headers = wantsCost ? ["Currency", "Qty", "Net Amount", "Tax", "Cost", "Margin"] : ["Currency", "Qty", "Net Amount", "Tax"];
  const rows = values.map((row) =>
    wantsCost
      ? [row.currency, qty(row.quantity), amt(row.net_amount), amt(row.tax_amount), amt(row.cost_amount), amt(row.margin)]
      : [row.currency, qty(row.quantity), amt(row.net_amount), amt(row.tax_amount)],
  );
  if (data.foc_totals.length) {
    notes.unshift(
      `${plural(data.counts.foc_items, "FOC item")} (${data.foc_totals.map((row) => `${qty(row.quantity)} units, FOC value ${amt(row.foc_value)}, FOC tax ${amt(row.foc_tax)}${canSeeCost() ? `, cost ${amt(row.cost_amount)}` : ""} ${row.currency}`).join("; ")}) kept out of the order value.`,
    );
  }
  const incomplete = items.filter((item) => item.incomplete.length > 0);
  const incompleteText = incomplete.length === 1 ? ` Item ${code(incomplete[0].item.padStart(6, "0"))} is incomplete.` : incomplete.length > 1 ? ` ${plural(incomplete.length, "item")} are incomplete.` : "";
  const meta = [created, plants].filter(Boolean).join(", ");
  return finish(
    [
      regular.length
        ? `Order ${code(id)}${meta ? ` (${meta})` : ""} has ${plural(regular.length, "item")}, ${qty(quantity)} units, net ${valueText || "0.00"}, tax ${taxText || "0.00"}.${incompleteText}`
        : `Order ${code(id)}${meta ? ` (${meta})` : ""} has no regular sales items.`,
      rows.length > 1 || wantsCost ? table(headers, rows) : null,
      notesLine(notes),
      asOf,
    ],
    incomplete.length
      ? followUp(lang, "Want the incomplete item details?", "Incomplete item detail paakanuma?", `Incomplete items of order ${id}`)
      : followUp(lang, "Want the item list?", "Item list venuma?", `Items of order ${id}`),
  );
}

async function summaryAnswer(period: Period, defaulted: boolean, text: string, filters: SalesFilters, lang: Lang, groupBy: GroupBy | null): Promise<SalesAssistantReply> {
  const wantsCost = wantsCostText(text) && canSeeCost();
  const wantsFoc = wantsFocText(text);
  const wantsTag = /\b(tag|header|parent) (rows?|items?)\b/.test(text);
  const wantsLatest = /\b(latest|last|recent|newest|kadaisi) (sales )?order\b/.test(text);
  const multiMonth = period.from.slice(0, 7) !== period.to.slice(0, 7);
  const grouped = groupBy && groupBy !== "currency" ? groupBy : multiMonth && !groupBy ? "month" : null;
  const data = await getSalesSummary({ date_from: period.from, date_to: period.to, group_by: grouped ?? "currency", filters });
  const lead = defaulted ? `Showing data for ${displayDate(period.from)}. ` : "";
  const scope = filterText(filters);
  const basis = basisLine(period, data.data_as_of);

  if (data.item_count === 0 && data.foc.items === 0) {
    const when = defaulted ? displayDate(period.from) : period.label.replace(/^On /, "");
    return { message: say(lang, `No records found for ${when}${scope}. Try another date or order number?`, `No records found for ${when}${scope}. Vera date or order number try pannalaama?`) };
  }

  if (wantsLatest && data.latest_order) {
    const latest = data.latest_order;
    return finish(
      [`${lead}Latest order ${period.label.replace(/^On /, "on ").replace(/^(Today|Yesterday|This|Last)/, (m) => m.toLowerCase())}${scope} is ${code(latest.sales_order)}, created ${latest.created_on} at ${latest.time}.`, basis],
      followUp(lang, `Want the details of order ${latest.sales_order}?`, `Order ${latest.sales_order} details paakanuma?`, `Order ${latest.sales_order} details`),
    );
  }

  if (wantsFoc) {
    if (!data.foc.items) return finish([`${lead}No FOC items ${period.label.replace(/^On /, "on ").replace(/^(Today|Yesterday)/, (m) => m.toLowerCase())}${scope}.`, basis]);
    const headers = ["Currency", "Qty", "FOC value", "FOC tax", ...(canSeeCost() ? ["Cost"] : [])];
    return finish(
      [
        `${lead}FOC items by currency — ${period.label.replace(/^On /, "")}${scope}: ${plural(data.foc.items, "item")} in ${plural(data.foc.orders, "order")}, ${qty(data.foc.quantity)} units.`,
        table(
          headers,
          data.foc.by_currency.map((row) => [row.currency, qty(row.quantity), amt(row.foc_value), amt(row.foc_tax), ...(canSeeCost() ? [amt(row.cost_amount)] : [])]),
        ),
        say(lang, "Not included in sales value.", "Sales value la add pannala."),
        notesLine(data.warnings),
        basis,
      ],
      followUp(lang, "Want the regular sales summary?", "Regular sales summary paakanuma?", `Sales ${period.query}${filterQuery(filters)}`),
    );
  }

  const notes = [...data.data_notes, ...data.warnings].filter((note) => !(filters.returns && /return item\(s\) are included/.test(note)));
  if (data.foc.items) notes.unshift(`${plural(data.foc.items, "FOC item")} excluded from sales value.`);
  if (wantsTag || data.tag_rows_excluded) notes.push(`${plural(data.tag_rows_excluded, "parent (TAG) row")} excluded from totals.`);
  const focOnly = data.foc_only_order_count ? ` (+${plural(data.foc_only_order_count, "FOC-only order")})` : "";
  const valueText = data.by_currency.filter((row) => row.item_count > 0).map((row) => `${amt(row.net_amount)} ${row.currency}`).join(", ");
  const headline =
    data.item_count === 0
      ? `${lead}${period.label}${scope}: no regular sales items, only ${plural(data.foc.items, "FOC item")} in ${plural(data.foc_only_order_count, "FOC-only order")}.`
      : data.by_currency.length === 1 && !grouped
      ? `${lead}${period.label}${scope}: ${plural(data.order_count, "order")}${focOnly}, ${plural(data.item_count, "item")}, ${qty(data.total_quantity)} units, net ${valueText}, tax ${amt(data.by_currency[0].tax_amount)} ${data.by_currency[0].currency}.`
      : `${lead}${period.label}${scope}: ${plural(data.order_count, "order")}${focOnly}, ${plural(data.item_count, "sales item")}, ${qty(data.total_quantity)} units.`;

  if (grouped && data.groups) {
    const label = GROUP_LABEL[grouped];
    const limit = grouped === "month" ? 50 : 10;
    const shown = data.groups.slice(0, limit);
    const rows = shown.map((group) => {
      const key = String(group[grouped]);
      const keyCell = grouped === "material" || grouped === "material_group" ? code(key) : key;
      const base = [keyCell, String(group.currency), String(group.orders), qty(Number(group.quantity)), amt(Number(group.net_amount))];
      return wantsCost ? [...base, amt(Number(group.cost_amount)), amt(Number(group.net_amount) - Number(group.cost_amount))] : base;
    });
    const headers = wantsCost ? [label, "Currency", "Orders", "Qty", "Net Sales", "Cost", "Margin"] : [label, "Currency", "Orders", "Qty", "Net Sales"];
    return finish(
      [
        headline,
        table(headers, rows),
        grouped === "month" && valueText ? `Total net: ${valueText}.` : null,
        (data.group_count ?? 0) > limit ? say(lang, `Showing top ${limit} of ${data.group_count}. I can filter by plant, material or date.`, `Showing top ${limit} of ${data.group_count}. Plant, material or date vachu filter pannalama?`) : null,
        notesLine(notes),
        basis,
      ],
      grouped === "plant"
        ? followUp(lang, "Want the top 10 materials?", "Top 10 materials paakanuma?", `Top 10 materials by quantity ${period.query}${filterQuery(filters)}`)
        : followUp(lang, "Want a plant-wise split?", "Plant-wise split paakanuma?", `Plant-wise sales ${period.query}${filterQuery(filters)}`),
    );
  }

  const withSales = data.by_currency.filter((row) => row.item_count > 0);
  const headers = wantsCost ? ["Currency", "Orders", "Net Sales", "Tax", "Cost", "Margin"] : ["Currency", "Orders", "Items", "Qty", "Net Sales", "Tax"];
  const rows = withSales.map((row) =>
    wantsCost
      ? [row.currency, qty(row.order_count), amt(row.net_amount), amt(row.tax_amount), amt(row.cost_amount), amt(row.margin)]
      : [row.currency, qty(row.order_count), qty(row.item_count), qty(row.total_quantity), amt(row.net_amount), amt(row.tax_amount)],
  );
  return finish(
    [headline, rows.length > 1 || wantsCost ? table(headers, rows) : null, notesLine(notes), basis],
    followUp(lang, "Want a plant-wise split?", "Plant-wise split paakanuma?", `Plant-wise sales ${period.query}${filterQuery(filters)}`),
  );
}

async function statusAnswer(status: StatusType, period: Period, defaulted: boolean, text: string, filters: SalesFilters, lang: Lang): Promise<SalesAssistantReply> {
  const data = await getItemStatus({ date_from: period.from, date_to: period.to, status_type: status, filters });
  const lead = defaulted ? `Showing data for ${displayDate(period.from)}. ` : "";
  const when = period.label.replace(/^On /, "on ").replace(/^(Today|Yesterday|This|Last|From)/, (m) => m.toLowerCase());
  const scope = filterText(filters);
  const assumed = status === "delivery_pending" && /\bpending\b/.test(text) && !/\b(deliver|delivery|dispatch|ship|anupp|vara)/.test(text);
  const assumption = assumed ? say(lang, "Assuming delivery pending.", "Delivery pending nu eduthukitten.") : null;
  const basis = basisLine(period, data.data_as_of);
  if (data.item_count === 0) {
    return finish([
      `${lead}${assumption ? `${assumption} ` : ""}${say(lang, `No records found for ${data.status_label.toLowerCase()} items ${when}${scope}. Try another date or order number?`, `No records found for ${data.status_label.toLowerCase()} items ${when}${scope}. Vera date or order number try pannalaama?`)}`,
    ]);
  }
  const blocked = status === "blocked" || status === "delivery_blocked" || status === "billing_blocked";
  const verb: Record<StatusType, string> = {
    delivery_pending: "are pending delivery",
    delivery_partial: "are partially delivered",
    delivery_complete: "are delivered",
    delivery_blocked: "have a delivery block",
    billing_blocked: "have a billing block",
    blocked: "are blocked",
    billing_pending: "are pending billing",
    incomplete: "are incomplete",
    pricing_incomplete: "have incomplete pricing",
    zero_value: "have net amount 0",
  };
  const blockKinds = [...new Set(data.orders.map((order) => order.block))];
  const blockSummary = blocked && blockKinds.length === 1 ? ` (${blockKinds[0].toLowerCase()})` : "";
  const wantsQty = /\b(qty|quantity|units)\b/.test(text);
  const headers = blocked
    ? ["Order", "Items", ...(wantsQty ? ["Qty"] : []), "Block", "Currency"]
    : status === "incomplete" || status === "pricing_incomplete"
      ? ["Order", "Items", "Incomplete", "Currency"]
      : ["Order", "Items", "Qty", "Net Amount"];
  const rows = data.orders.map((order) =>
    blocked
      ? [code(order.order), String(order.items), ...(wantsQty ? [qty(order.quantity)] : []), order.block, order.currency]
      : status === "incomplete" || status === "pricing_incomplete"
        ? [code(order.order), String(order.items), order.incomplete_fields.join(", ") || "—", order.currency]
        : [code(order.order), String(order.items), qty(order.quantity), `${amt(order.net_amount)} ${order.currency}`],
  );
  const next = assumed
    ? followUp(lang, "Want billing pending instead?", "Billing pending venuma?", `Billing pending ${period.query}${filterQuery(filters)}`)
    : blocked
      ? wantsQty
        ? followUp(lang, "Want the blocked items of the first order?", "First order oda blocked items paakanuma?", `Blocked items of order ${data.orders[0].order}`)
        : followUp(lang, "Want the quantity per order?", "Quantity per order kaatava?", `Blocked quantity per order ${period.query}${filterQuery(filters)}`)
      : followUp(lang, `Want the items of order ${data.orders[0].order}?`, `Order ${data.orders[0].order} items paakanuma?`, `Items of order ${data.orders[0].order}`);
  return finish(
    [
      `${lead}${assumption ? `${assumption} ` : ""}${plural(data.item_count, "item")} in ${plural(data.order_count, "order")} ${verb[status]}${blockSummary}${defaulted ? "" : ` ${when}`}${scope}.`,
      table(headers, rows),
      data.order_count > 10 ? say(lang, `Showing top 10 of ${data.order_count} orders. I can filter by plant or date.`, `Showing top 10 of ${data.order_count} orders. Plant or date vachu filter pannalama?`) : null,
      notesLine(data.warnings),
      basis,
    ],
    next,
  );
}

async function topAnswer(text: string, period: Period, defaulted: boolean, filters: SalesFilters, lang: Lang): Promise<SalesAssistantReply> {
  const dimension: Dimension = /\bmaterial[- ]?groups?\b/.test(text)
    ? "material_group"
    : /\bcustomer[- ]?groups?\b/.test(text)
      ? "customer_group"
      : /\b(sales[- ]?)?districts?\b/.test(text)
        ? "sales_district"
        : /\bdivisions?\b/.test(text)
          ? "division"
          : /\bplants?\b/.test(text)
            ? "plant"
            : /\broutes?\b/.test(text)
              ? "route"
              : /\borders?\b/.test(text) && !/\bby orders?\b|\bmost orders\b/.test(text)
                ? "order"
                : "material";
  const metric: Metric = /\b(qty|quantity|units|pieces|pcs|volume)\b/.test(text)
    ? "quantity"
    : /\bcost\b/.test(text)
      ? "cost_amount"
      : /\b(order count|number of orders|by orders?|most orders)\b/.test(text)
        ? "order_count"
        : "net_amount";
  const explicitN = text.match(/\btop\s*(\d{1,2})\b/)?.[1];
  const perCurrency = (metric === "net_amount" || metric === "cost_amount") && !filters.currency;
  const n = Math.min(10, explicitN ? Number(explicitN) : perCurrency ? 3 : 10);
  const data = await topN({ metric, dimension, date_from: period.from, date_to: period.to, n, filters: { ...filters, include_foc: /\bfoc\b/.test(text) } });
  const lead = defaulted ? `Showing data for ${displayDate(period.from)}. ` : "";
  const dimName = {
    material: "materials",
    material_group: "material groups",
    plant: "plants",
    route: "routes",
    division: "divisions",
    sales_district: "sales districts",
    customer_group: "customer groups",
    order: "orders",
  }[dimension];
  const metricName = { quantity: "quantity", net_amount: "net amount", cost_amount: "cost", order_count: "order count" }[metric];
  if (!data.rows.length) return { message: `${lead}${say(lang, `No records found for ${period.label}${filterText(filters)}. Try another date or order number?`, `No records found for ${period.label}${filterText(filters)}. Vera date or order number try pannalaama?`)}` };
  const label = dimension === "order" ? "Order" : GROUP_LABEL[dimension];
  const cell = (row: Record<string, unknown>) => {
    const value = String(row[dimension]);
    return dimension === "material" || dimension === "material_group" || dimension === "order" ? code(value) : value;
  };
  let headers: string[];
  let rows: string[][];
  if (data.ranked_per_currency) {
    headers = ["#", label, "Currency", metric === "cost_amount" ? "Cost" : "Net Amount", "Qty"];
    rows = data.rows.map((row) => [String(row.rank), cell(row), String(row.currency), amt(Number(row.value)), qty(Number(row.quantity))]);
  } else if (metric === "order_count") {
    headers = ["#", label, "Orders", "Items"];
    rows = data.rows.map((row) => [String(row.rank), cell(row), String(row.value), String(row.items)]);
  } else {
    headers = ["#", label, "Qty", "Orders"];
    rows = data.rows.map((row) => [String(row.rank), cell(row), qty(Number(row.value)), String(row.orders)]);
  }
  const currencyCount = new Set(data.rows.map((row) => String(row.currency ?? ""))).size;
  const multiCurrency = data.ranked_per_currency && currencyCount > 1;
  return finish(
    [
      `${lead}Top ${Math.min(n, data.total_groups)} ${dimName} by ${metricName}${multiCurrency ? " per currency" : ""} — ${period.label.replace(/^On /, "")}${filterText(filters)}:`,
      table(headers, rows),
      multiCurrency && !explicitN
        ? say(lang, "Amounts are ranked separately per currency. Add EUR, INR or USD to see the top 10 in one currency.", "Amounts currency-wise thaniya rank pannirukken. Top 10 paakka EUR, INR or USD sollunga.")
        : data.total_groups > n
          ? `Showing top ${n} of ${data.total_groups}.`
          : null,
      notesLine(data.warnings),
      basisLine(period, data.data_as_of),
    ],
    metric === "quantity"
      ? followUp(lang, "Want it by net amount instead?", "Net amount vachu paakanuma?", `Top ${n} ${dimName} by net amount ${period.query}${filterQuery(filters)}`)
      : followUp(lang, "Want it by quantity instead?", "Quantity vachu paakanuma?", `Top ${n} ${dimName} by quantity ${period.query}${filterQuery(filters)}`),
  );
}

/** Short column name: "Last month", "July 2026", "25-Sep-2026" or "01-Sep-2026 to 10-Sep-2026". */
function periodName(period: Period): string {
  if (period.kind === "keyword") return period.label.replace(/\s*\(.*\)$/, "");
  if (period.kind === "day") return displayDate(period.from);
  return `${displayDate(period.from)} to ${displayDate(period.to)}`;
}

function periodSpan(period: Period): string {
  return period.from === period.to ? displayDate(period.from) : `${displayDate(period.from)} to ${displayDate(period.to)}`;
}

async function compareAnswer(x: Period, y: Period, filters: SalesFilters, lang: Lang): Promise<SalesAssistantReply> {
  const [current, previous] = x.from >= y.from ? [x, y] : [y, x];
  const data = await comparePeriods({
    period_a: { date_from: current.from, date_to: current.to, label: current.label },
    period_b: { date_from: previous.from, date_to: previous.to, label: previous.label },
    filters,
  });
  const cur = periodName(current);
  const prev = periodName(previous);
  const scope = filterText(filters);
  const t = data.totals;
  if (t.item_count.a === 0 && t.item_count.b === 0) {
    return { message: say(lang, `No sales records found for ${cur} or ${prev}${scope}. Try another date?`, `No records found for ${cur} and ${prev}${scope}. Vera date try pannalaama?`) };
  }

  type Change = { a: number; b: number; difference: number; change_pct: number | null };
  const signed = (value: number, format: (n: number) => string) => (value === 0 ? format(0) : `${value > 0 ? "+" : "-"}${format(Math.abs(value))}`);
  const pct = (change: Change) => (change.change_pct === null ? "N/A" : `${change.change_pct > 0 ? "+" : ""}${change.change_pct}%`);
  const row = (label: string, change: Change, format: (n: number) => string) => [label, format(change.b), format(change.a), signed(change.difference, format), pct(change)];
  const showCost = canSeeCost();

  const rows: string[][] = [
    row("Sales orders", t.order_count, qty),
    row("Items", t.item_count, qty),
    row("Quantity", t.total_quantity, qty),
    ...(t.confirmed_quantity.a || t.confirmed_quantity.b ? [row("Confirmed delivery qty", t.confirmed_quantity, qty)] : []),
    ...(t.return_items.a || t.return_items.b ? [row("Return items", t.return_items, qty)] : []),
    ...data.by_currency.flatMap((entry) => [
      row(`Net amount ${entry.currency}`, entry.net_amount, amt),
      row(`Tax amount ${entry.currency}`, entry.tax_amount, amt),
      ...(showCost ? [row(`Cost amount ${entry.currency}`, entry.cost_amount, amt)] : []),
    ]),
  ];

  const movement = (name: string, change: Change, unit = "") =>
    change.difference === 0 ? `${name} unchanged` : `${name} ${change.difference > 0 ? "up" : "down"} ${qty(Math.abs(change.difference))}${unit}${change.change_pct === null ? "" : ` (${pct(change)})`}`;
  const lead = `${cur} vs ${prev}${scope}: ${movement("sales orders", t.order_count)}, ${movement("quantity", t.total_quantity, " units")}.`;

  const notes: string[] = [...data.warnings];
  if (t.foc_items.a || t.foc_items.b) notes.unshift("FOC items excluded from sales value.");
  if (data.by_currency.length > 1) notes.push("Amounts are shown per currency and never added across currencies.");
  if (rows.some((entry) => entry[4] === "N/A")) notes.push("N/A = the previous period value is zero, so % change is not calculated.");
  if (t.return_items.a || t.return_items.b) notes.push("Return items are included in the totals.");

  return finish(
    [
      lead,
      table(["Metric", prev, cur, "Difference", "% Change"], rows),
      notesLine(notes),
      `Based on items created: ${prev} = ${periodSpan(previous)}; ${cur} = ${periodSpan(current)}. Data as of ${data.data_as_of}.`,
    ],
    followUp(lang, `Want a plant-wise split for ${cur}?`, `${cur} plant-wise split paakanuma?`, `Plant-wise sales ${current.query}${filterQuery(filters)}`),
  );
}

async function materialLookupAnswer(textValue: string, lang: Lang): Promise<SalesAssistantReply> {
  const data = await searchMaterial({ text: textValue });
  if (!data.total_matches) return { message: say(lang, `No materials matching ${code(textValue)} in the last 31 days.`, `${code(textValue)} match aagura material last 31 days la illa.`) };
  const rows = data.matches.slice(0, 10).map((row) => [code(row.material), row.kind + (row.variants ? ` (${row.variants} variants)` : ""), qty(row.sales_items), qty(row.quantity), row.last_created ?? "—"]);
  const first = data.matches[0];
  return finish(
    [
      `${plural(data.total_matches, "material")} match ${code(textValue)}.`,
      table(["Material", "Type", "Items", "Qty", "Last created"], rows),
      data.total_matches > 10 ? `Showing top 10 of ${data.total_matches}.` : null,
      `Based on items created in the last 31 days. Data as of ${data.data_as_of}.`,
    ],
    followUp(lang, `Want this month's sales for ${first.material}?`, `${first.material} indha maasam sales paakanuma?`, `Sales this month material ${first.material}`),
  );
}

function lastAssistantFollowUp(history: SalesAssistantTurn[]): string | null {
  const last = [...history].reverse().find((turn) => turn.role === "assistant");
  if (!last) return null;
  const line = last.content.trim().split("\n").pop()?.trim().toLowerCase() ?? "";
  return followUps.get(line) ?? null;
}

// Conversation carry-over ---------------------------------------------------

const REFINE_CUE = /\b(adhula|athula|adhil|idhula|ithula|in that|of that|from that|same|only|mattum|just|what about|how about)\b/;
const REFINE_FILLER =
  /\b(adhula|athula|adhil|idhula|ithula|in|that|of|from|same|only|mattum|just|what|how|about|and|sales?|evlo|evvalavu|show|kaatu|kaattu|sollu|podu|please|pls|plant|currency|for|the|material|style|group|route|foc|free|items?|customer|division|district)\b/g;

function stripFilterTokens(text: string): string {
  return stripCodeFilters(text).replace(PLANT_RE, " ").replace(CURRENCY_RE, " ").replace(GROUP_RE, " ").replace(ROUTE_RE, " ").replace(CATEGORY_RE, " ").replace(EXPLICIT_MATERIAL_RE, " ").replace(RETURNS_RE, " ");
}

function isRefinement(message: string, today: string): boolean {
  const text = message.toLowerCase().trim();
  const { found, masked: rawMasked } = findPeriods(text, today);
  const masked = stripCodeFilters(rawMasked);
  if (found.length || /\d{3,10}/.test(masked.replace(/\b(p\d{3}|mc\d{6}|z\d{5})\b/g, "")) && orderFrom(masked)) return false;
  const filters = filtersFrom(message, masked);
  if (!Object.keys(filters).length && !wantsFocText(text)) return false;
  let leftover = stripFilterTokens(masked);
  if (filters.material) leftover = leftover.replace(new RegExp(filters.material.replace(/[-]/g, "\\-"), "gi"), " ");
  leftover = leftover.replace(REFINE_FILLER, " ").replace(/[?.!,]/g, " ").trim();
  return text.split(/\s+/).length <= 7 && (REFINE_CUE.test(text) || !leftover);
}

function withoutConflicts(base: string, filters: SalesFilters): string {
  let text = base;
  if (filters.plant) text = text.replace(PLANT_RE, " ");
  if (filters.currency) text = text.replace(CURRENCY_RE, " ");
  if (filters.material_group) text = text.replace(GROUP_RE, " ");
  if (filters.route) text = text.replace(ROUTE_RE, " ");
  if (filters.item_category) text = text.replace(CATEGORY_RE, " ");
  if (filters.customer_group) text = text.replace(CUSTOMER_GROUP_RE, " ");
  if (filters.division) text = text.replace(DIVISION_RE, " ");
  if (filters.sales_district) text = text.replace(DISTRICT_RE, " ");
  if (filters.material) {
    text = text.replace(EXPLICIT_MATERIAL_RE, " ");
    const token = materialToken(text.toLowerCase());
    if (token) text = text.replace(new RegExp(token.replace(/[-]/g, "\\-"), "gi"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

/** "adhula INR mattum" after "nethu evlo sales?" → "nethu evlo sales? INR" (same date, only the mentioned filter changes). */
function refineFromHistory(message: string, history: SalesAssistantTurn[], today: string): { question: string; changes: string } | null {
  if (!isRefinement(message, today)) return null;
  const users = history.filter((turn) => turn.role === "user").map((turn) => turn.content).reverse();
  const carried: SalesFilters = {};
  let carriedFoc = false;
  let base: string | null = null;
  for (const previous of users) {
    if (isRefinement(previous, today)) {
      const earlier = filtersFrom(previous, findPeriods(previous.toLowerCase(), today).masked);
      for (const [key, value] of Object.entries(earlier)) if (!(key in carried)) (carried as Record<string, unknown>)[key] = value;
      carriedFoc = carriedFoc || wantsFocText(previous.toLowerCase());
      continue;
    }
    base = previous;
    break;
  }
  if (!base) return null;
  const current = filtersFrom(message, findPeriods(message.toLowerCase(), today).masked);
  const merged = { ...carried, ...current };
  const foc = wantsFocText(message.toLowerCase()) || carriedFoc;
  const question = `${withoutConflicts(base, merged)}${filterQuery(merged)}${foc && !wantsFocText(base.toLowerCase()) ? " FOC" : ""}`;
  const subject = orderFrom(findPeriods(base.toLowerCase(), today).masked) ? "order" : "date";
  const changes = [filterText(current).slice(2), wantsFocText(message.toLowerCase()) ? "FOC" : ""].filter(Boolean).join(", ");
  return { question, changes: `Same ${subject}, ${changes} only:` };
}

// Help ------------------------------------------------------------------------

const HELP_EXAMPLES = {
  en: ["Sales today", "Order 70026656 delivered?", "Blocked orders this week", "Top 10 materials by quantity this month", "Compare yesterday vs today"],
  ta: ["Inniki sales evlo?", "70026656 delivered ah?", "Blocked orders kaatu", "Indha maasam top 10 materials by quantity", "Nethu vs inniki compare pannu"],
};

export function isSalesHelp(message: string): boolean {
  return /\b(enna panna mudiyum|enna ellam panna mudiyum|what can you do|how can you help|sales help|help me with sales)\b/i.test(message);
}

export function salesHelpReply(message: string): SalesAssistantReply {
  const lang = detectLang(message);
  const examples = HELP_EXAMPLES[lang];
  return {
    message: [
      say(lang, "I'm Evolv Sales Assistant — I answer questions on SAP sales order items (read-only). Try:", "Naan Evolv Sales Assistant — SAP sales order items pathi kelunga (read-only). Example:"),
      ...examples.map((example) => `- ${example}`),
    ].join("\n"),
    suggestions: examples.map((example) => ({ label: example, question: example })),
  };
}

// Router ----------------------------------------------------------------------

const SALES_WORDS =
  /\b(sales?|sold|orders?|items?|quantity|qty|units|pieces|pcs|value|amount|revenue|net|tax|cost|margin|profit|foc|evlo|evvalavu|total|summary|business|turnover|vithanai|vitpanai|materials?|styles?|articles?|sku|plants?|deliver(y|ed)?|billing|billed|blocked?|incomplete|pending|dispatch|top|highest|compare|vs|latest|anuppala|anuppitanga|free|samples?|returns?|divisions?|district|customer group)\b/;

async function answerWithRules(message: string, history: SalesAssistantTurn[], now: Date, depth = 0): Promise<SalesAssistantReply | null> {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  const lang = detectLang(message);
  const today = businessToday(now).date;

  if (/^(yes|yeah|yep|ok|okay|sure|please|pls|show|show me|go ahead|aama|aam|ama|venum|kaatu|kaattu|podu|sari|seri|haan)\b[\s!.]*(please|pls)?[\s!.]*$/.test(text) && depth === 0) {
    const question = lastAssistantFollowUp(history);
    if (question) return answerWithRules(question, history, now, 1);
  }

  if (depth === 0) {
    const refined = refineFromHistory(message, history, today);
    if (refined) {
      const reply = await answerWithRules(refined.question, history, now, 1);
      if (reply) return { ...reply, message: `${refined.changes}\n${reply.message}` };
    }
  }

  if (isSalesHelp(text)) return salesHelpReply(message);
  const outside = outOfScope(text, lang);
  if (outside) return outside;
  if (isWrite(text)) {
    return {
      message: say(lang, "I'm a read-only assistant and can't create, change or delete SAP data. Want the order details instead?", "Naan read-only assistant, SAP data va create/change/delete panna mudiyadhu. Order details paakanuma?"),
    };
  }

  const { found, masked, unclear } = findPeriods(text, today);
  const cleaned = stripCodeFilters(masked).replace(/\btop\s*\d{1,2}\b/g, " ");
  const viewMode = wantsFocText(text) && viewModeFrom(text) === "count" ? null : viewModeFrom(text);
  const wantsCost = wantsCostText(text);
  if (wantsCost && !canSeeCost()) {
    const withoutCost = message.replace(/\b(cost|margin|profit|labam|laabam)\b/gi, " ").replace(/\s+/g, " ").trim();
    return finish(
      [costDenied(lang)],
      SALES_WORDS.test(withoutCost.toLowerCase()) || found.length ? followUp(lang, "Want the net sales instead?", "Net sales paakanuma?", withoutCost || "Sales today") : undefined,
    );
  }

  const materialSearch = text.match(/\b(?:search|find|lookup|look up|thedu)\s+(?:for\s+)?(?:material|style|article|sku)?\s*([a-z0-9][a-z0-9-]{2,})\b/) ?? text.match(/\b(?:materials?|styles?) (?:like|matching|starting with)\s+([a-z0-9][a-z0-9-]{2,})\b/);
  if (materialSearch) return materialLookupAnswer(materialSearch[1].toUpperCase(), lang);

  const orders = ordersFrom(cleaned);
  if (orders.length >= 2 && (COMPARE_WORDS.test(text) || viewMode)) {
    const result = await compareOrdersView(orders[0], orders[1], viewMode, wantsCost);
    return withView(result, result.view ? followUp(lang, `Want order ${orders[0]} in detail?`, `Order ${orders[0]} detail ah paakanuma?`, `Order ${orders[0]} report`) : undefined);
  }
  const order = orderFrom(cleaned);
  if (order && viewMode) {
    const result = await orderView(viewMode, order, wantsCost);
    return withView(result, result.view ? viewFollowUp(lang, viewMode, `Order ${order}`) : undefined);
  }
  if (order) return orderAnswer(order, text, lang);

  const orderSpecific = /\b(this order|the order|that order|my order)\b/.test(text) || (/\border\b/.test(text) && /\b(delivered|status|value|items of)\b/.test(text) && !/\borders\b/.test(text));
  if (orderSpecific) return { message: say(lang, "Which order number?", "Endha order number?") };

  if (unclear && found.length === 0) return { message: say(lang, "Which dates exactly? For example, last 3 days or 20-Sep-2026 to 25-Sep-2026.", "Exact ah endha dates? Example: last 3 days or 20-Sep-2026 to 25-Sep-2026.") };

  const filters = filtersFrom(message, masked);
  const status = statusFrom(text);
  const groupBy = groupByFrom(text);
  const isTop = /\b(top|highest|best|most|biggest|largest|leading)\b/.test(text);
  const isCompare = /\b(vs|versus|compare|compared|comparison)\b/.test(text);
  if (!SALES_WORDS.test(text) && found.length === 0 && !status && !groupBy && !filters.material) return null;

  let period: Period | null = null;
  let defaulted = false;
  if (found.length >= 2 && !isCompare && found.every((entry) => entry.period.kind === "day")) {
    const dates = found.map((entry) => entry.period.from).sort();
    period = rangePeriod(dates[0], dates[dates.length - 1]);
  } else if (found.length) {
    period = found[0].period;
  } else if ((groupBy || /\b(foc|cost|margin|tax|split)\b/.test(text)) && text.split(" ").length <= 5) {
    const previous = [...history].reverse().find((turn) => turn.role === "user");
    const prior = previous ? findPeriods(previous.content.toLowerCase(), today).found[0]?.period : undefined;
    if (prior) period = prior;
  }
  if (!period) {
    period = { ...dayPeriod(today, today), label: "Today" };
    defaulted = true;
  }

  if (viewMode && !isCompare && !isTop) {
    const viewPeriod = { from: period.from, to: period.to, label: defaulted ? `Today (${displayDate(period.from)})` : period.label.replace(/^On /, "") };
    const result = await periodView(viewMode, viewPeriod, filters, status, wantsCost);
    return withView(result, result.view ? viewFollowUp(lang, viewMode, `Sales ${period.query}${filterQuery(filters)}`) : undefined);
  }

  if (isCompare) {
    const second = found.length >= 2 ? found[1].period : previousPeriod(period, today);
    return compareAnswer(period, second, filters, lang);
  }
  if (status) return statusAnswer(status, period, defaulted, text, filters, lang);
  if (isTop) return topAnswer(text, period, defaulted, filters, lang);
  return summaryAnswer(period, defaulted, text, filters, lang, groupBy);
}

function toolErrorMessage(error: ToolInputError, lang: Lang): string {
  if (error.code === "range_too_large") return say(lang, error.message, "6 maasathukku mela range edukka mudiyadhu. Konjam narrow pannunga (e.g. last 3 months or indha maasam).");
  if (error.code === "plant_access") return say(lang, error.message, `Indha plant data ungalukku access illa. Allowed: ${allowedPlantsText()}.`);
  if (error.code === "cost_access") return costDenied(lang);
  return error.message;
}

/** Several questions in one message ("sales today? blocked orders?") → one short section each. */
function splitQuestions(message: string): string[] {
  const parts = message
    .split(/\?\s+(?=\S)|\n+/)
    .map((part) => part.trim().replace(/\?$/, ""))
    .filter((part) => part.length > 2);
  return parts.length >= 2 && parts.length <= 4 ? parts : [];
}

async function answerRulesSafely(message: string, history: SalesAssistantTurn[], now: Date): Promise<SalesAssistantReply | null> {
  const lang = detectLang(message);
  try {
    return await answerWithRules(message, history, now);
  } catch (error) {
    obs("ERROR", { stage: "sales_assistant_rules", reason: error instanceof Error ? error.message : "unknown" });
    if (error instanceof ToolInputError) return { message: toolErrorMessage(error, lang) };
    return { message: SAP_DOWN[lang] };
  }
}

// ---------------------------------------------------------------------------

/**
 * Evolv Sales Assistant entry point. Returns null when the message is not a sales question
 * and the rule planner is in charge (so other modules can answer).
 */
export async function answerSalesAssistant(message: string, history: SalesAssistantTurn[], now = new Date()): Promise<SalesAssistantReply | null> {
  if (llmConfigured() && !needsStructuredView(message)) {
    try {
      return { message: await answerWithLlm(message, history, now) };
    } catch (error) {
      obs("ERROR", { stage: "sales_assistant_llm", reason: error instanceof Error ? error.message : "unknown" });
    }
  }
  const parts = splitQuestions(message);
  if (parts.length) {
    const answers = await Promise.all(parts.map((part) => answerRulesSafely(part, history, now)));
    if (answers.every(Boolean)) {
      return {
        message: parts.map((part, index) => `**${part}**\n${answers[index]!.message}`).join("\n\n"),
        suggestions: answers.flatMap((answer) => answer!.suggestions ?? []).slice(0, 3),
      };
    }
  }
  return answerRulesSafely(message, history, now);
}
