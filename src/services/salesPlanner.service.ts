/*
 * Sales Query Intelligence — intent + entity + date resolver + query planner,
 * plan validation, controlled tool execution, and response composition.
 * The rule planner works without an LLM; an LLM planner (salesLlmPlanner) emits the same QueryPlan shape,
 * and every plan passes validateQueryPlan before any tool runs.
 */
import { obs } from "./audit.service";
import {
  NAMED_PERIODS,
  isInProgress,
  rangeForSpec,
  resolvePeriodSpec,
  validateDateRange,
  type PeriodKind,
  type PeriodSpec,
} from "./dateEngine.service";
import {
  blankShare,
  computeKpis,
  dominantCurrency,
  groupSales,
  rankGroups,
  statusLabel,
  type AnalyticsBundle,
  type FilterField,
  type GroupDimension,
  type GroupRow,
  type RankMetric,
  type SalesFilters,
} from "./salesAnalytics.service";
import {
  getSalesComparison,
  getSalesData,
  getSalesGrouped,
  getSalesOrder,
  getSalesSummary,
  getSalesTrend,
  groupToolFor,
  type SalesToolName,
} from "./salesTools.service";
import { businessToday, type CurrencyTotal, type QuantityTotal, type SalesItemRecord, type UniqueSalesOrder } from "./sapSales.service";

export type PlanEntity = "SALES_ORDER" | "SALES" | "SALES_ITEM";
export type PlanMetric = "COUNT" | "ITEM_COUNT" | "QUANTITY" | "NET_AMOUNT" | "AVG_ORDER_VALUE" | "SUMMARY";
export type PlanOutput = "KPI" | "SUMMARY" | "TABLE" | "DETAIL" | "CHART" | "DASHBOARD" | "COMPARISON" | "REPORT";
export type SalesIntent =
  | "SALES_KPI"
  | "SALES_SUMMARY"
  | "SALES_ORDER_DETAIL"
  | "SALES_GROUPING"
  | "SALES_TREND"
  | "SALES_COMPARISON"
  | "SALES_DASHBOARD"
  | "SALES_REPORT"
  | "SALES_PENDING";

export interface QueryPlan {
  intent: SalesIntent;
  entity: PlanEntity;
  metric: PlanMetric;
  period: PeriodKind;
  dateRange?: { startDate: string; endDateExclusive: string };
  comparePeriod?: PeriodKind;
  compareDateRange?: { startDate: string; endDateExclusive: string };
  groupBy: GroupDimension[];
  sort: { field: RankMetric; direction: "DESC" | "ASC" } | null;
  limit: number | null;
  output: PlanOutput;
  salesOrder?: string;
  filters?: SalesFilters;
  wantPdf?: boolean;
  /** No period in the question or context; the planner defaulted to THIS_MONTH and says so. */
  periodAssumed?: boolean;
  /** "Why are sales lower…" — answer with data-backed comparison, never invent causes. */
  explainWhy?: boolean;
  /** User asked about customers; the API only has Customer Group. */
  customerRequested?: boolean;
}

export interface ChartSpec {
  title: string;
  kind: "bar" | "line";
  labels: string[];
  series: Array<{ name: string; values: number[]; color?: string }>;
}

export interface ViewSection {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface ViewProvenance {
  source: "SAP_SALES_API";
  retrievedAt: string;
  period: string;
  recordCount: number;
  calculation: "DISTINCT SalesOrder";
}

export interface StructuredView {
  mode: "count" | "report" | "details" | "table" | "pdf" | "dashboard" | "comparison" | "chart";
  title: string;
  kpis: Array<{ label: string; value: string }>;
  columns: string[];
  rows: string[][];
  charts?: ChartSpec[];
  sections?: ViewSection[];
  bullets?: string[];
  source?: string;
  updatedAt?: string;
  note?: string;
  provenance?: ViewProvenance;
  exportId?: string;
  exportFormats?: Array<"pdf" | "xlsx" | "csv">;
}

export interface PlannerResult {
  message: string;
  view?: StructuredView;
  clarification?: boolean;
  plan?: QueryPlan;
  tool?: SalesToolName;
  /** Normalized item records behind the answer; used for Excel/CSV exports, never sent to the browser. */
  records?: SalesItemRecord[];
}

export interface PendingClarification {
  kind: "PERIOD" | "METRIC";
  plan: QueryPlan;
}

export interface PlannerContext {
  lastPlan?: QueryPlan;
  pending?: PendingClarification;
}

export interface PlanOutcome {
  plan: QueryPlan | null;
  clarification?: string;
  pending?: PendingClarification;
}

export interface ReplySuggestion {
  label: string;
  question: string;
}

export function suggestionsForOutcome(outcome: PlanOutcome): ReplySuggestion[] {
  if (outcome.pending?.kind === "PERIOD" || /Which period/.test(outcome.clarification ?? "")) {
    return [
      { label: "Today", question: "today" },
      { label: "This week", question: "this week" },
      { label: "This month", question: "this month" },
      { label: "Last month", question: "last month" },
      { label: "This year", question: "this year" },
    ];
  }
  if (outcome.pending?.kind === "METRIC") {
    return [
      { label: "By amount", question: "by amount" },
      { label: "By quantity", question: "by quantity" },
      { label: "By orders", question: "by number of orders" },
    ];
  }
  if (/export/.test(outcome.clarification ?? "")) {
    return [
      { label: "Month report", question: "this month's sales report" },
      { label: "Today summary", question: "today's sales summary" },
    ];
  }
  return [];
}

export function followUpSuggestions(plan: QueryPlan): ReplySuggestion[] {
  const items: ReplySuggestion[] = [];
  if (!plan.salesOrder && plan.output !== "COMPARISON") {
    items.push({ label: "Compare last month", question: "Compare that with last month" });
  }
  if (!plan.wantPdf) {
    items.push({ label: "Download PDF", question: "Make this a PDF" });
  }
  if (!plan.salesOrder && plan.output !== "DASHBOARD") {
    items.push({ label: "Dashboard", question: "Show a dashboard" });
  }
  if (!plan.salesOrder && !plan.filters?.pendingOnly) {
    items.push({ label: "Pending orders", question: "Show pending sales orders" });
  }
  if (!plan.salesOrder && plan.groupBy[0] !== "PLANT") {
    items.push({ label: "By plant", question: "Sales by plant" });
  }
  if (!plan.salesOrder && plan.groupBy[0] !== "MATERIAL") {
    items.push({ label: "Top materials", question: "Top 10 materials" });
  }
  return items.slice(0, 5);
}

const ALLOWED_INTENTS: SalesIntent[] = [
  "SALES_KPI", "SALES_SUMMARY", "SALES_ORDER_DETAIL", "SALES_GROUPING", "SALES_TREND", "SALES_COMPARISON", "SALES_DASHBOARD", "SALES_REPORT", "SALES_PENDING",
];
const ALLOWED_ENTITIES: PlanEntity[] = ["SALES_ORDER", "SALES", "SALES_ITEM"];
const ALLOWED_METRICS: PlanMetric[] = ["COUNT", "ITEM_COUNT", "QUANTITY", "NET_AMOUNT", "AVG_ORDER_VALUE", "SUMMARY"];
const ALLOWED_GROUP: GroupDimension[] = ["DATE", "SALES_ORDER", "MATERIAL", "PLANT", "CUSTOMER_GROUP", "CURRENCY", "DELIVERY_STATUS", "BILLING_STATUS"];
const ALLOWED_OUTPUT: PlanOutput[] = ["KPI", "SUMMARY", "TABLE", "DETAIL", "CHART", "DASHBOARD", "COMPARISON", "REPORT"];
const ALLOWED_RANK: RankMetric[] = ["AMOUNT", "QUANTITY", "ITEM_COUNT", "SALES_ORDERS"];
const ALLOWED_FILTERS: FilterField[] = ["MATERIAL", "PLANT", "CURRENCY", "CUSTOMER_GROUP", "DELIVERY_STATUS", "BILLING_STATUS"];
const MAX_LIMIT = 100;
const FORBIDDEN =
  /\b(insert|delete|drop|alter|truncate|grant|revoke|upsert|exec)\b|\bmerge\s+into\b|\bupdate\s+(the\s+|all\s+)?(sales|orders?|records?|tables?|data|status|quantity|amount)\b|\bselect\b[\s\S]*\bfrom\b|;\s*--|\b(create|cancel|modify|change|remove)\s+(a\s+|the\s+|all\s+|this\s+)?(new\s+)?(sales\s+)?(orders?|records?|tables?)\b/i;

/** The Sales assistant is read-only: data-changing or SQL-shaped requests are refused before planning. */
export function isWriteRequest(message: string): boolean {
  return FORBIDDEN.test(message);
}

export const MSG_SAP_FAILURE = "Unable to retrieve the latest sales data from SAP.";
export const MSG_EMPTY = "No sales records were found for the requested period.";
export const MSG_NEED_INFO = "I need a little more information. Please specify the sales period or metric.";
export const MSG_ASK_PERIOD = "Sure. Which period do you want: today, this week, this month, last month, or this year?";
export const MSG_ASK_CUSTOMER_METRIC = "Do you want the top customers by sales amount, quantity, or number of orders?";
const NO_CUSTOMER_NOTE =
  "The SAP Sales API does not return a customer field, so customer questions are answered by Customer Group.";
const WHY_NOTE =
  "SAP sales data shows what changed, not why it changed. The figures below are the measurable differences; causes (pricing, demand, customers) are not in this data.";

// ---------- Date resolver ----------

/** Kept for callers that only need a named period. */
export function resolvePeriod(text: string, now = new Date()): PeriodKind | null {
  return resolvePeriodSpec(text, now)?.period ?? null;
}

export function specOf(plan: QueryPlan): PeriodSpec {
  return { period: plan.period, dateRange: plan.dateRange };
}

function compareSpecOf(plan: QueryPlan): PeriodSpec | undefined {
  return plan.comparePeriod ? { period: plan.comparePeriod, dateRange: plan.compareDateRange } : undefined;
}

function withPeriod(plan: QueryPlan, spec: PeriodSpec): QueryPlan {
  return { ...plan, period: spec.period, dateRange: spec.dateRange, periodAssumed: false };
}

/** Sales order numbers are 5–12 digits; a year is only an order number when explicitly called one. */
function salesOrderFromText(text: string): string | null {
  const explicit = text.match(/\b(?:sales\s*order|order|so|document|#)\s*(?:no\.?|number|#)?\s*:?\s*(\d{4,12})\b/);
  if (explicit) return explicit[1];
  const candidates = [...text.matchAll(/\b(\d{5,12})\b/g)].map((match) => match[1]);
  return candidates.sort((left, right) => right.length - left.length)[0] ?? null;
}

// ---------- Text classifiers ----------

const RE_COMPARE = /\bcompare|\bcompar(ed|ison)\b|\bvs\.?\b|\bversus\b|\bagainst\b/;
const RE_WHY = /\bwhy\b.*\b(lower|higher|less|more|drop|dropped|decrease|decreased|increase|increased|down|up|fell|grew|decline|declined)\b/;
const RE_DASHBOARD = /\bdashboard\b/;
const RE_REPORT = /\breport\b/;
const RE_TREND = /\btrend\b|\bdaily\b|\bover time\b|\bby day\b|\bday[- ]?wise\b|\bper day\b|\beach day\b|\bchart\b|\bgraph\b/;
const RE_PENDING = /\bpending\b|\bopen (sales )?orders?\b|\bnot (yet )?delivered\b|\bundelivered\b|\bbacklog\b/;
const RE_SUMMARY = /\bsummary\b|\bperformance\b|\boverview\b|\bhow (are|were|did|is) (the )?sales\b/;
const RE_RANK = /\btop\b|\bbottom\b|\bhighest\b|\blowest\b|\blargest\b|\bbiggest\b|\bsmallest\b|\bbest\b|\bworst\b/;
const RE_EXPORT = /\bpdf\b|\bexcel\b|\bxlsx\b|\bcsv\b|\bexport\b|\bdownload\b/;
const RE_SALES_WORD = /\bsales?\b|\borders?\b|\brevenue\b|\bquantity\b|\bamount\b|\bitems?\b|\bmaterials?\b|\bplants?\b|\bcustomers?\b|\bkpis?\b/;

function metricFromText(text: string): PlanMetric | null {
  if (/average order value|avg\.? order value|\baov\b|average value/.test(text)) return "AVG_ORDER_VALUE";
  if (/how many items|item count|number of items|how many (sales )?order items|how many lines/.test(text)) return "ITEM_COUNT";
  if (/\bquantity\b|\bunits\b|\bqty\b|how much quantity/.test(text)) return "QUANTITY";
  if (/\bnet amount\b|\bamount\b|\brevenue\b|sales value|\bturnover\b|how much (did we )?sell/.test(text)) return "NET_AMOUNT";
  if (/how many\b|number of (sales )?orders|order count|\bcount\b|\btotal orders\b/.test(text)) return "COUNT";
  return null;
}

function groupDimensionFromText(text: string): GroupDimension | null {
  if (/\bcustomer groups?\b/.test(text)) return "CUSTOMER_GROUP";
  if (/\bcustomers?\b/.test(text)) return "CUSTOMER_GROUP";
  if (/\bmaterials?\b|\bproducts?\b|\bstyles?\b|\bskus?\b/.test(text)) return "MATERIAL";
  if (/\bplants?\b/.test(text)) return "PLANT";
  if (/\bcurrenc(y|ies)\b/.test(text)) return "CURRENCY";
  if (/\bdelivery status\b|\bby delivery\b|\bdelivery\b/.test(text)) return "DELIVERY_STATUS";
  if (/\bbilling status\b|\bby billing\b|\bbilling\b/.test(text)) return "BILLING_STATUS";
  if (/\bby date\b|\bby day\b|\bdaily\b/.test(text)) return "DATE";
  if (RE_RANK.test(text) && /\b(sales )?orders?\b/.test(text)) return "SALES_ORDER";
  return null;
}

function explicitRankMetric(text: string): RankMetric | null {
  if (/\bquantity\b|\bunits\b|\bqty\b/.test(text)) return "QUANTITY";
  if (/\bamount\b|\brevenue\b|\bvalue\b|\bnet\b/.test(text)) return "AMOUNT";
  if (/\bnumber of orders\b|\border count\b|\bby orders\b|\borders\b/.test(text)) return "SALES_ORDERS";
  if (/\bitems\b|\blines\b/.test(text)) return "ITEM_COUNT";
  return null;
}

function hasOwnIntent(text: string): boolean {
  return (
    RE_COMPARE.test(text) || RE_WHY.test(text) || RE_DASHBOARD.test(text) || RE_REPORT.test(text) || RE_TREND.test(text) ||
    RE_PENDING.test(text) || RE_SUMMARY.test(text) || RE_RANK.test(text) || metricFromText(text) !== null || groupDimensionFromText(text) !== null
  );
}

function base(intent: SalesIntent, period: PeriodSpec, metric: PlanMetric, output: PlanOutput, wantPdf: boolean): QueryPlan {
  return { intent, entity: "SALES", metric, period: period.period, dateRange: period.dateRange, groupBy: [], sort: null, limit: null, output, wantPdf };
}

/** Split "compare X with Y" into base and target periods. */
function comparisonPeriods(text: string, now: Date): { base: PeriodSpec | null; target: PeriodSpec | null } {
  const parts = text.split(/\b(?:with|vs\.?|versus|against|to|and)\b/);
  if (parts.length >= 2) {
    const first = resolvePeriodSpec(parts[0], now);
    const second = resolvePeriodSpec(parts.slice(1).join(" "), now);
    if (second) return { base: first, target: second };
  }
  return { base: resolvePeriodSpec(text, now), target: null };
}

// ---------- Planner ----------

/**
 * Rule planner: intent + entities + period → QueryPlan, using conversation context for follow-ups.
 * Returns a clarification (and pending state) when the question is ambiguous.
 */
export function planFromText(message: string, context: PlannerContext = {}, now = new Date()): PlanOutcome {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  const found = resolvePeriodSpec(text, now);
  const periodSpec: PeriodSpec | null = found ? { period: found.period, dateRange: found.dateRange } : null;
  const orderText = found?.matched ? text.replace(found.matched, " ") : text;
  const salesOrder = salesOrderFromText(orderText);
  const wantPdf = /\bpdf\b/.test(text);
  const wantExport = RE_EXPORT.test(text);
  const last = context.lastPlan;
  const contextSpec = last && !last.salesOrder ? specOf(last) : null;
  const ownIntent = hasOwnIntent(text);

  // 1) Specific sales order.
  if (salesOrder) {
    const metric: PlanMetric = /how many items|number of items|item count|items (are )?in|how many lines/.test(text) ? "ITEM_COUNT" : "SUMMARY";
    return {
      plan: {
        intent: "SALES_ORDER_DETAIL",
        entity: "SALES_ORDER",
        metric,
        period: periodSpec?.period ?? "THIS_MONTH",
        dateRange: periodSpec?.dateRange,
        groupBy: [],
        sort: null,
        limit: null,
        output: metric === "ITEM_COUNT" ? "KPI" : "DETAIL",
        salesOrder,
        wantPdf,
      },
    };
  }

  // 2) Answer to a pending clarification.
  if (context.pending) {
    const pending = context.pending;
    if (pending.kind === "PERIOD" && periodSpec && !RE_COMPARE.test(text)) {
      return { plan: { ...withPeriod(pending.plan, periodSpec), wantPdf: wantPdf || pending.plan.wantPdf } };
    }
    if (pending.kind === "METRIC") {
      const rank = explicitRankMetric(text);
      if (rank) {
        const plan = { ...pending.plan, sort: { field: rank, direction: pending.plan.sort?.direction ?? "DESC" }, metric: metricForRank(rank) } as QueryPlan;
        return { plan: periodSpec ? withPeriod(plan, periodSpec) : plan };
      }
    }
  }

  // 3) Export follow-up: "make this a PDF", "export that to Excel".
  if (wantExport && !ownIntent && !periodSpec) {
    if (last) return { plan: { ...last, wantPdf: true } };
    return { plan: null, clarification: "Which sales data should I export? For example: \"this month's sales report\"." };
  }

  // 4) Period-only follow-up: "Not today. I want this month.", "what about last week?"
  if (periodSpec && !ownIntent && last && !last.salesOrder) {
    const next = withPeriod(last, periodSpec);
    if (next.output === "COMPARISON") {
      delete next.comparePeriod;
      delete next.compareDateRange;
    }
    return { plan: { ...next, wantPdf } };
  }

  // Period used by every new aggregate plan: explicit > conversation > assumed THIS_MONTH.
  const period = periodSpec ?? contextSpec;
  const assumed = !period;
  const periodOrMonth: PeriodSpec = period ?? { period: "THIS_MONTH" };
  const finish = (plan: QueryPlan): PlanOutcome => ({ plan: assumed ? { ...plan, periodAssumed: true } : plan });

  // 5) Comparison and "why" questions.
  const isWhy = RE_WHY.test(text);
  const refersBack = /\b(that|this|it|those|these|same)\b/.test(text);
  if (RE_COMPARE.test(text) || isWhy || (refersBack && last && /\b(last|previous|prior)\b/.test(text) && !RE_REPORT.test(text) && !RE_DASHBOARD.test(text))) {
    const { base: basePeriod, target } = comparisonPeriods(text, now);
    let baseSpec = basePeriod ?? contextSpec ?? { period: "THIS_MONTH" as PeriodKind };
    if (target && basePeriod === null && contextSpec && contextSpec.period === target.period) baseSpec = { period: "THIS_MONTH" };
    const dimension = groupDimensionFromText(text) ?? (refersBack && last?.groupBy[0] && last.groupBy[0] !== "DATE" ? last.groupBy[0] : null);
    const plan: QueryPlan = {
      ...base("SALES_COMPARISON", baseSpec, "SUMMARY", "COMPARISON", wantPdf),
      comparePeriod: target?.period,
      compareDateRange: target?.dateRange,
      groupBy: dimension ? [dimension] : [],
      sort: dimension ? { field: explicitRankMetric(text) ?? last?.sort?.field ?? "AMOUNT", direction: "DESC" } : null,
      limit: dimension ? (limitFromText(text) ?? last?.limit ?? 10) : null,
      explainWhy: isWhy || undefined,
      customerRequested: /\bcustomers?\b/.test(text) && !/customer groups?/.test(text) ? true : undefined,
    };
    return { plan: !basePeriod && !contextSpec ? { ...plan, periodAssumed: true } : plan };
  }

  // 6) Dashboard.
  if (RE_DASHBOARD.test(text)) return finish(base("SALES_DASHBOARD", periodOrMonth, "SUMMARY", "DASHBOARD", wantPdf));

  // 7) Report (explicit, or "PDF" alongside sales words).
  if (RE_REPORT.test(text) || (wantExport && RE_SALES_WORD.test(text) && !RE_RANK.test(text) && !groupDimensionFromText(text))) {
    return finish(base("SALES_REPORT", periodOrMonth, "SUMMARY", "REPORT", wantPdf));
  }

  // 8) Daily trend.
  if (RE_TREND.test(text)) {
    return finish({ ...base("SALES_TREND", periodOrMonth, "COUNT", "CHART", wantPdf), groupBy: ["DATE"] });
  }

  // 9) Pending sales orders (any item with delivery status A or B).
  if (RE_PENDING.test(text)) {
    const metric = metricFromText(text);
    if (metric && metric !== "SUMMARY" && /how many|count|number of/.test(text)) {
      return finish({ ...base("SALES_PENDING", periodOrMonth, metric, "KPI", wantPdf), filters: { pendingOnly: true } });
    }
    return finish({
      ...base("SALES_PENDING", periodOrMonth, "COUNT", "TABLE", wantPdf),
      groupBy: ["SALES_ORDER"],
      sort: { field: explicitRankMetric(text.replace(/\b(sales )?orders?\b/g, " ")) ?? "ITEM_COUNT", direction: "DESC" },
      limit: limitFromText(text) ?? 50,
      filters: { pendingOnly: true },
    });
  }

  // 10) Grouping / ranking (customers need an explicit ranking metric).
  const rank = RE_RANK.test(text);
  let dimension = groupDimensionFromText(text);
  if (!dimension && rank && last?.groupBy[0] && last.groupBy[0] !== "DATE") dimension = last.groupBy[0];
  if (dimension && dimension !== "DATE") {
    const customerRequested = /\bcustomers?\b/.test(text) && !/customer groups?/.test(text);
    const explicit = explicitRankMetric(text.replace(/\bsales orders?\b/g, dimension === "SALES_ORDER" ? "" : "$&"));
    const limit = limitFromText(text) ?? (rank ? 10 : null);
    const direction: "DESC" | "ASC" = /\bbottom\b|\blowest\b|\bsmallest\b|\bworst\b/.test(text) ? "ASC" : "DESC";
    const inheritedSort = last?.groupBy[0] === dimension ? last.sort?.field : undefined;
    const field: RankMetric = explicit ?? inheritedSort ?? (dimension === "DELIVERY_STATUS" || dimension === "BILLING_STATUS" ? "SALES_ORDERS" : "AMOUNT");
    const plan: QueryPlan = {
      ...base("SALES_GROUPING", periodOrMonth, metricForRank(field), "TABLE", wantPdf),
      groupBy: [dimension],
      sort: { field, direction },
      limit,
      customerRequested: customerRequested || undefined,
    };
    if (customerRequested && rank && !explicit) {
      return { plan: null, clarification: `${MSG_ASK_CUSTOMER_METRIC} (${NO_CUSTOMER_NOTE})`, pending: { kind: "METRIC", plan: assumed ? { ...plan, periodAssumed: true } : plan } };
    }
    return finish(plan);
  }

  // 11) Summary.
  if (RE_SUMMARY.test(text)) return finish(base("SALES_SUMMARY", periodOrMonth, "SUMMARY", "SUMMARY", wantPdf));

  // 12) Single KPI — a count without any period is ambiguous.
  const metric = metricFromText(text);
  if (metric && (RE_SALES_WORD.test(text) || last)) {
    const plan = base("SALES_KPI", periodOrMonth, metric, "KPI", wantPdf);
    if (!period) return { plan: null, clarification: MSG_ASK_PERIOD, pending: { kind: "PERIOD", plan } };
    return { plan };
  }

  // 13) Bare "show sales" — ask for the period.
  if (/\bsales\b|\bsales orders?\b/.test(text)) {
    const plan = base("SALES_SUMMARY", periodOrMonth, "SUMMARY", "SUMMARY", wantPdf);
    if (!periodSpec) return { plan: null, clarification: MSG_ASK_PERIOD, pending: { kind: "PERIOD", plan } };
    return { plan };
  }

  // 14) A bare period with no context: summarize it.
  if (periodSpec && !last && /\b(show|give|what|i want|display)\b/.test(text)) {
    return { plan: base("SALES_SUMMARY", periodSpec, "SUMMARY", "SUMMARY", wantPdf) };
  }

  if (RE_SALES_WORD.test(text) && /\b(show|give|get|what|list|tell|display|analy[sz]e)\b/.test(text)) {
    return { plan: null, clarification: MSG_NEED_INFO };
  }
  return { plan: null };
}

function limitFromText(text: string): number | null {
  const match = text.match(/\b(?:top|bottom|first|best|worst|highest|lowest|largest|biggest)\s+(\d{1,3})\b/) ?? text.match(/\b(\d{1,3})\s+(?:top|best|largest|biggest)\b/);
  return match ? Number(match[1]) : null;
}

function metricForRank(field: RankMetric): PlanMetric {
  return field === "AMOUNT" ? "NET_AMOUNT" : field === "QUANTITY" ? "QUANTITY" : field === "ITEM_COUNT" ? "ITEM_COUNT" : "COUNT";
}

/**
 * Replays user turns in order so follow-ups ("that", "make this a PDF", "not today…") resolve
 * against the last concrete plan, and clarification answers complete the pending plan.
 */
export function buildPlannerContext(userMessages: string[], now = new Date()): PlannerContext {
  let context: PlannerContext = {};
  for (const message of userMessages) {
    const outcome = planFromText(message, context, now);
    if (outcome.plan) {
      context = { lastPlan: { ...outcome.plan, wantPdf: false } };
    } else if (outcome.pending) {
      context = { ...context, pending: outcome.pending };
    }
  }
  return context;
}

// ---------- Validation ----------

function validSpec(period: PeriodKind, dateRange?: { startDate: string; endDateExclusive: string }): string | null {
  const allowed: string[] = [...NAMED_PERIODS, "CUSTOM_DATE", "CUSTOM_RANGE", "SPECIFIC_MONTH", "SPECIFIC_YEAR"];
  if (!allowed.includes(period)) return `period ${String(period)}`;
  return validateDateRange({ period, dateRange });
}

export function validateQueryPlan(plan: QueryPlan, rawMessage: string): { valid: boolean; reason?: string } {
  if (FORBIDDEN.test(rawMessage)) return { valid: false, reason: "read-only" };
  if (!plan || typeof plan !== "object") return { valid: false, reason: "plan" };
  if (!ALLOWED_INTENTS.includes(plan.intent)) return { valid: false, reason: `intent ${String(plan.intent)}` };
  if (!ALLOWED_ENTITIES.includes(plan.entity)) return { valid: false, reason: `entity ${String(plan.entity)}` };
  if (!ALLOWED_METRICS.includes(plan.metric)) return { valid: false, reason: `metric ${String(plan.metric)}` };
  const periodError = validSpec(plan.period, plan.dateRange);
  if (periodError) return { valid: false, reason: periodError };
  if (plan.comparePeriod) {
    const compareError = validSpec(plan.comparePeriod, plan.compareDateRange);
    if (compareError) return { valid: false, reason: `comparePeriod ${compareError}` };
  }
  if (!ALLOWED_OUTPUT.includes(plan.output)) return { valid: false, reason: `output ${String(plan.output)}` };
  if (!Array.isArray(plan.groupBy) || plan.groupBy.length > 2 || plan.groupBy.some((dimension) => !ALLOWED_GROUP.includes(dimension))) {
    return { valid: false, reason: "groupBy" };
  }
  if (plan.sort && (!ALLOWED_RANK.includes(plan.sort.field) || !["ASC", "DESC"].includes(plan.sort.direction))) return { valid: false, reason: "sort" };
  if (plan.limit !== null && (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > MAX_LIMIT)) return { valid: false, reason: "limit" };
  if (plan.salesOrder !== undefined && !/^\d{1,12}$/.test(plan.salesOrder)) return { valid: false, reason: "salesOrder" };
  if (plan.filters) {
    for (const [key, values] of Object.entries(plan.filters)) {
      if (key === "pendingOnly") {
        if (typeof values !== "boolean") return { valid: false, reason: "filters.pendingOnly" };
        continue;
      }
      if (!ALLOWED_FILTERS.includes(key as FilterField)) return { valid: false, reason: `filter ${key}` };
      if (!Array.isArray(values) || values.length > 20 || values.some((value) => typeof value !== "string" || !/^[A-Za-z0-9 _.\-/]{1,40}$/.test(value))) {
        return { valid: false, reason: `filter ${key} values` };
      }
    }
  }
  return { valid: true };
}

// ---------- Formatting helpers ----------

const num = (value: number, digits = 3): string => value.toLocaleString("en-US", { maximumFractionDigits: digits });

function fmtAmounts(amounts: CurrencyTotal[]): string {
  if (amounts.length === 0) return "—";
  return amounts.map((entry) => `${entry.currency} ${entry.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(", ");
}

function fmtQuantities(quantities: QuantityTotal[]): string {
  if (quantities.length === 0) return "0";
  return quantities.map((entry) => `${num(entry.quantity)} ${entry.unit}`).join(", ");
}

function amountIn(row: GroupRow, currency?: string): number {
  if (currency) return row.amounts.find((entry) => entry.currency === currency)?.amount ?? 0;
  return row.amounts[0]?.amount ?? 0;
}

function provenanceOf(bundle: AnalyticsBundle): ViewProvenance {
  return {
    source: "SAP_SALES_API",
    retrievedAt: bundle.provenance.retrievedAt,
    period: bundle.range.label,
    recordCount: bundle.records.length,
    calculation: "DISTINCT SalesOrder",
  };
}

function sourceFields(bundle: AnalyticsBundle): Pick<StructuredView, "source" | "updatedAt" | "provenance"> {
  return { source: "SAP Sales API", updatedAt: bundle.provenance.retrievedAt, provenance: provenanceOf(bundle) };
}

function periodNotes(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): string[] {
  const notes: string[] = [];
  if (plan.periodAssumed) notes.push(`No period was specified, so this shows ${bundle.range.label}.`);
  if (isInProgress(bundle.range, now)) notes.push(`${bundle.range.label} is still in progress (data up to ${businessToday(now).date}).`);
  if (!bundle.quality.ok) notes.push(...bundle.quality.notes);
  return notes;
}

function joinNotes(notes: string[]): string | undefined {
  return notes.length > 0 ? notes.join(" ") : undefined;
}

function kpiCards(bundle: AnalyticsBundle): Array<{ label: string; value: string }> {
  const kpis = computeKpis(bundle.records);
  return [
    { label: "Sales Orders", value: num(kpis.salesOrders, 0) },
    { label: "Order Items", value: num(kpis.salesOrderItems, 0) },
    { label: "Total Quantity", value: fmtQuantities(kpis.totalQuantity) },
    { label: "Sales Amount", value: fmtAmounts(kpis.totalAmount) },
    { label: "Avg Order Value", value: fmtAmounts(kpis.averageOrderValue) },
    { label: "Avg Qty / Order", value: `${num(kpis.averageQuantityPerOrder, 2)} ${kpis.primaryUnit}` },
    { label: "Avg Items / Order", value: num(kpis.averageItemsPerOrder, 2) },
  ];
}

const DIMENSION_LABEL: Record<GroupDimension, string> = {
  DATE: "Date",
  SALES_ORDER: "Sales Order",
  MATERIAL: "Material",
  PLANT: "Plant",
  CUSTOMER_GROUP: "Customer Group",
  CURRENCY: "Currency",
  DELIVERY_STATUS: "Delivery Status",
  BILLING_STATUS: "Billing Status",
};

const RANK_LABEL: Record<RankMetric, string> = { AMOUNT: "amount", QUANTITY: "quantity", ITEM_COUNT: "items", SALES_ORDERS: "sales orders" };

function rankValueLabel(row: GroupRow, field: RankMetric, currency?: string): string {
  switch (field) {
    case "AMOUNT":
      return fmtAmounts(row.amounts);
    case "QUANTITY":
      return fmtQuantities(row.quantities);
    case "ITEM_COUNT":
      return plural(row.items, "item");
    case "SALES_ORDERS":
      return plural(row.salesOrders, currency ? "order" : "order");
  }
}

function plural(count: number, noun: string): string {
  return `${num(count, 0)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Quantity in the dominant unit only, so charts never add EA and KG together. */
function unitQuantity(row: GroupRow, unit: string): number {
  return row.quantities.find((entry) => entry.unit === unit)?.quantity ?? 0;
}

function chartValue(row: GroupRow, field: RankMetric, currency?: string): number {
  switch (field) {
    case "AMOUNT":
      return amountIn(row, currency);
    case "QUANTITY":
      return row.quantity;
    case "ITEM_COUNT":
      return row.items;
    case "SALES_ORDERS":
      return row.salesOrders;
  }
}

function groupTable(rows: GroupRow[], dimension: GroupDimension, records: SalesItemRecord[]): { columns: string[]; rows: string[][] } {
  if (dimension === "SALES_ORDER") {
    const meta = new Map<string, { date: string; delivery: Set<string>; material: Set<string> }>();
    for (const record of records) {
      const entry = meta.get(record.SalesOrder) ?? { date: record.CreationDate ? record.CreationDate.toISOString().slice(0, 10) : "—", delivery: new Set(), material: new Set() };
      entry.delivery.add(statusLabel(record.DeliveryStatus));
      if (record.Material) entry.material.add(record.Material);
      meta.set(record.SalesOrder, entry);
    }
    return {
      columns: ["Sales Order", "Created", "Items", "Materials", "Quantity", "Amount", "Delivery Status"],
      rows: rows.map((row) => {
        const entry = meta.get(row.key);
        return [row.key, entry?.date ?? "—", num(row.items, 0), num(entry?.material.size ?? 0, 0), fmtQuantities(row.quantities), fmtAmounts(row.amounts), [...(entry?.delivery ?? [])].join(", ")];
      }),
    };
  }
  return {
    columns: [DIMENSION_LABEL[dimension], "Sales Orders", "Items", "Quantity", "Amount"],
    rows: rows.map((row) => [row.key, num(row.salesOrders, 0), num(row.items, 0), fmtQuantities(row.quantities), fmtAmounts(row.amounts)]),
  };
}

// ---------- Executor ----------

/** Executes a validated plan through the controlled tool registry and composes the structured response. */
export async function executePlan(plan: QueryPlan, now = new Date()): Promise<PlannerResult> {
  if (plan.salesOrder) {
    const order = await getSalesOrder(plan.salesOrder);
    if (!order) return { message: `${MSG_EMPTY} Sales order ${plan.salesOrder} was not found in the SAP Sales API.`, plan, tool: "getSalesOrder" };
    const view = orderView(order, plan.metric === "ITEM_COUNT" ? "count" : plan.wantPdf ? "pdf" : "details");
    const message =
      plan.metric === "ITEM_COUNT"
        ? `Sales order ${order.salesOrder} has ${order.itemCount} sales order item${order.itemCount === 1 ? "" : "s"} (total quantity ${fmtQuantities(order.quantities)}).`
        : orderText(order);
    return { message, view, plan, tool: "getSalesOrder", records: order.itemRecords };
  }

  switch (plan.output) {
    case "COMPARISON":
      return composeComparison(plan, now);
    case "DASHBOARD":
      return withBundle(plan, now, "getSalesSummary", composeDashboard);
    case "REPORT":
      return withBundle(plan, now, "getSalesSummary", composeReport);
    case "CHART":
      return withBundle(plan, now, "getSalesTrend", composeChart);
    case "TABLE":
      return composeTable(plan, now);
    case "KPI":
      return withBundle(plan, now, "getSalesSummary", composeKpi);
    case "SUMMARY":
    default:
      return withBundle(plan, now, "getSalesSummary", composeSummary);
  }
}

type Composer = (plan: QueryPlan, bundle: AnalyticsBundle, now: Date) => PlannerResult;

async function withBundle(plan: QueryPlan, now: Date, tool: SalesToolName, compose: Composer): Promise<PlannerResult> {
  const bundle =
    tool === "getSalesTrend"
      ? (await getSalesTrend(specOf(plan), plan.filters, now)).bundle
      : tool === "getSalesSummary"
        ? (await getSalesSummary(specOf(plan), plan.filters, now)).bundle
        : await getSalesData(specOf(plan), plan.filters, now);
  if (bundle.records.length === 0) return { message: emptyMessage(bundle), plan, tool };
  return { ...compose(plan, bundle, now), tool, records: bundle.records };
}

function emptyMessage(bundle: AnalyticsBundle): string {
  return `${MSG_EMPTY} (${bundle.range.label})`;
}

// ---------- Composers ----------

function composeSummary(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): PlannerResult {
  const kpis = computeKpis(bundle.records);
  const notes = periodNotes(plan, bundle, now);
  const message = [
    `**Sales Summary · ${bundle.range.label}**`,
    "",
    `- Sales Orders: ${num(kpis.salesOrders, 0)}`,
    `- Sales Order Items: ${num(kpis.salesOrderItems, 0)}`,
    `- Total Quantity: ${fmtQuantities(kpis.totalQuantity)}`,
    `- Sales Amount: ${fmtAmounts(kpis.totalAmount)}`,
    `- Average Order Value: ${fmtAmounts(kpis.averageOrderValue)}`,
    `- Average Items per Order: ${num(kpis.averageItemsPerOrder, 2)}`,
  ].join("\n");
  return {
    message,
    plan,
    view: { mode: plan.wantPdf ? "pdf" : "report", title: `Sales Summary · ${bundle.range.label}`, kpis: kpiCards(bundle), columns: [], rows: [], note: joinNotes(notes), ...sourceFields(bundle) },
  };
}

function composeKpi(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): PlannerResult {
  const kpis = computeKpis(bundle.records);
  const scope = plan.filters?.pendingOnly ? "pending " : "";
  let message: string;
  let cards: Array<{ label: string; value: string }>;
  switch (plan.metric) {
    case "COUNT":
      message = `${bundle.range.label}: **${num(kpis.salesOrders, 0)}** ${scope}sales orders (${num(kpis.salesOrderItems, 0)} sales order items).`;
      cards = [
        { label: `${scope ? "Pending " : ""}Sales Orders`, value: num(kpis.salesOrders, 0) },
        { label: "Order Items", value: num(kpis.salesOrderItems, 0) },
      ];
      break;
    case "ITEM_COUNT":
      message = `${bundle.range.label}: **${num(kpis.salesOrderItems, 0)}** ${scope}sales order items across ${num(kpis.salesOrders, 0)} sales orders.`;
      cards = [
        { label: "Order Items", value: num(kpis.salesOrderItems, 0) },
        { label: "Sales Orders", value: num(kpis.salesOrders, 0) },
      ];
      break;
    case "QUANTITY":
      message = `${bundle.range.label} total quantity: **${fmtQuantities(kpis.totalQuantity)}** across ${num(kpis.salesOrders, 0)} sales orders.`;
      cards = [
        { label: "Total Quantity", value: fmtQuantities(kpis.totalQuantity) },
        { label: "Avg Qty / Order", value: `${num(kpis.averageQuantityPerOrder, 2)} ${kpis.primaryUnit}` },
      ];
      break;
    case "NET_AMOUNT":
      message = `${bundle.range.label} sales amount: **${fmtAmounts(kpis.totalAmount)}** (currencies are reported separately).`;
      cards = kpis.totalAmount.map((entry) => ({ label: `Amount ${entry.currency}`, value: num(entry.amount, 2) }));
      break;
    case "AVG_ORDER_VALUE":
      message = `${bundle.range.label} average order value: **${fmtAmounts(kpis.averageOrderValue)}** (${num(kpis.salesOrders, 0)} sales orders).`;
      cards = kpis.averageOrderValue.map((entry) => ({ label: `Avg ${entry.currency}`, value: num(entry.amount, 2) }));
      break;
    default:
      return composeSummary(plan, bundle, now);
  }
  return {
    message,
    plan,
    view: { mode: "count", title: `${METRIC_TITLE[plan.metric]} · ${bundle.range.label}`, kpis: cards, columns: [], rows: [], note: joinNotes(periodNotes(plan, bundle, now)), ...sourceFields(bundle) },
  };
}

const METRIC_TITLE: Record<PlanMetric, string> = {
  COUNT: "Sales Orders",
  ITEM_COUNT: "Order Items",
  QUANTITY: "Total Quantity",
  NET_AMOUNT: "Sales Amount",
  AVG_ORDER_VALUE: "Average Order Value",
  SUMMARY: "Sales Summary",
};

async function composeTable(plan: QueryPlan, now: Date): Promise<PlannerResult> {
  const dimension = plan.groupBy[0] ?? "MATERIAL";
  const field = plan.sort?.field ?? "AMOUNT";
  const { bundle, rows, totalGroups, rankCurrency } = await getSalesGrouped(specOf(plan), { dimension, sort: plan.sort, limit: plan.limit }, plan.filters, now);
  const tool = plan.filters?.pendingOnly ? "getSalesData" : groupToolFor(dimension);
  if (bundle.records.length === 0) {
    const message = plan.filters?.pendingOnly ? `No pending sales orders were found for ${bundle.range.label}.` : emptyMessage(bundle);
    return { message, plan, tool };
  }
  const label = DIMENSION_LABEL[dimension];
  const table = groupTable(rows, dimension, bundle.records);
  const notes = periodNotes(plan, bundle, now);
  if (plan.customerRequested) notes.unshift(NO_CUSTOMER_NOTE);
  if (dimension === "CUSTOMER_GROUP") {
    const blank = blankShare(bundle.records, "CUSTOMER_GROUP");
    if (blank > 0) notes.push(`${Math.round(blank * 100)}% of items have no Customer Group in SAP ("Not assigned").`);
  }
  const multiCurrency = new Set(bundle.records.map((record) => record.TransactionCurrency)).size > 1;
  if (field === "AMOUNT" && multiCurrency && rankCurrency) notes.push(`Ranked by ${rankCurrency} amount; other currencies are shown separately and never added together.`);

  const ranked = plan.limit !== null;
  const byLabel = field === "AMOUNT" && multiCurrency && rankCurrency ? `${rankCurrency} amount` : RANK_LABEL[field];
  const pending = plan.filters?.pendingOnly;
  const heading = pending
    ? `Pending Sales Orders · ${bundle.range.label}`
    : ranked
      ? `${plan.sort?.direction === "ASC" ? "Bottom" : "Top"} ${plan.limit} ${dimension === "SALES_ORDER" ? "Sales Orders" : label === "Material" ? "Materials" : label + "s"} by ${byLabel} · ${bundle.range.label}`
      : `Sales by ${label} · ${bundle.range.label}`;
  const chartRows = rows.slice(0, 12);
  const chart: ChartSpec = {
    title: `${label} by ${RANK_LABEL[field]}${field === "AMOUNT" && rankCurrency ? ` (${rankCurrency})` : ""}`,
    kind: "bar",
    labels: chartRows.map((row) => row.key),
    series: [{ name: RANK_LABEL[field], values: chartRows.map((row) => chartValue(row, field, rankCurrency)) }],
  };
  const kpis = pending
    ? [
        { label: "Pending Sales Orders", value: num(totalGroups, 0) },
        { label: "Pending Items", value: num(bundle.records.filter((record) => record.DeliveryStatus === "A" || record.DeliveryStatus === "B").length, 0) },
      ]
    : [];
  const showOrders = field !== "SALES_ORDERS" && dimension !== "SALES_ORDER";
  const lines = rows.slice(0, 10).map((row, index) => `${index + 1}. **${row.key}** — ${rankValueLabel(row, field, rankCurrency)}${showOrders ? ` · ${plural(row.salesOrders, "order")}` : ""}`);
  const more = rows.length > 10 ? `\n\n…and ${rows.length - 10} more in the table.` : "";
  return {
    message: [`**${heading}**`, "", ...lines].join("\n") + more,
    plan,
    tool,
    records: bundle.records,
    view: {
      mode: plan.wantPdf ? "pdf" : "table",
      title: heading,
      kpis,
      columns: table.columns,
      rows: table.rows,
      charts: dimension === "SALES_ORDER" && rows.length > 25 ? [] : [chart],
      note: joinNotes(notes),
      ...sourceFields(bundle),
    },
  };
}

function composeChart(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): PlannerResult {
  const trend = groupSales(bundle.records, "DATE")
    .filter((row) => row.key !== "—")
    .sort((left, right) => left.key.localeCompare(right.key));
  const unit = computeKpis(bundle.records).primaryUnit;
  const columns = ["Date", "Sales Orders", "Items", "Quantity", "Amount"];
  const rows = trend.map((row) => [row.key, num(row.salesOrders, 0), num(row.items, 0), fmtQuantities(row.quantities), fmtAmounts(row.amounts)]);
  const labels = trend.map((row) => row.key.slice(5));
  const charts: ChartSpec[] = [
    { title: "Daily sales orders (distinct)", kind: "line", labels, series: [{ name: "Sales Orders", values: trend.map((row) => row.salesOrders) }] },
    { title: `Daily quantity (${unit})`, kind: "bar", labels, series: [{ name: `Quantity ${unit}`, values: trend.map((row) => unitQuantity(row, unit)), color: "#06b6d4" }] },
  ];
  const peak = [...trend].sort((left, right) => right.salesOrders - left.salesOrders)[0];
  const message = [
    `**Daily Sales Orders · ${bundle.range.label}**`,
    "",
    `${trend.length} days with sales. ${peak ? `Peak: ${peak.key} with ${peak.salesOrders} sales orders.` : ""}`,
    "",
    ...trend.slice(-10).map((row) => `- ${row.key}: ${plural(row.salesOrders, "order")}, ${plural(row.items, "item")}, ${fmtQuantities(row.quantities)}`),
  ].join("\n");
  return {
    message,
    plan,
    view: { mode: plan.wantPdf ? "pdf" : "chart", title: `Daily Sales Trend · ${bundle.range.label}`, kpis: kpiCards(bundle).slice(0, 4), columns, rows, charts, note: joinNotes(periodNotes(plan, bundle, now)), ...sourceFields(bundle) },
  };
}

function dimensionSection(bundle: AnalyticsBundle, dimension: GroupDimension, limit: number, title: string, field: RankMetric = "QUANTITY"): { section: ViewSection; rows: GroupRow[] } {
  const rows = rankGroups(groupSales(bundle.records, dimension), field, "DESC", limit, dominantCurrency(bundle.records));
  const table = groupTable(rows, dimension, bundle.records);
  return { section: { title, columns: table.columns, rows: table.rows }, rows };
}

function composeDashboard(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): PlannerResult {
  const trend = groupSales(bundle.records, "DATE").filter((row) => row.key !== "—").sort((left, right) => left.key.localeCompare(right.key));
  const materials = dimensionSection(bundle, "MATERIAL", 10, "Top 10 materials by quantity");
  const plants = dimensionSection(bundle, "PLANT", 10, "Sales by plant", "SALES_ORDERS");
  const statuses = dimensionSection(bundle, "DELIVERY_STATUS", 10, "Sales by delivery status", "SALES_ORDERS");
  const labels = trend.map((row) => row.key.slice(5));
  const unit = computeKpis(bundle.records).primaryUnit;
  const charts: ChartSpec[] = [
    { title: "Daily sales orders", kind: "line", labels, series: [{ name: "Orders", values: trend.map((row) => row.salesOrders) }] },
    { title: `Daily quantity (${unit})`, kind: "bar", labels, series: [{ name: `Quantity ${unit}`, values: trend.map((row) => unitQuantity(row, unit)), color: "#06b6d4" }] },
    { title: "Sales by material (qty)", kind: "bar", labels: materials.rows.slice(0, 8).map((row) => row.key), series: [{ name: "Quantity", values: materials.rows.slice(0, 8).map((row) => row.quantity), color: "#ec4899" }] },
    { title: "Sales by plant (orders)", kind: "bar", labels: plants.rows.map((row) => row.key), series: [{ name: "Orders", values: plants.rows.map((row) => row.salesOrders), color: "#f59e0b" }] },
    { title: "Sales by delivery status (orders)", kind: "bar", labels: statuses.rows.map((row) => row.key), series: [{ name: "Orders", values: statuses.rows.map((row) => row.salesOrders), color: "#22c55e" }] },
  ];
  const kpis = computeKpis(bundle.records);
  return {
    message: [
      `**Sales Dashboard · ${bundle.range.label}**`,
      "",
      `- Sales Orders: ${num(kpis.salesOrders, 0)}`,
      `- Order Items: ${num(kpis.salesOrderItems, 0)}`,
      `- Quantity: ${fmtQuantities(kpis.totalQuantity)}`,
      `- Amount: ${fmtAmounts(kpis.totalAmount)}`,
    ].join("\n"),
    plan,
    view: {
      mode: plan.wantPdf ? "pdf" : "dashboard",
      title: `Sales Dashboard · ${bundle.range.label}`,
      kpis: kpiCards(bundle),
      columns: materials.section.columns,
      rows: materials.section.rows,
      sections: [plants.section, statuses.section],
      charts,
      note: joinNotes(periodNotes(plan, bundle, now)),
      ...sourceFields(bundle),
    },
  };
}

async function composeComparison(plan: QueryPlan, now: Date): Promise<PlannerResult> {
  const { current, previous, comparison } = await getSalesComparison(specOf(plan), compareSpecOf(plan), plan.filters, now);
  const tool: SalesToolName = "getSalesComparison";
  if (current.records.length === 0 && previous.records.length === 0) {
    return { message: `${MSG_EMPTY} (${current.range.label} and ${previous.range.label})`, plan, tool };
  }
  const columns = ["Metric", current.range.label, previous.range.label, "Difference", "Change"];
  const rows = [
    ["Sales Orders", num(comparison.salesOrders.current, 0), num(comparison.salesOrders.previous, 0), num(comparison.salesOrders.difference, 0), comparison.salesOrders.percentText],
    ["Order Items", num(comparison.items.current, 0), num(comparison.items.previous, 0), num(comparison.items.difference, 0), comparison.items.percentText],
    ...comparison.quantityByUnit.map((entry) => [`Quantity ${entry.label}`, num(entry.current), num(entry.previous), num(entry.difference), entry.percentText]),
    ...comparison.amountByCurrency.map((entry) => [`Amount ${entry.label}`, num(entry.current, 2), num(entry.previous, 2), num(entry.difference, 2), entry.percentText]),
    ...comparison.averageOrderValue.map((entry) => [`Avg Order Value ${entry.label}`, num(entry.current, 2), num(entry.previous, 2), num(entry.difference, 2), entry.percentText]),
  ];
  const sections: ViewSection[] = [];
  const bullets: string[] = [];
  const dimension = plan.groupBy[0];
  if (dimension) {
    const field = plan.sort?.field ?? "AMOUNT";
    const currency = dominantCurrency(current.records);
    const currentRows = rankGroups(groupSales(current.records, dimension), field, "DESC", plan.limit ?? 10, currency);
    const previousMap = new Map(groupSales(previous.records, dimension).map((row) => [row.key, row]));
    sections.push({
      title: `${DIMENSION_LABEL[dimension]} · ${current.range.label} vs ${previous.range.label} (by ${field === "AMOUNT" && currency ? `${currency} ` : ""}${RANK_LABEL[field]})`,
      columns: [DIMENSION_LABEL[dimension], current.range.label, previous.range.label, "Change"],
      rows: currentRows.map((row) => {
        const before = previousMap.get(row.key);
        const nowValue = chartValue(row, field, currency);
        const beforeValue = before ? chartValue(before, field, currency) : 0;
        const change = beforeValue === 0 ? "n/a (previous period had zero value)" : `${nowValue >= beforeValue ? "+" : ""}${(((nowValue - beforeValue) / beforeValue) * 100).toFixed(1)}%`;
        return [row.key, num(nowValue, 2), num(beforeValue, 2), change];
      }),
    });
  }
  if (plan.explainWhy) {
    const currentMaterials = new Map(groupSales(current.records, "MATERIAL").map((row) => [row.key, row]));
    const drops = groupSales(previous.records, "MATERIAL")
      .map((row) => ({ key: row.key, delta: (currentMaterials.get(row.key)?.salesOrders ?? 0) - row.salesOrders, before: row.salesOrders }))
      .filter((entry) => entry.delta < 0)
      .sort((left, right) => left.delta - right.delta)
      .slice(0, 5);
    bullets.push(WHY_NOTE);
    bullets.push(`Sales orders: ${comparison.salesOrders.current} vs ${comparison.salesOrders.previous} (${comparison.salesOrders.percentText}).`);
    if (drops.length > 0) {
      bullets.push(`Materials with the largest drop in sales orders: ${drops.map((entry) => `${entry.key} (${entry.delta})`).join(", ")}.`);
    } else {
      bullets.push("No material shows fewer sales orders than in the previous period.");
    }
  }
  if (isInProgress(current.range, now)) {
    bullets.push(`${current.range.label} is still in progress, so it is being compared with a complete previous period.`);
  }
  const charts: ChartSpec[] = [
    {
      title: "Sales orders & items: current vs previous",
      kind: "bar",
      labels: ["Sales Orders", "Items"],
      series: [
        { name: current.range.label, values: [comparison.salesOrders.current, comparison.items.current] },
        { name: previous.range.label, values: [comparison.salesOrders.previous, comparison.items.previous], color: "#94a3b8" },
      ],
    },
  ];
  const fmtChange = (text: string) => (text.startsWith("Percentage") ? text : `**${text}**`);
  const message = [
    `**${plan.explainWhy ? "Sales change analysis" : "Comparison"} · ${current.range.label} vs ${previous.range.label}**`,
    "",
    `- Sales Orders: ${num(comparison.salesOrders.current, 0)} vs ${num(comparison.salesOrders.previous, 0)} (${fmtChange(comparison.salesOrders.percentText)})`,
    `- Items: ${num(comparison.items.current, 0)} vs ${num(comparison.items.previous, 0)} (${fmtChange(comparison.items.percentText)})`,
    ...comparison.quantityByUnit.map((entry) => `- Quantity ${entry.label}: ${num(entry.current)} vs ${num(entry.previous)} (${fmtChange(entry.percentText)})`),
    ...comparison.amountByCurrency.map((entry) => `- Amount ${entry.label}: ${num(entry.current, 2)} vs ${num(entry.previous, 2)} (${fmtChange(entry.percentText)})`),
    ...(plan.explainWhy ? ["", WHY_NOTE] : []),
  ].join("\n");
  const notes = [...periodNotes(plan, current, now).filter((note) => !note.includes("still in progress")), ...previous.quality.notes];
  if (plan.customerRequested) notes.unshift(NO_CUSTOMER_NOTE);
  return {
    message,
    plan,
    tool,
    records: current.records,
    view: {
      mode: plan.wantPdf ? "pdf" : "comparison",
      title: `${current.range.label} vs ${previous.range.label}`,
      kpis: [
        { label: "Sales Orders", value: `${num(comparison.salesOrders.current, 0)} vs ${num(comparison.salesOrders.previous, 0)}` },
        { label: "Change", value: comparison.salesOrders.percent === null ? "n/a" : comparison.salesOrders.percentText },
      ],
      columns,
      rows,
      sections,
      bullets,
      charts,
      note: joinNotes(notes),
      ...sourceFields(current),
    },
  };
}

function composeReport(plan: QueryPlan, bundle: AnalyticsBundle, now: Date): PlannerResult {
  const kpis = computeKpis(bundle.records);
  const trend = groupSales(bundle.records, "DATE").filter((row) => row.key !== "—").sort((left, right) => left.key.localeCompare(right.key));
  const currency = dominantCurrency(bundle.records);
  const materials = dimensionSection(bundle, "MATERIAL", 10, "Material analysis — top 10 by quantity");
  const byAmount = rankGroups(groupSales(bundle.records, "MATERIAL"), "AMOUNT", "DESC", 1, currency);
  const plants = dimensionSection(bundle, "PLANT", 10, "Plant analysis", "SALES_ORDERS");
  const delivery = dimensionSection(bundle, "DELIVERY_STATUS", 10, "Delivery status analysis", "SALES_ORDERS");
  const billing = dimensionSection(bundle, "BILLING_STATUS", 10, "Billing status analysis", "SALES_ORDERS");
  const orders = dimensionSection(bundle, "SALES_ORDER", 50, "Detailed sales orders — top 50 by item count", "ITEM_COUNT");
  const peak = [...trend].sort((left, right) => right.salesOrders - left.salesOrders)[0];
  const low = [...trend].sort((left, right) => left.salesOrders - right.salesOrders)[0];
  const pendingOrders = new Set(bundle.records.filter((record) => record.DeliveryStatus === "A" || record.DeliveryStatus === "B").map((record) => record.SalesOrder)).size;
  const insufficient = "Insufficient data to determine this.";

  const executive = [
    `${num(kpis.salesOrders, 0)} sales orders with ${num(kpis.salesOrderItems, 0)} items were created in ${bundle.range.label}.`,
    `Total quantity ${fmtQuantities(kpis.totalQuantity)}; sales amount ${fmtAmounts(kpis.totalAmount)}.`,
    `Average order value ${fmtAmounts(kpis.averageOrderValue)}; ${num(kpis.averageItemsPerOrder, 2)} items and ${num(kpis.averageQuantityPerOrder, 2)} ${kpis.primaryUnit} per order.`,
  ];
  const observations = [
    peak ? `Peak day: ${peak.key} with ${peak.salesOrders} sales orders.` : `Peak day: ${insufficient}`,
    low && trend.length > 1 ? `Lowest day with sales: ${low.key} with ${low.salesOrders} sales orders.` : `Lowest day: ${insufficient}`,
    materials.rows[0] ? `Top material by quantity: ${materials.rows[0].key} (${fmtQuantities(materials.rows[0].quantities)}).` : `Top material by quantity: ${insufficient}`,
    byAmount[0] && currency && amountIn(byAmount[0], currency) > 0
      ? `Top material by ${currency} amount: ${byAmount[0].key} (${currency} ${num(amountIn(byAmount[0], currency), 2)}).`
      : `Top material by amount: ${insufficient}`,
    plants.rows[0] ? `Largest plant by sales orders: ${plants.rows[0].key} (${plural(plants.rows[0].salesOrders, "order")}).` : `Largest plant: ${insufficient}`,
    `${num(pendingOrders, 0)} of ${num(kpis.salesOrders, 0)} sales orders still have items not fully delivered (status A/B).`,
    `Customer-level analysis: ${insufficient} The SAP Sales API has no customer field.`,
  ];
  const notes = periodNotes(plan, bundle, now);
  const trendSection: ViewSection = {
    title: "Daily trend",
    columns: ["Date", "Sales Orders", "Items", "Quantity", "Amount"],
    rows: trend.map((row) => [row.key, num(row.salesOrders, 0), num(row.items, 0), fmtQuantities(row.quantities), fmtAmounts(row.amounts)]),
  };
  const labels = trend.map((row) => row.key.slice(5));
  const charts: ChartSpec[] = [
    { title: "Daily sales orders", kind: "line", labels, series: [{ name: "Orders", values: trend.map((row) => row.salesOrders) }] },
    { title: "Top materials by quantity", kind: "bar", labels: materials.rows.slice(0, 8).map((row) => row.key), series: [{ name: "Quantity", values: materials.rows.slice(0, 8).map((row) => row.quantity), color: "#ec4899" }] },
  ];
  const message = [
    `**Sales Report · ${bundle.range.label}**`,
    "",
    "**Executive summary**",
    ...executive.map((line) => `- ${line}`),
    "",
    "**Observations**",
    ...observations.map((line) => `- ${line}`),
  ].join("\n");
  return {
    message,
    plan,
    view: {
      mode: plan.wantPdf ? "pdf" : "report",
      title: `Sales Report · ${bundle.range.label}`,
      kpis: kpiCards(bundle),
      columns: [],
      rows: [],
      bullets: [...executive, ...observations],
      sections: [trendSection, materials.section, plants.section, delivery.section, billing.section, orders.section],
      charts,
      note: joinNotes(notes),
      ...sourceFields(bundle),
    },
  };
}

function orderText(order: UniqueSalesOrder): string {
  return [
    `**Sales Order ${order.salesOrder}**`,
    "",
    `- Created: ${order.creationDate ?? "—"} ${order.creationTime}`.trim(),
    `- Items: ${order.itemCount}`,
    `- Quantity: ${fmtQuantities(order.quantities)}`,
    `- Amount: ${fmtAmounts(order.amounts)}`,
    `- Delivery Status: ${order.deliveryStatuses.map(statusLabel).join(", ") || "—"}`,
    `- Billing Status: ${order.billingStatuses.map(statusLabel).join(", ") || "—"}`,
  ].join("\n");
}

function orderView(order: UniqueSalesOrder, mode: "count" | "details" | "pdf"): StructuredView {
  const columns = ["Item", "Material", "Plant", "Quantity", "Amount", "Currency", "Delivery", "Billing"];
  const rows = order.itemRecords.map((item) => [
    item.SalesOrderItem || "—",
    item.Material || "—",
    item.Plant || "—",
    `${num(item.OrderQuantity)} ${item.OrderQuantityUnit}`,
    num(item.NetAmount, 2),
    item.TransactionCurrency || "—",
    statusLabel(item.DeliveryStatus),
    statusLabel(item.BillingStatus),
  ]);
  const retrievedAt = new Date().toISOString();
  return {
    mode,
    title: `Sales Order ${order.salesOrder}`,
    kpis: [
      { label: "Items", value: num(order.itemCount, 0) },
      { label: "Quantity", value: fmtQuantities(order.quantities) },
      { label: "Amount", value: fmtAmounts(order.amounts) },
      { label: "Created", value: `${order.creationDate ?? "—"}` },
      { label: "Delivery", value: order.deliveryStatuses.map(statusLabel).join(", ") || "—" },
    ],
    columns,
    rows,
    source: "SAP Sales API",
    updatedAt: retrievedAt,
    provenance: { source: "SAP_SALES_API", retrievedAt, period: `Sales order ${order.salesOrder}`, recordCount: order.itemRecords.length, calculation: "DISTINCT SalesOrder" },
  };
}

/** Log helper for plan lifecycle events. */
export function logPlan(event: "QUERY_PLAN_CREATED" | "QUERY_PLAN_VALIDATED" | "QUERY_PLAN_REJECTED", plan: QueryPlan, extra: Record<string, unknown> = {}): void {
  let range: { startDate: string; endDateExclusive: string } | null = null;
  try {
    range = plan.salesOrder ? null : rangeForSpec(specOf(plan));
  } catch {
    range = null;
  }
  obs(event, { intent: plan.intent, output: plan.output, period: plan.period, range: range ? `${range.startDate}..${range.endDateExclusive}` : undefined, plan, ...extra });
}
