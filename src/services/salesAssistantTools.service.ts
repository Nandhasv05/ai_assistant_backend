/*
 * Read-only Sales tools for the Evolv Sales Assistant (prompt v3.0).
 * Business rules live here so every answer (LLM or rule fallback) gets the same numbers:
 * TAG rows never count, FOC is reported separately, amounts are never added across currencies,
 * cost/margin only for roles that may see it, and only the user's allowed plants are visible.
 */
import { allowedPlantsText, canSeeCost, currentSalesAccess, plantAllowed } from "./salesAccess.service";
import { businessTimeZone, businessToday, fetchSalesItems, getSalesOrderRecords, sapStatus, shiftDate, type SalesItemRecord } from "./sapSales.service";

export type GroupBy =
  | "none"
  | "currency"
  | "plant"
  | "material"
  | "material_group"
  | "item_category"
  | "route"
  | "shipping_point"
  | "division"
  | "sales_district"
  | "customer_group"
  | "date"
  | "month"
  | "hour";
export type DateBasis = "created" | "billing_date";
export type StatusType =
  | "delivery_pending"
  | "delivery_partial"
  | "delivery_complete"
  | "delivery_blocked"
  | "billing_blocked"
  | "blocked"
  | "billing_pending"
  | "incomplete"
  | "pricing_incomplete"
  | "zero_value";
export type Metric = "quantity" | "net_amount" | "cost_amount" | "order_count";
export type CompareMetric = "quantity" | "net_amount" | "tax_amount" | "cost_amount" | "order_count" | "item_count";
export type Dimension = "material" | "material_group" | "plant" | "route" | "division" | "sales_district" | "customer_group" | "order";

export interface SalesFilters {
  plant?: string | string[];
  material?: string;
  material_group?: string;
  currency?: string;
  route?: string;
  shipping_point?: string;
  item_category?: string;
  division?: string;
  sales_district?: string;
  customer_group?: string;
  /** true = return items only, false = exclude return items. */
  returns?: boolean;
  include_foc?: boolean;
}

/** Longest range a question may cover (6 months); SAP is still queried one calendar month at a time. */
export const MAX_RANGE_DAYS = 186;
const SEARCH_DAYS = 31;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly code: "range_too_large" | "plant_access" | "cost_access" | "invalid" = "invalid",
  ) {
    super(message);
  }
}

export function displayDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${String(day).padStart(2, "0")}-${MONTHS[month - 1]}-${year}`;
}

/** "2026-07" → "Jul-2026". */
function displayMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return year && month ? `${MONTHS[month - 1]}-${year}` : yearMonth;
}

let zoneFormat: { zone: string; format: Intl.DateTimeFormat; days: Map<number, string> } | null = null;

function isoInZone(date: Date | null | undefined): string {
  if (!date) return "";
  const zone = businessTimeZone();
  if (zoneFormat?.zone !== zone) {
    zoneFormat = { zone, format: new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }), days: new Map() };
  }
  const time = date.getTime();
  let value = zoneFormat.days.get(time);
  if (value === undefined) {
    value = zoneFormat.format.format(date);
    if (zoneFormat.days.size > 50_000) zoneFormat.days.clear();
    zoneFormat.days.set(time, value);
  }
  return value;
}

/** "28-Sep-2026 11:05" in the business time zone. */
export function displayDateTime(value: string | Date | null | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: businessTimeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${displayDate(isoInZone(date))} ${time}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function rangeTooLarge(): ToolInputError {
  return new ToolInputError("Date range is more than 6 months. Please narrow it down (for example last 3 months or this month).", "range_too_large");
}

export function normalizeRange(dateFrom?: string, dateTo?: string, now = new Date()): { from: string; to: string; defaulted: boolean } {
  const today = businessToday(now).date;
  const valid = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
  const from = valid(dateFrom);
  const to = valid(dateTo);
  if (!from && !to) return { from: today, to: today, defaulted: true };
  const start = from ?? to!;
  const end = to ?? from!;
  const [a, b] = start <= end ? [start, end] : [end, start];
  if (daysBetween(a, b) + 1 > MAX_RANGE_DAYS) throw rangeTooLarge();
  return { from: a, to: b, defaulted: false };
}

interface RangeFetch {
  records: SalesItemRecord[];
  retrievedAt: string;
  partial: boolean;
}

async function loadRange(from: string, to: string, basis: DateBasis = "created"): Promise<RangeFetch> {
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw rangeTooLarge();
  const field = basis === "billing_date" ? "BillingDocumentDate" : "CreationDate";
  const chunks: Array<[string, string]> = daysBetween(from, to) + 1 > SEARCH_DAYS ? halfMonthChunks(from, to) : [[from, to]];
  const currentMonth = businessToday().date.slice(0, 7);
  const results = await mapLimit(chunks, SAP_PARALLEL, ([start, end]) =>
    fetchSalesItems(
      `${field} ge datetime'${start}T00:00:00' and ${field} lt datetime'${shiftDate(end, 1)}T00:00:00'`,
      end.slice(0, 7) < currentMonth ? CLOSED_MONTH_TTL_MS : undefined,
    ),
  );
  return {
    records: results.flatMap((result) => result.records),
    retrievedAt: results.map((result) => result.retrievedAt).sort()[0],
    partial: results.some((result) => result.stats.truncated),
  };
}

const SAP_PARALLEL = 6;
const CLOSED_MONTH_TTL_MS = 10 * 60 * 1000;

/** 1st–15th and 16th–month end pieces: SAP pages each query sequentially, so smaller parallel queries finish sooner. */
function halfMonthChunks(from: string, to: string): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let start = from;
  while (start <= to) {
    const [year, month, day] = start.split("-").map(Number);
    const pieceEnd = day <= 15 ? `${start.slice(0, 8)}15` : shiftDate(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), -1);
    const end = pieceEnd < to ? pieceEnd : to;
    chunks.push([start, end]);
    start = shiftDate(end, 1);
  }
  return chunks;
}

async function mapLimit<T, R>(list: T[], limit: number, run: (entry: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await run(list[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

/** Filtered raw items for a range (TAG rows included; callers decide how to treat them). */
export async function loadItems(from: string, to: string, filters?: SalesFilters): Promise<SalesItemRecord[]> {
  return applyFilters((await loadRange(from, to)).records, filters);
}

export async function loadOrderItems(salesOrder: string): Promise<SalesItemRecord[]> {
  return [...(await getSalesOrderRecords(salesOrder))].sort((a, b) => a.SalesOrderItem.localeCompare(b.SalesOrderItem));
}

export { blockWord, incompleteFields, isoInZone, isRegular, matchesStatus, STATUS_LABEL };

export function isTag(item: SalesItemRecord): boolean {
  return item.ItemCategory === "TAG" || item.ItemType === "B";
}

export function isFoc(item: SalesItemRecord): boolean {
  return item.ItemCategory === "ZFOC";
}

function isRegular(item: SalesItemRecord): boolean {
  return !isTag(item) && !isFoc(item);
}

function asList(value?: string | string[]): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(/[,\s]+/)).map((entry) => entry.trim().toUpperCase()).filter(Boolean);
}

/** Throws when the user asks for a plant outside their access (never reveals that plant's data). */
export function assertPlantAccess(filters: SalesFilters = {}): void {
  const denied = asList(filters.plant).filter((plant) => !plantAllowed(plant));
  if (denied.length) throw new ToolInputError(`No access to plant ${denied.join(", ")}. Allowed: ${allowedPlantsText()}.`, "plant_access");
}

function compact(text: string): string {
  return text.toUpperCase().replace(/[\s_-]+/g, "");
}

function applyFilters(items: SalesItemRecord[], filters: SalesFilters = {}): SalesItemRecord[] {
  assertPlantAccess(filters);
  const plants = asList(filters.plant);
  const material = filters.material ? compact(filters.material) : "";
  const group = filters.material_group?.trim().toUpperCase();
  const currency = filters.currency?.trim().toUpperCase();
  const route = filters.route?.trim().toUpperCase();
  const shipping = filters.shipping_point?.trim().toUpperCase();
  const category = filters.item_category?.trim().toUpperCase();
  const division = filters.division?.trim().toUpperCase();
  const district = filters.sales_district?.trim().toUpperCase();
  const customerGroup = filters.customer_group?.trim().toUpperCase();
  return items.filter((item) => {
    if (plants.length && !plants.includes(item.Plant.toUpperCase())) return false;
    if (material && !compact(item.Material).includes(material)) return false;
    if (group && (item.MaterialGroup ?? "").toUpperCase() !== group) return false;
    if (currency && item.TransactionCurrency.toUpperCase() !== currency) return false;
    if (route && (item.Route ?? "").toUpperCase() !== route) return false;
    if (shipping && (item.ShippingPoint ?? "").toUpperCase() !== shipping) return false;
    if (category && (item.ItemCategory ?? "").toUpperCase() !== category) return false;
    if (division && (item.Division ?? "").toUpperCase() !== division) return false;
    if (district && (item.SalesDistrict ?? "").toUpperCase() !== district) return false;
    if (customerGroup && (item.CustomerGroup ?? "").toUpperCase() !== customerGroup) return false;
    if (filters.returns !== undefined && Boolean(item.IsReturnsItem) !== filters.returns) return false;
    return true;
  });
}

export function orderNumber(raw: string): string {
  return raw.replace(/^0+/, "") || raw;
}

// Status words ------------------------------------------------------------

export function processWord(code?: string): string {
  if (code === "A") return "Not started";
  if (code === "B") return "Partially processed";
  if (code === "C") return "Completed";
  return "Not relevant";
}

export function deliveryWord(code?: string): string {
  if (code === "A") return "Open";
  if (code === "B") return "Partially delivered";
  if (code === "C") return "Delivered";
  return "Not relevant";
}

function blockWord(item: SalesItemRecord): string {
  const delivery = item.DeliveryBlockStatus === "C";
  const billing = item.BillingBlockStatus === "C";
  if (delivery && billing) return "Delivery + Billing";
  if (delivery) return "Delivery";
  if (billing) return "Billing";
  return "No block";
}

function incompleteFields(item: SalesItemRecord): string[] {
  const fields: Array<[string | undefined, string]> = [
    [item.GeneralIncompletionStatus, "General"],
    [item.BillingIncompletionStatus, "Billing"],
    [item.PricingIncompletionStatus, "Pricing"],
    [item.DeliveryIncompletionStatus, "Delivery"],
  ];
  return fields.filter(([code]) => code === "A" || code === "B").map(([, name]) => name);
}

function billingRelevanceWord(code?: string): string {
  if (code === "A") return "Billing relevant";
  if (code === "D") return "Delivery-related billing";
  return "Not relevant";
}

function categoryWord(item: SalesItemRecord): string {
  if (isTag(item)) return "Header (TAG)";
  if (isFoc(item)) return "Free of charge (ZFOC)";
  return `Sales item (${item.ItemCategory || "—"})`;
}

// Result envelope ---------------------------------------------------------

interface Envelope {
  filters_applied: Record<string, unknown>;
  row_count: number;
  is_partial: boolean;
  data_as_of: string;
  warnings: string[];
}

function envelope(fields: { filters: Record<string, unknown>; rows: number; partial?: boolean; retrievedAt?: string | null; warnings?: string[] }): Envelope {
  const access = currentSalesAccess();
  const warnings = [...(fields.warnings ?? [])];
  if (fields.partial) warnings.push("SAP returned more pages than the read limit; totals may be incomplete.");
  return {
    filters_applied: {
      ...Object.fromEntries(Object.entries(fields.filters).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && !value.length))),
      allowed_plants: allowedPlantsText(access),
    },
    row_count: fields.rows,
    is_partial: Boolean(fields.partial),
    data_as_of: displayDateTime(fields.retrievedAt ?? sapStatus().lastOkAt),
    warnings,
  };
}

// Aggregation -------------------------------------------------------------

interface Bucket {
  orders: Set<string>;
  items: number;
  quantity: number;
  net: number;
  tax: number;
  cost: number;
}

function bucket(): Bucket {
  return { orders: new Set(), items: 0, quantity: 0, net: 0, tax: 0, cost: 0 };
}

function add(target: Bucket, item: SalesItemRecord): void {
  target.orders.add(item.SalesOrder);
  target.items += 1;
  target.quantity += item.OrderQuantity;
  target.net += item.NetAmount;
  target.tax += item.TaxAmount ?? 0;
  target.cost += item.CostAmount ?? 0;
}

function currencyRows(items: SalesItemRecord[]) {
  const map = new Map<string, Bucket>();
  for (const item of items) {
    const key = item.TransactionCurrency || "UNKNOWN";
    if (!map.has(key)) map.set(key, bucket());
    add(map.get(key)!, item);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, b]) => ({
      currency,
      orders: b.orders.size,
      items: b.items,
      quantity: b.quantity,
      net_amount: round2(b.net),
      tax_amount: round2(b.tax),
      cost_amount: round2(b.cost),
      margin: round2(b.net - b.cost),
    }));
}

function focRows(items: SalesItemRecord[]) {
  return currencyRows(items.filter(isFoc)).map(({ currency, items: count, quantity, net_amount, tax_amount, cost_amount }) => ({
    currency,
    items: count,
    quantity,
    foc_value: net_amount,
    foc_tax: tax_amount,
    cost_amount,
  }));
}

/** Orders that have FOC items but no regular item (counted separately from orders). */
function focOnlyOrders(items: SalesItemRecord[]): Map<string, string> {
  const regular = new Set(items.filter(isRegular).map((item) => item.SalesOrder));
  const result = new Map<string, string>();
  for (const item of items) {
    if (isFoc(item) && !regular.has(item.SalesOrder)) result.set(item.SalesOrder, item.TransactionCurrency);
  }
  return result;
}

export function dataNotes(items: SalesItemRecord[]): string[] {
  const notes: string[] = [];
  const orderList = (list: SalesItemRecord[]) => {
    const orders = [...new Set(list.map((item) => orderNumber(item.SalesOrder)))];
    return `${orders.slice(0, 5).join(", ")}${orders.length > 5 ? ", …" : ""}`;
  };
  const zero = items.filter((item) => isRegular(item) && item.NetAmount === 0 && item.OrderQuantity > 0);
  if (zero.length) notes.push(`${zero.length} regular item(s) have net amount 0 (orders ${orderList(zero)}).`);
  const currencies = new Map<string, Set<string>>();
  for (const item of items) {
    if (isTag(item)) continue;
    if (!currencies.has(item.SalesOrder)) currencies.set(item.SalesOrder, new Set());
    currencies.get(item.SalesOrder)!.add(item.TransactionCurrency);
  }
  const mixed = [...currencies.entries()].filter(([, set]) => set.size > 1).map(([order]) => orderNumber(order));
  if (mixed.length) notes.push(`Order(s) ${mixed.slice(0, 5).join(", ")} show more than one currency.`);
  const earlyBilling = items.filter((item) => !isTag(item) && item.BillingDocumentDate && item.CreationDate && isoInZone(item.BillingDocumentDate) < isoInZone(item.CreationDate));
  if (earlyBilling.length) notes.push(`${earlyBilling.length} item(s) have a billing date earlier than the creation date (orders ${orderList(earlyBilling)}).`);
  const deliveredBlocked = items.filter((item) => !isTag(item) && item.DeliveryStatus === "C" && (item.DeliveryBlockStatus === "C" || item.BillingBlockStatus === "C"));
  if (deliveredBlocked.length) notes.push(`${deliveredBlocked.length} item(s) show Delivered but still carry a block.`);
  if (canSeeCost()) {
    const costly = items.filter((item) => isRegular(item) && item.NetAmount > 0 && (item.CostAmount ?? 0) > item.NetAmount * 3);
    if (costly.length) notes.push(`${costly.length} item(s) have cost far higher than net value.`);
  }
  const incomplete = items.filter((item) => !isTag(item) && incompleteFields(item).length > 0);
  if (incomplete.length) notes.push(`${incomplete.length} item(s) are incomplete (${[...new Set(incomplete.flatMap(incompleteFields))].join(", ")}).`);
  const returns = items.filter((item) => isRegular(item) && item.IsReturnsItem);
  if (returns.length) notes.push(`${returns.length} return item(s) are included in the totals (orders ${orderList(returns)}).`);
  return notes;
}

function groupKey(item: SalesItemRecord, groupBy: GroupBy, basis: DateBasis): string {
  switch (groupBy) {
    case "plant":
      return item.Plant || "—";
    case "material":
      return item.Material || "—";
    case "material_group":
      return item.MaterialGroup || "—";
    case "item_category":
      return item.ItemCategory || "—";
    case "route":
      return item.Route || "No route";
    case "shipping_point":
      return item.ShippingPoint || "—";
    case "division":
      return item.Division || "Not assigned";
    case "sales_district":
      return item.SalesDistrict || "Not assigned";
    case "customer_group":
      return item.CustomerGroup || "Not assigned";
    case "date":
      return isoInZone(basis === "billing_date" ? item.BillingDocumentDate : item.CreationDate);
    case "month":
      return isoInZone(basis === "billing_date" ? item.BillingDocumentDate : item.CreationDate).slice(0, 7);
    case "hour":
      return `${(item.CreationTime || "00").slice(0, 2)}:00`;
    default:
      return item.TransactionCurrency;
  }
}

function latestOrder(items: SalesItemRecord[]) {
  const sorted = items
    .filter((item) => item.CreationDate)
    .sort((a, b) => `${isoInZone(b.CreationDate)} ${b.CreationTime}`.localeCompare(`${isoInZone(a.CreationDate)} ${a.CreationTime}`));
  const latest = sorted[0];
  if (!latest) return null;
  return { sales_order: orderNumber(latest.SalesOrder), created_on: displayDate(isoInZone(latest.CreationDate)), time: (latest.CreationTime || "").slice(0, 5) };
}

// Tool 1: get_sales_summary ----------------------------------------------

export async function getSalesSummary(
  args: { date_from?: string; date_to?: string; date_basis?: DateBasis; group_by?: GroupBy; filters?: SalesFilters },
  now = new Date(),
) {
  const range = normalizeRange(args.date_from, args.date_to, now);
  const basis: DateBasis = args.date_basis === "billing_date" ? "billing_date" : "created";
  const fetched = await loadRange(range.from, range.to, basis);
  const all = applyFilters(fetched.records, args.filters);
  const tagRows = all.filter(isTag).length;
  const foc = all.filter(isFoc);
  const regular = all.filter(isRegular);
  const returns = regular.filter((item) => item.IsReturnsItem);
  const groupBy: GroupBy = args.group_by ?? "none";
  const focOnly = focOnlyOrders(all);

  let groups: Array<Record<string, unknown>> | undefined;
  let groupCount = 0;
  if (groupBy !== "none" && groupBy !== "currency") {
    const map = new Map<string, { key: string; currency: string; b: Bucket }>();
    for (const item of regular) {
      const key = groupKey(item, groupBy, basis);
      const id = `${key}|${item.TransactionCurrency}`;
      if (!map.has(id)) map.set(id, { key, currency: item.TransactionCurrency, b: bucket() });
      add(map.get(id)!.b, item);
    }
    const sorted = [...map.values()].sort((a, b) =>
      groupBy === "date" || groupBy === "month" || groupBy === "hour" ? a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency) : b.b.quantity - a.b.quantity,
    );
    groupCount = sorted.length;
    groups = sorted.slice(0, 50).map(({ key, currency, b }) => ({
      [groupBy]: groupBy === "date" ? displayDate(key) : groupBy === "month" ? displayMonth(key) : key,
      currency,
      orders: b.orders.size,
      items: b.items,
      quantity: b.quantity,
      net_amount: round2(b.net),
      tax_amount: round2(b.tax),
      cost_amount: round2(b.cost),
    }));
  }

  const perCurrency = currencyRows(regular).map((row) => ({
    currency: row.currency,
    order_count: row.orders,
    foc_only_order_count: [...focOnly.values()].filter((currency) => currency === row.currency).length,
    item_count: row.items,
    total_quantity: row.quantity,
    net_amount: row.net_amount,
    tax_amount: row.tax_amount,
    cost_amount: row.cost_amount,
    margin: row.margin,
  }));
  for (const currency of new Set(focOnly.values())) {
    if (!perCurrency.some((row) => row.currency === currency)) {
      perCurrency.push({
        currency,
        order_count: 0,
        foc_only_order_count: [...focOnly.values()].filter((value) => value === currency).length,
        item_count: 0,
        total_quantity: 0,
        net_amount: 0,
        tax_amount: 0,
        cost_amount: 0,
        margin: 0,
      });
    }
  }

  return {
    period: { from: displayDate(range.from), to: displayDate(range.to), defaulted_to_today: range.defaulted },
    date_basis: basis,
    order_count: new Set(regular.map((item) => item.SalesOrder)).size,
    foc_only_order_count: focOnly.size,
    item_count: regular.length,
    total_quantity: regular.reduce((sum, item) => sum + item.OrderQuantity, 0),
    confirmed_quantity: regular.reduce((sum, item) => sum + (item.ConfirmedOrderQuantity ?? 0), 0),
    returns: {
      items: returns.length,
      orders: new Set(returns.map((item) => item.SalesOrder)).size,
      quantity: returns.reduce((sum, item) => sum + item.OrderQuantity, 0),
      by_currency: currencyRows(returns).map(({ currency, items: count, quantity, net_amount }) => ({ currency, items: count, quantity, net_amount })),
    },
    by_currency: perCurrency.sort((a, b) => a.currency.localeCompare(b.currency)),
    foc: {
      items: foc.length,
      orders: new Set(foc.map((item) => item.SalesOrder)).size,
      quantity: foc.reduce((sum, item) => sum + item.OrderQuantity, 0),
      by_currency: focRows(foc),
    },
    latest_order: latestOrder(regular),
    tag_rows_excluded: tagRows,
    ...(groups ? { group_by: groupBy, groups, group_count: groupCount, groups_shown: groups.length } : {}),
    data_notes: dataNotes(all),
    ...envelope({
      filters: { date_from: displayDate(range.from), date_to: displayDate(range.to), date_basis: basis, group_by: groupBy, ...args.filters },
      rows: all.length,
      partial: fetched.partial,
      retrievedAt: fetched.retrievedAt,
    }),
  };
}

// Tool 2: get_order_details ----------------------------------------------

export async function getOrderDetails(args: { sales_order?: string }) {
  const raw = String(args.sales_order ?? "").replace(/\D+/g, "");
  if (!raw) throw new ToolInputError("sales_order is required.");
  const records = await getSalesOrderRecords(raw);
  if (records.length === 0) return { sales_order: raw, found: false as const, ...envelope({ filters: { sales_order: raw }, rows: 0 }) };

  const items = [...records].sort((a, b) => a.SalesOrderItem.localeCompare(b.SalesOrderItem));
  const regular = items.filter(isRegular);
  const foc = items.filter(isFoc);
  const tags = items.filter(isTag);
  const nonTag = items.filter((item) => !isTag(item));
  const count = (list: SalesItemRecord[], fn: (item: SalesItemRecord) => string) => {
    const map: Record<string, number> = {};
    for (const item of list) map[fn(item)] = (map[fn(item)] ?? 0) + 1;
    return map;
  };
  const created = items.map((item) => isoInZone(item.CreationDate)).filter(Boolean).sort()[0] ?? "";
  const LIMIT = 80;

  return {
    sales_order: orderNumber(items[0].SalesOrder),
    found: true as const,
    created_on: created ? displayDate(created) : null,
    currencies: [...new Set(nonTag.map((item) => item.TransactionCurrency))],
    plants: [...new Set(items.map((item) => item.Plant).filter(Boolean))],
    counts: { regular_items: regular.length, foc_items: foc.length, tag_rows: tags.length },
    order_value: currencyRows(regular).map(({ currency, quantity, net_amount, tax_amount, cost_amount, margin }) => ({
      currency,
      quantity,
      net_amount,
      tax_amount,
      cost_amount,
      margin,
    })),
    foc_totals: focRows(foc),
    delivery_status: count(nonTag, (item) => deliveryWord(item.DeliveryStatus)),
    billing_status: count(nonTag, (item) => processWord(item.BillingStatus)),
    blocks: count(nonTag, blockWord),
    incomplete_items: nonTag.filter((item) => incompleteFields(item).length > 0).length,
    items: items.slice(0, LIMIT).map((item) => ({
      item: item.SalesOrderItem.replace(/^0+/, "") || item.SalesOrderItem,
      type: categoryWord(item),
      material: item.Material,
      material_group: item.MaterialGroup,
      plant: item.Plant,
      division: item.Division || null,
      sales_district: item.SalesDistrict || null,
      customer_group: item.CustomerGroup || null,
      is_return: Boolean(item.IsReturnsItem),
      quantity: item.OrderQuantity,
      confirmed_quantity: item.ConfirmedQuantity ?? 0,
      unit: item.BaseUnit || item.OrderQuantityUnit,
      net_amount: round2(item.NetAmount),
      unit_price: round2(item.NetPriceAmount ?? 0),
      tax_amount: round2(item.TaxAmount ?? 0),
      cost_amount: round2(item.CostAmount ?? 0),
      currency: item.TransactionCurrency,
      delivery: isTag(item) ? "Not relevant" : deliveryWord(item.DeliveryStatus),
      billing: isTag(item) ? "Not relevant" : processWord(item.BillingStatus),
      confirmation: item.DeliveryConfirmationStatus === "C" ? "Confirmed" : item.DeliveryConfirmationStatus === "A" ? "Not confirmed" : "Not relevant",
      block: blockWord(item),
      incomplete: incompleteFields(item),
      billing_relevance: billingRelevanceWord(item.ItemIsBillingRelevant),
      billing_date: item.BillingDocumentDate ? displayDate(isoInZone(item.BillingDocumentDate)) : null,
      route: item.Route || null,
      shipping_point: item.ShippingPoint || null,
    })),
    items_shown: Math.min(items.length, LIMIT),
    items_total: items.length,
    data_notes: dataNotes(items),
    ...envelope({
      filters: { sales_order: orderNumber(items[0].SalesOrder) },
      rows: items.length,
      warnings: items.length > LIMIT ? [`Item list shows the first ${LIMIT} of ${items.length} rows.`] : [],
    }),
  };
}

// Tool 3: get_item_status ------------------------------------------------

const STATUS_LABEL: Record<StatusType, string> = {
  delivery_pending: "Pending delivery (not started)",
  delivery_partial: "Partially delivered",
  delivery_complete: "Delivered",
  delivery_blocked: "Delivery blocked",
  billing_blocked: "Billing blocked",
  blocked: "Blocked (delivery or billing)",
  billing_pending: "Billing pending",
  incomplete: "Incomplete",
  pricing_incomplete: "Pricing incomplete",
  zero_value: "Regular items with zero value",
};

function matchesStatus(item: SalesItemRecord, status: StatusType): boolean {
  switch (status) {
    case "delivery_pending":
      return item.DeliveryStatus === "A";
    case "delivery_partial":
      return item.DeliveryStatus === "B";
    case "delivery_complete":
      return item.DeliveryStatus === "C";
    case "delivery_blocked":
      return item.DeliveryBlockStatus === "C";
    case "billing_blocked":
      return item.BillingBlockStatus === "C";
    case "blocked":
      return item.DeliveryBlockStatus === "C" || item.BillingBlockStatus === "C";
    case "billing_pending":
      return (item.ItemIsBillingRelevant === "A" || item.ItemIsBillingRelevant === "D") && item.BillingStatus !== "C";
    case "incomplete":
      return incompleteFields(item).length > 0;
    case "pricing_incomplete":
      return item.PricingIncompletionStatus === "A" || item.PricingIncompletionStatus === "B";
    case "zero_value":
      return isRegular(item) && item.NetAmount === 0;
  }
}

export async function getItemStatus(args: { date_from?: string; date_to?: string; status_type?: StatusType; filters?: SalesFilters }, now = new Date()) {
  const status = args.status_type;
  if (!status || !(status in STATUS_LABEL)) throw new ToolInputError(`status_type must be one of ${Object.keys(STATUS_LABEL).join(", ")}.`);
  const range = normalizeRange(args.date_from, args.date_to, now);
  const fetched = await loadRange(range.from, range.to);
  const items = applyFilters(fetched.records, args.filters).filter((item) => !isTag(item) && matchesStatus(item, status));

  const byOrder = new Map<string, SalesItemRecord[]>();
  for (const item of items) {
    if (!byOrder.has(item.SalesOrder)) byOrder.set(item.SalesOrder, []);
    byOrder.get(item.SalesOrder)!.push(item);
  }
  const orders = [...byOrder.entries()]
    .map(([order, list]) => {
      const blocks = new Set(list.map(blockWord).filter((word) => word !== "No block"));
      const delivery = list.some((item) => item.DeliveryBlockStatus === "C");
      const billing = list.some((item) => item.BillingBlockStatus === "C");
      return {
        order: orderNumber(order),
        items: list.length,
        foc_items: list.filter(isFoc).length,
        quantity: list.reduce((sum, item) => sum + item.OrderQuantity, 0),
        currency: [...new Set(list.map((item) => item.TransactionCurrency))].join("/"),
        net_amount: round2(list.filter(isRegular).reduce((sum, item) => sum + item.NetAmount, 0)),
        block: delivery && billing ? "Delivery + Billing" : delivery ? "Delivery" : billing ? "Billing" : blocks.size ? [...blocks][0] : "No block",
        incomplete_fields: [...new Set(list.flatMap(incompleteFields))],
      };
    })
    .sort((a, b) => b.items - a.items);

  return {
    status_type: status,
    status_label: STATUS_LABEL[status],
    period: { from: displayDate(range.from), to: displayDate(range.to), defaulted_to_today: range.defaulted },
    item_count: items.length,
    order_count: orders.length,
    total_quantity: items.reduce((sum, item) => sum + item.OrderQuantity, 0),
    by_currency: currencyRows(items.filter(isRegular)).map(({ currency, items: count, quantity, net_amount }) => ({ currency, items: count, quantity, net_amount })),
    orders: orders.slice(0, 10),
    orders_shown: Math.min(orders.length, 10),
    ...envelope({
      filters: { date_from: displayDate(range.from), date_to: displayDate(range.to), date_basis: "created", status_type: status, ...args.filters },
      rows: items.length,
      partial: fetched.partial,
      retrievedAt: fetched.retrievedAt,
    }),
  };
}

// Tool 4: top_n ------------------------------------------------------------

export async function topN(
  args: { metric?: Metric; dimension?: Dimension; date_from?: string; date_to?: string; n?: number; filters?: SalesFilters },
  now = new Date(),
) {
  const metric: Metric = args.metric ?? "net_amount";
  const dimension: Dimension = args.dimension ?? "material";
  const n = Math.min(Math.max(Math.round(Number(args.n) || 10), 1), 10);
  const range = normalizeRange(args.date_from, args.date_to, now);
  const fetched = await loadRange(range.from, range.to);
  const items = applyFilters(fetched.records, args.filters).filter((item) => (args.filters?.include_foc ? !isTag(item) : isRegular(item)));
  const byCurrency = metric === "net_amount" || metric === "cost_amount";
  const keyOf = (item: SalesItemRecord) =>
    dimension === "order" ? orderNumber(item.SalesOrder) : dimension === "material" ? item.Material || "—" : groupKey(item, dimension, "created");

  const map = new Map<string, { key: string; currency?: string; b: Bucket }>();
  for (const item of items) {
    const key = keyOf(item);
    const id = byCurrency ? `${key}|${item.TransactionCurrency}` : key;
    if (!map.has(id)) map.set(id, { key, ...(byCurrency ? { currency: item.TransactionCurrency } : {}), b: bucket() });
    add(map.get(id)!.b, item);
  }
  const value = (b: Bucket) => (metric === "quantity" ? b.quantity : metric === "order_count" ? b.orders.size : metric === "cost_amount" ? round2(b.cost) : round2(b.net));
  const rows = [...map.values()]
    .map(({ key, currency, b }) => ({ [dimension]: key, ...(currency ? { currency } : {}), value: value(b), orders: b.orders.size, items: b.items, quantity: b.quantity }))
    .sort((a, b) => b.value - a.value);

  let ranked: Array<(typeof rows)[number] & { rank: number }>;
  if (byCurrency) {
    const perCurrency = new Map<string, typeof ranked>();
    for (const row of rows) {
      const currency = String(row.currency);
      if (!perCurrency.has(currency)) perCurrency.set(currency, []);
      const list = perCurrency.get(currency)!;
      if (list.length < n) list.push({ ...row, rank: list.length + 1 });
    }
    ranked = [...perCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, list]) => list);
  } else {
    ranked = rows.slice(0, n).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  return {
    metric,
    dimension,
    n,
    period: { from: displayDate(range.from), to: displayDate(range.to), defaulted_to_today: range.defaulted },
    ranked_per_currency: byCurrency,
    rows: ranked,
    total_groups: map.size,
    foc_included: Boolean(args.filters?.include_foc),
    ...envelope({
      filters: { date_from: displayDate(range.from), date_to: displayDate(range.to), date_basis: "created", metric, dimension, n, ...args.filters },
      rows: items.length,
      partial: fetched.partial,
      retrievedAt: fetched.retrievedAt,
    }),
  };
}

// Tool 5: compare_periods -------------------------------------------------

interface PeriodArg {
  date_from?: string;
  date_to?: string;
  label?: string;
}

function change(a: number, b: number): { difference: number; change_pct: number | null } {
  return { difference: round2(a - b), change_pct: b === 0 ? (a === 0 ? 0 : null) : Math.round(((a - b) / b) * 1000) / 10 };
}

export async function comparePeriods(args: { period_a?: PeriodArg; period_b?: PeriodArg; metric?: CompareMetric; filters?: SalesFilters }, now = new Date()) {
  if (!args.period_a || !args.period_b) throw new ToolInputError("period_a and period_b are required.");
  const [a, b] = await Promise.all([
    getSalesSummary({ date_from: args.period_a.date_from, date_to: args.period_a.date_to, filters: args.filters }, now),
    getSalesSummary({ date_from: args.period_b.date_from, date_to: args.period_b.date_to, filters: args.filters }, now),
  ]);
  const currencies = [...new Set([...a.by_currency, ...b.by_currency].map((row) => row.currency))].sort();
  const pick = (summary: typeof a, currency: string) => summary.by_currency.find((row) => row.currency === currency);
  return {
    focus_metric: args.metric ?? "quantity",
    period_a: { label: args.period_a.label ?? null, ...a.period },
    period_b: { label: args.period_b.label ?? null, ...b.period },
    totals: {
      order_count: { a: a.order_count, b: b.order_count, ...change(a.order_count, b.order_count) },
      item_count: { a: a.item_count, b: b.item_count, ...change(a.item_count, b.item_count) },
      total_quantity: { a: a.total_quantity, b: b.total_quantity, ...change(a.total_quantity, b.total_quantity) },
      confirmed_quantity: { a: a.confirmed_quantity, b: b.confirmed_quantity, ...change(a.confirmed_quantity, b.confirmed_quantity) },
      return_items: { a: a.returns.items, b: b.returns.items, ...change(a.returns.items, b.returns.items) },
      foc_items: { a: a.foc.items, b: b.foc.items, ...change(a.foc.items, b.foc.items) },
    },
    by_currency: currencies.map((currency) => {
      const x = pick(a, currency);
      const y = pick(b, currency);
      return {
        currency,
        net_amount: { a: x?.net_amount ?? 0, b: y?.net_amount ?? 0, ...change(x?.net_amount ?? 0, y?.net_amount ?? 0) },
        tax_amount: { a: x?.tax_amount ?? 0, b: y?.tax_amount ?? 0, ...change(x?.tax_amount ?? 0, y?.tax_amount ?? 0) },
        cost_amount: { a: x?.cost_amount ?? 0, b: y?.cost_amount ?? 0, ...change(x?.cost_amount ?? 0, y?.cost_amount ?? 0) },
        order_count: { a: x?.order_count ?? 0, b: y?.order_count ?? 0, ...change(x?.order_count ?? 0, y?.order_count ?? 0) },
      };
    }),
    data_notes: [...new Set([...a.data_notes, ...b.data_notes])],
    filters_applied: { period_a: a.filters_applied, period_b: b.filters_applied },
    row_count: a.row_count + b.row_count,
    is_partial: a.is_partial || b.is_partial,
    data_as_of: a.data_as_of,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
  };
}

// Tool 6: search_material -------------------------------------------------

export async function searchMaterial(args: { text?: string }, now = new Date()) {
  const text = String(args.text ?? "").trim();
  if (compact(text).length < 3) throw new ToolInputError("Give at least 3 characters of the material or style code.");
  const today = businessToday(now).date;
  const from = shiftDate(today, -(SEARCH_DAYS - 1));
  const fetched = await loadRange(from, today);
  const needle = compact(text);
  const matches = fetched.records.filter((item) => compact(item.Material).includes(needle));
  const parents = new Set(matches.filter(isTag).map((item) => item.Material));
  const map = new Map<string, { material: string; parent: boolean; items: number; quantity: number; last: string; groups: Set<string> }>();
  for (const item of matches) {
    const entry = map.get(item.Material) ?? { material: item.Material, parent: false, items: 0, quantity: 0, last: "", groups: new Set<string>() };
    if (isTag(item)) entry.parent = true;
    else {
      entry.items += 1;
      entry.quantity += item.OrderQuantity;
    }
    const created = isoInZone(item.CreationDate);
    if (created > entry.last) entry.last = created;
    if (item.MaterialGroup) entry.groups.add(item.MaterialGroup);
    map.set(item.Material, entry);
  }
  const rows = [...map.values()]
    .sort((x, y) => Number(y.parent) - Number(x.parent) || y.quantity - x.quantity)
    .map((entry) => ({
      material: entry.material,
      kind: entry.parent ? "Style / parent (TAG)" : [...parents].some((parent) => entry.material.startsWith(parent) && entry.material.length > parent.length) ? "Variant" : "Material",
      variants: entry.parent ? [...map.keys()].filter((code) => code !== entry.material && code.startsWith(entry.material)).length : undefined,
      sales_items: entry.items,
      quantity: entry.quantity,
      material_group: [...entry.groups].join(", ") || null,
      last_created: entry.last ? displayDate(entry.last) : null,
    }));
  return {
    search_text: text,
    total_matches: rows.length,
    matches: rows.slice(0, 20),
    ...envelope({
      filters: { material_text: text, date_from: displayDate(from), date_to: displayDate(today), date_basis: "created" },
      rows: matches.length,
      partial: fetched.partial,
      retrievedAt: fetched.retrievedAt,
      warnings: [`Searched items created in the last ${SEARCH_DAYS} days.`, ...(rows.length > 20 ? [`Showing 20 of ${rows.length} matching materials.`] : [])],
    }),
  };
}

// Dispatcher --------------------------------------------------------------

export const SALES_TOOL_NAMES = ["get_sales_summary", "get_order_details", "get_item_status", "top_n", "compare_periods", "search_material"] as const;
export type SalesToolName = (typeof SALES_TOOL_NAMES)[number];

const COST_KEYS = new Set(["cost_amount", "margin", "cost"]);

/** Removes cost/margin fields for roles that may not see them. */
export function stripCost<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCost) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !COST_KEYS.has(key)).map(([key, inner]) => [key, stripCost(inner)])) as T;
  }
  return value;
}

async function dispatch(name: string, args: Record<string, unknown>, now: Date): Promise<unknown> {
  switch (name) {
    case "get_sales_summary":
      return getSalesSummary(args as Parameters<typeof getSalesSummary>[0], now);
    case "get_order_details":
      return getOrderDetails(args as Parameters<typeof getOrderDetails>[0]);
    case "get_item_status":
      return getItemStatus(args as Parameters<typeof getItemStatus>[0], now);
    case "top_n":
      return topN(args as Parameters<typeof topN>[0], now);
    case "compare_periods":
      return comparePeriods(args as Parameters<typeof comparePeriods>[0], now);
    case "search_material":
      return searchMaterial(args as Parameters<typeof searchMaterial>[0], now);
    default:
      throw new ToolInputError(`Unknown tool ${name}.`);
  }
}

export async function runSalesTool(name: string, args: Record<string, unknown>, now = new Date()): Promise<unknown> {
  const costAllowed = canSeeCost();
  if (!costAllowed && (args.metric === "cost_amount" || args.metric === "margin")) {
    throw new ToolInputError("Cost/margin details are not available for this user role.", "cost_access");
  }
  const result = await dispatch(name, args, now);
  if (costAllowed) return result;
  const stripped = stripCost(result) as Record<string, unknown>;
  const warnings = Array.isArray(stripped.warnings) ? stripped.warnings : [];
  return { ...stripped, warnings: [...warnings, "Cost and margin are hidden for this user role."] };
}

const FILTER_SCHEMA = {
  type: "object",
  description: "Optional filters. Omit keys you do not need.",
  properties: {
    plant: { type: "string", description: "Plant code, e.g. P002 or P003 (comma separated for several)." },
    material: { type: "string", description: "Material / style code or part of it. A style (parent) code also matches all its variants." },
    material_group: { type: "string", description: "Material group, e.g. MC111001." },
    currency: { type: "string", enum: ["EUR", "INR", "USD"] },
    route: { type: "string" },
    shipping_point: { type: "string" },
    item_category: { type: "string", description: "ZTAM, ZTAN, YTAN, ZFOC or TAG." },
    division: { type: "string", description: "Division code exactly as in the data." },
    sales_district: { type: "string", description: "Sales district code exactly as in the data." },
    customer_group: { type: "string", description: "Customer group code exactly as in the data (customer names are not available)." },
    returns: { type: "boolean", description: "true = return items only (IsReturnsItem), false = exclude return items." },
    include_foc: { type: "boolean", description: "Only for top_n: include FOC items." },
  },
  additionalProperties: false,
};

const DATE_PROPS = {
  date_from: { type: "string", description: "Start date YYYY-MM-DD (inclusive, IST). Range max 6 months; use group_by month for ranges over one month." },
  date_to: { type: "string", description: "End date YYYY-MM-DD (inclusive, IST)." },
};

const PERIOD_SCHEMA = {
  type: "object",
  properties: { ...DATE_PROPS, label: { type: "string", description: "Friendly label, e.g. 'Yesterday'." } },
  required: ["date_from", "date_to"],
  additionalProperties: false,
};

export const SALES_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_sales_summary",
      description:
        "Sales totals for a date range. Per currency: order_count, foc_only_order_count, item_count, total_quantity, net_amount, tax_amount, cost_amount. Also confirmed_quantity and returns (items, orders, quantity, per-currency net). TAG rows excluded, FOC reported separately (foc value/tax/cost). Optional grouping.",
      parameters: {
        type: "object",
        properties: {
          ...DATE_PROPS,
          date_basis: { type: "string", enum: ["created", "billing_date"], description: "Default created." },
          group_by: {
            type: "string",
            enum: ["none", "currency", "plant", "material", "material_group", "item_category", "route", "shipping_point", "division", "sales_district", "customer_group", "date", "month", "hour"],
          },
          filters: FILTER_SCHEMA,
        },
        required: ["date_from", "date_to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_details",
      description: "All items of ONE sales order (fetched by order number, never by date) with quantities, amounts, statuses (friendly words), blocks and incompletion.",
      parameters: {
        type: "object",
        properties: { sales_order: { type: "string", description: "Sales order number, digits only, e.g. 4645 or 70026657." } },
        required: ["sales_order"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item_status",
      description: "Items (TAG excluded) created in a date range that match a status, summarised per order (top 10).",
      parameters: {
        type: "object",
        properties: {
          ...DATE_PROPS,
          status_type: {
            type: "string",
            enum: Object.keys(STATUS_LABEL),
          },
          filters: FILTER_SCHEMA,
        },
        required: ["date_from", "date_to", "status_type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "top_n",
      description: "Rank a dimension by a metric over a date range (max 10). net_amount and cost_amount are ranked separately per currency. Regular items only unless filters.include_foc.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", enum: ["quantity", "net_amount", "cost_amount", "order_count"] },
          dimension: { type: "string", enum: ["material", "material_group", "plant", "route", "division", "sales_district", "customer_group", "order"] },
          ...DATE_PROPS,
          n: { type: "integer", minimum: 1, maximum: 10 },
          filters: FILTER_SCHEMA,
        },
        required: ["metric", "dimension", "date_from", "date_to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_periods",
      description:
        "Compare two date ranges: orders, items, quantity, confirmed quantity, return items, FOC items and per-currency net/tax/cost with difference and change % (change_pct null = previous period is zero). period_a = current, period_b = previous. Use for every comparison.",
      parameters: {
        type: "object",
        properties: {
          period_a: PERIOD_SCHEMA,
          period_b: PERIOD_SCHEMA,
          metric: { type: "string", enum: ["quantity", "net_amount", "tax_amount", "cost_amount", "order_count", "item_count"] },
          filters: FILTER_SCHEMA,
        },
        required: ["period_a", "period_b"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_material",
      description: "Find materials / styles by partial code or style prefix (items created in the last 31 days). Returns parents (TAG) with variant counts.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Partial material or style code, at least 3 characters." } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
];
