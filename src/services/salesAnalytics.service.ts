/*
 * Sales Analytics Engine — enterprise metrics over normalized ZI_SalesApi_HUB records.
 * All business calculations live here. Never calculate on raw SAP JSON.
 * Sales Order counts always use DISTINCT SalesOrder (never records.length).
 */
import { obs } from "./audit.service";
import { rangeForSpec, type PeriodSpec } from "./dateEngine.service";
import {
  getSalesItemsForRange,
  sumAmountsByCurrency,
  sumQuantities,
  type CurrencyTotal,
  type DateRange,
  type NormalizationStats,
  type QuantityTotal,
  type SalesItemRecord,
} from "./sapSales.service";

export type GroupDimension =
  | "DATE"
  | "SALES_ORDER"
  | "MATERIAL"
  | "PLANT"
  | "CUSTOMER_GROUP"
  | "CURRENCY"
  | "DELIVERY_STATUS"
  | "BILLING_STATUS";

export type FilterField = "MATERIAL" | "PLANT" | "CURRENCY" | "CUSTOMER_GROUP" | "DELIVERY_STATUS" | "BILLING_STATUS";
export type SalesFilters = Partial<Record<FilterField, string[]>> & { pendingOnly?: boolean };

export interface SalesKpis {
  salesOrders: number;
  salesOrderItems: number;
  totalQuantity: QuantityTotal[];
  totalAmount: CurrencyTotal[];
  averageOrderValue: CurrencyTotal[];
  /** Unit with the largest quantity; averages and single-number quantity comparisons use it so units are never added. */
  primaryUnit: string;
  averageQuantityPerOrder: number;
  averageItemsPerOrder: number;
  ordersPerDay: number;
  activeDays: number;
}

export interface GroupRow {
  key: string;
  salesOrders: number;
  items: number;
  /** Raw sum used for ranking (a material or order normally has one unit); display uses `quantities`. */
  quantity: number;
  quantities: QuantityTotal[];
  amounts: CurrencyTotal[];
}

export interface TrendPoint {
  date: string;
  salesOrders: number;
  items: number;
  quantity: number;
  amounts: CurrencyTotal[];
}

export interface Provenance {
  source: "SAP_SALES_API";
  endpoint: "ZI_SalesApi_HUB";
  retrievedAt: string;
  fromCache: boolean;
  period: { name: string; label: string; start: string; end: string };
  recordCount: number;
  calculation: string;
}

export interface DataQuality {
  ok: boolean;
  notes: string[];
}

export interface AnalyticsBundle {
  records: SalesItemRecord[];
  range: DateRange;
  provenance: Provenance;
  quality: DataQuality;
}

const DIVISION_SAFE = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

const STATUS_LABELS: Record<string, string> = {
  A: "Not yet processed (A)",
  B: "Partially processed (B)",
  C: "Completely processed (C)",
};

export function statusLabel(code: string): string {
  if (!code) return "Not relevant";
  return STATUS_LABELS[code] ?? code;
}

export function distinctSalesOrders(records: SalesItemRecord[]): number {
  return new Set(records.map((record) => record.SalesOrder)).size;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeKpis(records: SalesItemRecord[]): SalesKpis {
  const salesOrders = distinctSalesOrders(records);
  const totalAmount = sumAmountsByCurrency(records).map((entry) => ({ currency: entry.currency, amount: round(entry.amount, 2) }));
  const totalQuantity = sumQuantities(records).map((entry) => ({ unit: entry.unit, quantity: round(entry.quantity, 3) }));
  const primary = [...totalQuantity].sort((left, right) => right.quantity - left.quantity)[0];
  const totalQuantitySum = primary?.quantity ?? 0;
  const activeDays = new Set(records.filter((record) => record.CreationDate).map((record) => isoDate(record.CreationDate!))).size;
  return {
    salesOrders,
    salesOrderItems: records.length,
    totalQuantity,
    totalAmount,
    averageOrderValue: totalAmount.map((entry) => ({ currency: entry.currency, amount: round(DIVISION_SAFE(entry.amount, salesOrders), 2) })),
    primaryUnit: primary?.unit ?? "EA",
    averageQuantityPerOrder: round(DIVISION_SAFE(totalQuantitySum, salesOrders), 3),
    averageItemsPerOrder: round(DIVISION_SAFE(records.length, salesOrders), 3),
    ordersPerDay: round(DIVISION_SAFE(salesOrders, activeDays), 2),
    activeDays,
  };
}

function dimensionValue(record: SalesItemRecord, dimension: GroupDimension): string {
  switch (dimension) {
    case "DATE":
      return record.CreationDate ? isoDate(record.CreationDate) : "";
    case "SALES_ORDER":
      return record.SalesOrder;
    case "MATERIAL":
      return record.Material || "—";
    case "PLANT":
      return record.Plant || "—";
    case "CUSTOMER_GROUP":
      return record.CustomerGroup || "Not assigned";
    case "CURRENCY":
      return record.TransactionCurrency || "UNKNOWN";
    case "DELIVERY_STATUS":
      return statusLabel(record.DeliveryStatus);
    case "BILLING_STATUS":
      return statusLabel(record.BillingStatus);
  }
}

export function groupSales(records: SalesItemRecord[], dimension: GroupDimension): GroupRow[] {
  const groups = new Map<string, SalesItemRecord[]>();
  for (const record of records) {
    const key = dimensionValue(record, dimension) || "—";
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, bucket]) => ({
    key,
    salesOrders: distinctSalesOrders(bucket),
    items: bucket.length,
    quantity: round(bucket.reduce((sum, record) => sum + record.OrderQuantity, 0), 3),
    quantities: sumQuantities(bucket).map((entry) => ({ unit: entry.unit, quantity: round(entry.quantity, 3) })),
    amounts: sumAmountsByCurrency(bucket).map((entry) => ({ currency: entry.currency, amount: round(entry.amount, 2) })),
  }));
}

export type RankMetric = "AMOUNT" | "QUANTITY" | "ITEM_COUNT" | "SALES_ORDERS";

/**
 * Ranking value. AMOUNT ranks within one currency (the dominant one) so different currencies are never added.
 */
function rankValue(row: GroupRow, metric: RankMetric, currency?: string): number {
  switch (metric) {
    case "AMOUNT":
      if (currency) return row.amounts.find((entry) => entry.currency === currency)?.amount ?? 0;
      return row.amounts.length === 1 ? row.amounts[0].amount : 0;
    case "QUANTITY":
      return row.quantity;
    case "ITEM_COUNT":
      return row.items;
    case "SALES_ORDERS":
      return row.salesOrders;
  }
}

/**
 * Currency used to rank by amount without mixing currencies: the one with the most distinct sales orders
 * (raw totals are not comparable across currencies, e.g. INR vs EUR).
 */
export function dominantCurrency(records: SalesItemRecord[]): string | undefined {
  const orders = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.TransactionCurrency) continue;
    const set = orders.get(record.TransactionCurrency) ?? new Set<string>();
    set.add(record.SalesOrder);
    orders.set(record.TransactionCurrency, set);
  }
  return [...orders.entries()].sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))[0]?.[0];
}

export function rankGroups(rows: GroupRow[], metric: RankMetric, direction: "DESC" | "ASC", limit: number, currency?: string): GroupRow[] {
  const sorted = [...rows].sort((left, right) => {
    const diff = rankValue(right, metric, currency) - rankValue(left, metric, currency);
    return direction === "DESC" ? diff : -diff;
  });
  return sorted.slice(0, Math.max(1, limit));
}

export function buildTrend(records: SalesItemRecord[]): TrendPoint[] {
  return groupSales(records, "DATE")
    .filter((row) => row.key && row.key !== "—")
    .map((row) => ({ date: row.key, salesOrders: row.salesOrders, items: row.items, quantity: row.quantity, amounts: row.amounts }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** Pending = sales orders with at least one item not completely delivered (status A or B). */
export function pendingRecords(records: SalesItemRecord[]): SalesItemRecord[] {
  const pendingOrders = new Set(records.filter((record) => record.DeliveryStatus === "A" || record.DeliveryStatus === "B").map((record) => record.SalesOrder));
  return records.filter((record) => pendingOrders.has(record.SalesOrder));
}

const FILTER_ACCESSORS: Record<FilterField, (record: SalesItemRecord) => string> = {
  MATERIAL: (record) => record.Material,
  PLANT: (record) => record.Plant,
  CURRENCY: (record) => record.TransactionCurrency,
  CUSTOMER_GROUP: (record) => record.CustomerGroup,
  DELIVERY_STATUS: (record) => record.DeliveryStatus,
  BILLING_STATUS: (record) => record.BillingStatus,
};

export function applyFilters(records: SalesItemRecord[], filters: SalesFilters = {}): SalesItemRecord[] {
  let result = records;
  for (const [field, values] of Object.entries(filters) as Array<[FilterField | "pendingOnly", unknown]>) {
    if (field === "pendingOnly" || !Array.isArray(values) || values.length === 0) continue;
    const wanted = new Set(values.map((value) => String(value).toUpperCase()));
    const accessor = FILTER_ACCESSORS[field];
    result = result.filter((record) => wanted.has(accessor(record).toUpperCase()));
  }
  return filters.pendingOnly ? pendingRecords(result) : result;
}

export interface PercentChange {
  label: string;
  current: number;
  previous: number;
  difference: number;
  percentText: string;
  percent: number | null;
}

export const ZERO_BASE_TEXT = "Percentage change cannot be calculated because the previous period had zero value.";

export function percentChange(label: string, current: number, previous: number): PercentChange {
  const difference = round(current - previous, 2);
  if (previous === 0) return { label, current, previous, difference, percent: null, percentText: ZERO_BASE_TEXT };
  const percent = round(((current - previous) / previous) * 100, 1);
  return { label, current, previous, difference, percent, percentText: `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%` };
}

export interface ComparisonResult {
  current: { range: DateRange; kpis: SalesKpis };
  previous: { range: DateRange; kpis: SalesKpis };
  salesOrders: PercentChange;
  items: PercentChange;
  quantity: PercentChange;
  quantityByUnit: PercentChange[];
  averageOrderValue: PercentChange[];
  amountByCurrency: PercentChange[];
}

export function compareKpis(current: { range: DateRange; kpis: SalesKpis }, previous: { range: DateRange; kpis: SalesKpis }): ComparisonResult {
  const byCurrency = (pick: (kpis: SalesKpis) => CurrencyTotal[]): PercentChange[] => {
    const currencies = new Set([...pick(current.kpis), ...pick(previous.kpis)].map((entry) => entry.currency));
    return [...currencies].sort().map((currency) =>
      percentChange(
        currency,
        pick(current.kpis).find((entry) => entry.currency === currency)?.amount ?? 0,
        pick(previous.kpis).find((entry) => entry.currency === currency)?.amount ?? 0,
      ),
    );
  };
  const units = [...new Set([...current.kpis.totalQuantity, ...previous.kpis.totalQuantity].map((entry) => entry.unit))].sort();
  const qty = (kpis: SalesKpis, unit: string) => kpis.totalQuantity.find((entry) => entry.unit === unit)?.quantity ?? 0;
  const quantityByUnit = units.map((unit) => percentChange(unit, qty(current.kpis, unit), qty(previous.kpis, unit)));
  const unit = current.kpis.salesOrderItems > 0 ? current.kpis.primaryUnit : previous.kpis.primaryUnit;
  return {
    current,
    previous,
    salesOrders: percentChange("Sales Orders", current.kpis.salesOrders, previous.kpis.salesOrders),
    items: percentChange("Sales Order Items", current.kpis.salesOrderItems, previous.kpis.salesOrderItems),
    quantity: percentChange(unit, qty(current.kpis, unit), qty(previous.kpis, unit)),
    quantityByUnit,
    averageOrderValue: byCurrency((kpis) => kpis.averageOrderValue),
    amountByCurrency: byCurrency((kpis) => kpis.totalAmount),
  };
}

export function assessQuality(records: SalesItemRecord[], stats?: NormalizationStats): DataQuality {
  const notes: string[] = [];
  if (stats) {
    if (stats.duplicates > 0) notes.push(`${stats.duplicates} duplicate item row(s) from SAP were removed.`);
    if (stats.invalidDates > 0) notes.push(`${stats.invalidDates} item(s) had no valid creation date.`);
    if (stats.invalidNumbers > 0) notes.push(`${stats.invalidNumbers} item(s) had a non-numeric quantity or amount (counted as 0).`);
    if (stats.missingCurrency > 0) notes.push(`${stats.missingCurrency} item(s) had no transaction currency.`);
    if (stats.truncated) notes.push(`SAP returned more pages than the ${stats.pages}-page safety limit; totals may be incomplete.`);
  } else {
    const missingDate = records.filter((record) => !record.CreationDate).length;
    if (missingDate > 0) notes.push(`${missingDate} item(s) had no creation date.`);
  }
  const zeroAmount = records.filter((record) => record.NetAmount === 0).length;
  if (records.length > 0 && zeroAmount / records.length >= 0.25) {
    notes.push(`${zeroAmount} of ${records.length} items have a net amount of 0 in SAP, so amount totals understate order value.`);
  }
  return { ok: notes.length === 0, notes };
}

/** Share of records with an empty value for a dimension — used to warn when a grouping is mostly blank. */
export function blankShare(records: SalesItemRecord[], dimension: GroupDimension): number {
  if (records.length === 0) return 0;
  const blank = records.filter((record) => {
    if (dimension === "CUSTOMER_GROUP") return !record.CustomerGroup;
    if (dimension === "PLANT") return !record.Plant;
    if (dimension === "MATERIAL") return !record.Material;
    return false;
  }).length;
  return blank / records.length;
}

/**
 * Single controlled entry point: fetch + validate + provenance for a period.
 * Returns normalized records that every analytics function operates on.
 */
export async function loadSalesBundle(spec: PeriodSpec | string, now = new Date()): Promise<AnalyticsBundle> {
  const periodSpec: PeriodSpec = typeof spec === "string" ? { period: spec as PeriodSpec["period"] } : spec;
  const started = Date.now();
  const range = rangeForSpec(periodSpec, now);
  const fetched = await getSalesItemsForRange(range);
  const quality = assessQuality(fetched.records, fetched.stats);
  const provenance: Provenance = {
    source: "SAP_SALES_API",
    endpoint: "ZI_SalesApi_HUB",
    retrievedAt: fetched.retrievedAt,
    fromCache: fetched.fromCache,
    period: { name: periodSpec.period, label: range.label, start: range.start, end: range.end },
    recordCount: fetched.records.length,
    calculation: "DISTINCT SalesOrder",
  };
  obs("ANALYTICS_COMPLETED", {
    period: periodSpec.period,
    label: range.label,
    records: fetched.records.length,
    salesOrders: distinctSalesOrders(fetched.records),
    fromCache: fetched.fromCache,
    ms: Date.now() - started,
  });
  return { records: fetched.records, range, provenance, quality };
}
