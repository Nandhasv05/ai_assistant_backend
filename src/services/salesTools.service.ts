/*
 * Controlled Sales tools — the only path from a validated plan to SAP data.
 * Every tool is read-only, reaches SAP through the Sales hub client, and returns analytics (not formatting).
 */
import { annotateAudit } from "./audit.service";
import { previousSpec, type PeriodSpec } from "./dateEngine.service";
import {
  applyFilters,
  buildTrend,
  compareKpis,
  computeKpis,
  dominantCurrency,
  groupSales,
  loadSalesBundle,
  rankGroups,
  type AnalyticsBundle,
  type ComparisonResult,
  type GroupDimension,
  type GroupRow,
  type RankMetric,
  type SalesFilters,
  type SalesKpis,
  type TrendPoint,
} from "./salesAnalytics.service";
import { getSalesOrderDetails, type UniqueSalesOrder } from "./sapSales.service";

export type SalesToolName =
  | "getSalesData"
  | "getSalesOrder"
  | "getSalesSummary"
  | "getSalesTrend"
  | "getSalesByMaterial"
  | "getSalesByCustomerGroup"
  | "getSalesByPlant"
  | "getSalesByStatus"
  | "getSalesComparison";

export const SALES_TOOLS: Record<SalesToolName, string> = {
  getSalesData: "Item-level sales records for a period (optionally filtered), e.g. pending orders or top orders.",
  getSalesOrder: "One sales order with all its items.",
  getSalesSummary: "KPIs for a period: distinct orders, items, quantity, amount per currency, averages.",
  getSalesTrend: "Daily trend: distinct orders, items, quantity, amount per day.",
  getSalesByMaterial: "Sales grouped by material.",
  getSalesByCustomerGroup: "Sales grouped by customer group.",
  getSalesByPlant: "Sales grouped by plant.",
  getSalesByStatus: "Sales grouped by delivery or billing status.",
  getSalesComparison: "KPIs for a period against a comparison period.",
};

function track(tool: SalesToolName): void {
  annotateAudit({ tool });
}

async function bundleFor(spec: PeriodSpec, filters: SalesFilters | undefined, now: Date): Promise<AnalyticsBundle> {
  const bundle = await loadSalesBundle(spec, now);
  annotateAudit({ dateRange: { start: bundle.range.startDate, end: bundle.range.endDateExclusive, label: bundle.range.label } });
  if (!filters || Object.keys(filters).length === 0) return bundle;
  const records = applyFilters(bundle.records, filters);
  return { ...bundle, records, provenance: { ...bundle.provenance, recordCount: records.length } };
}

export async function getSalesData(spec: PeriodSpec, filters: SalesFilters | undefined, now = new Date()): Promise<AnalyticsBundle> {
  track("getSalesData");
  return bundleFor(spec, filters, now);
}

export async function getSalesOrder(salesOrder: string): Promise<UniqueSalesOrder | null> {
  track("getSalesOrder");
  return getSalesOrderDetails(salesOrder);
}

export async function getSalesSummary(spec: PeriodSpec, filters: SalesFilters | undefined, now = new Date()): Promise<{ bundle: AnalyticsBundle; kpis: SalesKpis }> {
  track("getSalesSummary");
  const bundle = await bundleFor(spec, filters, now);
  return { bundle, kpis: computeKpis(bundle.records) };
}

export async function getSalesTrend(spec: PeriodSpec, filters: SalesFilters | undefined, now = new Date()): Promise<{ bundle: AnalyticsBundle; trend: TrendPoint[] }> {
  track("getSalesTrend");
  const bundle = await bundleFor(spec, filters, now);
  return { bundle, trend: buildTrend(bundle.records) };
}

export interface GroupQuery {
  dimension: GroupDimension;
  sort: { field: RankMetric; direction: "DESC" | "ASC" } | null;
  limit: number | null;
}

const GROUP_TOOL: Partial<Record<GroupDimension, SalesToolName>> = {
  MATERIAL: "getSalesByMaterial",
  CUSTOMER_GROUP: "getSalesByCustomerGroup",
  PLANT: "getSalesByPlant",
  DELIVERY_STATUS: "getSalesByStatus",
  BILLING_STATUS: "getSalesByStatus",
};

export function groupToolFor(dimension: GroupDimension): SalesToolName {
  return GROUP_TOOL[dimension] ?? "getSalesData";
}

/** Shared by getSalesByMaterial / CustomerGroup / Plant / Status (and SALES_ORDER / DATE / CURRENCY via getSalesData). */
export async function getSalesGrouped(
  spec: PeriodSpec,
  query: GroupQuery,
  filters: SalesFilters | undefined,
  now = new Date(),
): Promise<{ bundle: AnalyticsBundle; rows: GroupRow[]; totalGroups: number; rankCurrency?: string }> {
  track(groupToolFor(query.dimension));
  const bundle = await bundleFor(spec, filters, now);
  const all = groupSales(bundle.records, query.dimension);
  const rankCurrency = dominantCurrency(bundle.records);
  const field = query.sort?.field ?? (query.dimension === "DATE" ? "SALES_ORDERS" : "AMOUNT");
  const rows =
    query.dimension === "DATE" && !query.sort
      ? all.sort((left, right) => left.key.localeCompare(right.key))
      : rankGroups(all, field, query.sort?.direction ?? "DESC", query.limit ?? Math.min(all.length, 100), rankCurrency);
  return { bundle, rows, totalGroups: all.length, rankCurrency };
}

export async function getSalesComparison(
  spec: PeriodSpec,
  compareSpec: PeriodSpec | undefined,
  filters: SalesFilters | undefined,
  now = new Date(),
): Promise<{ current: AnalyticsBundle; previous: AnalyticsBundle; comparison: ComparisonResult }> {
  track("getSalesComparison");
  const target = compareSpec ?? previousSpec(spec, now);
  const [current, previous] = await Promise.all([bundleFor(spec, filters, now), bundleFor(target, filters, now)]);
  annotateAudit({ dateRange: { start: previous.range.startDate, end: current.range.endDateExclusive, label: `${current.range.label} vs ${previous.range.label}` } });
  const comparison = compareKpis(
    { range: current.range, kpis: computeKpis(current.records) },
    { range: previous.range, kpis: computeKpis(previous.records) },
  );
  return { current, previous, comparison };
}
