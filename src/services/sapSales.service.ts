import { currentAudit, obs } from "./audit.service";

const DEFAULT_SAP_SALES_URL =
  "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZI_SALESAPI_HUB_CDS/ZI_SalesApi_HUB";
const DEFAULT_SAP_QUOTATION_URL =
  "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZI_QUOTATIONSALESORDER_HUB_CDS/ZI_QuotationSalesOrder_HUB";

const SAP_FAILURE = "Unable to retrieve the latest sales data from SAP.";
export const SAP_EMPTY = "No sales records were found for the requested period.";

export interface SalesItemRecord {
  SalesOrder: string;
  SalesOrderItem: string;
  CreationDate: Date | null;
  CreationTime: string;
  Material: string;
  OrderQuantity: number;
  OrderQuantityUnit: string;
  RequestedQuantity?: number;
  NetAmount: number;
  TransactionCurrency: string;
  Plant: string;
  CustomerGroup: string;
  DeliveryStatus: string;
  BillingStatus: string;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface QuantityTotal {
  unit: string;
  quantity: number;
}

export interface UniqueSalesOrder {
  salesOrder: string;
  creationDate: string | null;
  creationTime: string;
  items: string[];
  itemCount: number;
  quantities: QuantityTotal[];
  amounts: CurrencyTotal[];
  plants: string[];
  deliveryStatuses: string[];
  billingStatuses: string[];
  itemRecords: SalesItemRecord[];
}

export interface DailySalesPoint {
  date: string;
  salesOrders: number;
  salesOrderItems: number;
  quantity: number;
}

export type SalesPeriodName =
  | "TODAY"
  | "YESTERDAY"
  | "THIS_WEEK"
  | "LAST_WEEK"
  | "THIS_MONTH"
  | "LAST_MONTH"
  | "THIS_QUARTER"
  | "LAST_QUARTER"
  | "THIS_YEAR"
  | "LAST_YEAR";

export interface DateRange {
  period: SalesPeriodName;
  start: string;
  end: string;
  startDate: string;
  endDateExclusive: string;
  label: string;
}

export interface SalesPeriodResult {
  metric: "sales_orders";
  label: string;
  start: string;
  end: string;
  count: number;
  itemCount: number;
  orders: UniqueSalesOrder[];
  quantities: QuantityTotal[];
  amounts: CurrencyTotal[];
  dailySales: DailySalesPoint[];
}

export interface TodaySalesOrders extends SalesPeriodResult {
  metric: "sales_orders";
  date: string;
  todayStart: string;
  todayEnd: string;
}

export function sapDataError(): string {
  return SAP_FAILURE;
}

export function businessTimeZone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "Asia/Kolkata";
}

export function parseSapDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\/Date\((\d+)\)\//);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatSapTime(value: string | null): string {
  if (!value) {
    return "";
  }
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) {
    return value;
  }
  const hours = (match[1] ?? "0").padStart(2, "0");
  const minutes = (match[2] ?? "0").padStart(2, "0");
  const seconds = (match[3] ?? "0").padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function businessToday(now = new Date()): { date: string; todayStart: string; todayEnd: string } {
  const timeZone = businessTimeZone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  const date = `${year}-${month}-${day}`;
  const tomorrow = nextCalendarDate(date);
  return {
    date,
    todayStart: `${date}T00:00:00`,
    todayEnd: `${tomorrow}T00:00:00`,
  };
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((entry) => entry.type === type)?.value;
  if (!value) {
    throw new Error(SAP_FAILURE);
  }
  return value;
}

function nextCalendarDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function formatInBusinessZone(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sapConfig(): { endpoint: string; quotationEndpoint: string; username: string; password: string } {
  const username = process.env.SAP_USERNAME?.trim() ?? "";
  const password = process.env.SAP_PASSWORD?.trim() ?? "";
  const endpoint = (process.env.SAP_SALES_API_URL?.trim() || DEFAULT_SAP_SALES_URL).replace(/\/$/, "");
  const quotationEndpoint = (process.env.SAP_QUOTATION_API_URL?.trim() || DEFAULT_SAP_QUOTATION_URL).replace(/\/$/, "");
  if (!username || !password) {
    throw new Error(SAP_FAILURE);
  }
  return { endpoint, quotationEndpoint, username, password };
}

function readRows(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || !("d" in payload)) {
    throw new Error(SAP_FAILURE);
  }
  const data = (payload as { d?: unknown }).d;
  if (!data || typeof data !== "object") {
    throw new Error(SAP_FAILURE);
  }
  const results = (data as { results?: unknown }).results;
  if (Array.isArray(results)) {
    return results.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  return [data as Record<string, unknown>];
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = Number(textField(row, key));
  return Number.isFinite(value) ? value : 0;
}

function isNumeric(row: Record<string, unknown>, key: string): boolean {
  const raw = textField(row, key).trim();
  return raw !== "" && Number.isFinite(Number(raw));
}

function toItem(row: Record<string, unknown>): SalesItemRecord {
  const rawDate = textField(row, "CreationDate");
  const rawTime = textField(row, "CreationTime");
  return {
    SalesOrder: textField(row, "SalesOrder"),
    SalesOrderItem: textField(row, "SalesOrderItem"),
    CreationDate: parseSapDate(rawDate),
    CreationTime: formatSapTime(rawTime),
    Material: textField(row, "Material"),
    OrderQuantity: numberField(row, "OrderQuantity"),
    OrderQuantityUnit: textField(row, "OrderQuantityUnit") || "EA",
    RequestedQuantity: "RequestedQuantity" in row ? numberField(row, "RequestedQuantity") : undefined,
    NetAmount: numberField(row, "NetAmount"),
    TransactionCurrency: textField(row, "TransactionCurrency") || "UNKNOWN",
    Plant: textField(row, "Plant"),
    CustomerGroup: textField(row, "CustomerGroup"),
    DeliveryStatus: textField(row, "DeliveryStatus") || textField(row, "TotalDeliveryStatus"),
    BillingStatus: textField(row, "BillingStatus") || textField(row, "OrderRelatedBillingStatus"),
  };
}

interface QuotationHubRow {
  quotation: string;
  item: string;
  date: string;
  salesOrder: string;
  quantity: number;
  unit: string;
  net: number;
  plant: string;
  isHeader: boolean;
}

function toQuotationRow(row: Record<string, unknown>): QuotationHubRow {
  const item = textField(row, "QuotationItem").trim();
  const material = textField(row, "QuotationMaterial").trim();
  const parsed = parseSapDate(textField(row, "QuotationDate") || null);
  return {
    quotation: textField(row, "Quotation").replace(/^0+/, ""),
    item,
    date: parsed ? formatInBusinessZone(parsed) : "",
    salesOrder: textField(row, "SalesOrder").replace(/^0+/, "") || textField(row, "FollowOnDocument").replace(/^0+/, ""),
    quantity: numberField(row, "QuotationQuantity"),
    unit: textField(row, "QuotationSalesUnit"),
    net: numberField(row, "QuotationNetValue"),
    plant: textField(row, "QuotationPlant"),
    isHeader: (item === "" || item === "000000") && material === "",
  };
}

async function fetchQuotationHub(filter: string): Promise<QuotationHubRow[]> {
  const { quotationEndpoint, username, password } = sapConfig();
  const headers = {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    Accept: "application/json",
  };
  let url: string | null = `${quotationEndpoint}?$filter=${encodeURIComponent(filter)}&$format=json`;
  const rows: QuotationHubRow[] = [];
  const seen = new Set<string>();

  for (let page = 0; url && page < 30; page += 1) {
    if (seen.has(url)) {
      break;
    }
    seen.add(url);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "network";
      console.error(`[sap] quotation request failed reason=${reason}`);
      throw new Error(SAP_FAILURE);
    }
    if (!response.ok) {
      console.error(`[sap] quotation request failed status=${response.status}`);
      throw new Error(SAP_FAILURE);
    }
    const payload: unknown = await response.json();
    const rawRows = readRows(payload);
    if (rawRows.length > 0 && !("Quotation" in rawRows[0])) {
      throw new Error(SAP_FAILURE);
    }
    rows.push(...rawRows.map(toQuotationRow).filter((row) => row.quotation !== ""));
    const next = (payload as { d?: { __next?: unknown } }).d?.__next;
    url = typeof next === "string" && next !== "" ? next : null;
  }

  return rows;
}

function summarizeQuotations(rows: QuotationHubRow[], label: string, start: string, end: string): SalesPeriodResult {
  const net = Math.round(rows.reduce((sum, row) => sum + row.net, 0) * 100) / 100;
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const byDate = new Map<string, QuotationHubRow[]>();

  for (const row of rows) {
    if (row.date) {
      const day = byDate.get(row.date) ?? [];
      day.push(row);
      byDate.set(row.date, day);
    }
  }

  const orders: UniqueSalesOrder[] = rows
    .map((row) => ({
      salesOrder: row.quotation,
      creationDate: row.date || null,
      creationTime: "",
      items: row.item ? [row.item.replace(/^0+/, "")] : [],
      itemCount: row.isHeader ? 0 : 1,
      quantities: [{ unit: row.unit, quantity: row.quantity }],
      amounts: [{ currency: "USD", amount: Math.round(row.net * 100) / 100 }],
      plants: row.plant ? [row.plant] : [],
      deliveryStatuses: [],
      billingStatuses: [],
      itemRecords: [],
    }))
    .sort((left, right) => left.salesOrder.localeCompare(right.salesOrder, undefined, { numeric: true }));

  const dailySales: DailySalesPoint[] = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayRows]) => ({
      date,
      salesOrders: dayRows.length,
      salesOrderItems: dayRows.filter((row) => !row.isHeader).length,
      quantity: dayRows.reduce((sum, row) => sum + row.quantity, 0),
    }));

  return {
    metric: "sales_orders",
    label,
    start,
    end,
    count: rows.length,
    itemCount: rows.filter((row) => !row.isHeader).length,
    orders,
    quantities: [{ unit: "", quantity }],
    amounts: [{ currency: "USD", amount: net }],
    dailySales,
  };
}

export type SapErrorKind = "timeout" | "network" | "auth" | "server" | "client" | "invalid" | "missing_field" | "config";

/** Every SAP failure surfaces to users as the same safe message; `kind` is for logs, audit, and tests. */
export class SapError extends Error {
  constructor(
    readonly kind: SapErrorKind,
    readonly status?: number,
  ) {
    super(SAP_FAILURE);
    this.name = "SapError";
  }
}

export interface NormalizationStats {
  rawRows: number;
  records: number;
  duplicates: number;
  invalidDates: number;
  invalidNumbers: number;
  missingCurrency: number;
  pages: number;
  truncated: boolean;
}

export interface SalesFetchResult {
  records: SalesItemRecord[];
  stats: NormalizationStats;
  retrievedAt: string;
  fromCache: boolean;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const REQUIRED_FIELDS = ["SalesOrder", "SalesOrderItem", "CreationDate", "OrderQuantity", "NetAmount", "TransactionCurrency"];
const MAX_PAGES = 60;
let sapFetch: FetchLike = (url, init) => fetch(url, init);
const cache = new Map<string, { expires: number; value: Promise<SalesFetchResult> }>();

/** Test hook: replace the HTTP layer. Pass nothing to restore the real fetch. */
export function setSapFetch(fn?: FetchLike): void {
  sapFetch = fn ?? ((url, init) => fetch(url, init));
  cache.clear();
}

export function clearSapCache(): void {
  cache.clear();
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageWithRetry(url: string, headers: Record<string, string>, filter: string): Promise<{ payload: unknown; attempts: number }> {
  const timeoutMs = numberEnv("SAP_TIMEOUT_MS", 60000);
  const retries = numberEnv("SAP_RETRIES", 2);
  let lastError: SapError = new SapError("network");
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const started = Date.now();
    obs("SAP_REQUEST", { endpoint: "ZI_SalesApi_HUB", filter, attempt });
    let response: Response;
    try {
      response = await sapFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      lastError = new SapError(timedOut ? "timeout" : "network");
      obs("SAP_RESPONSE", { endpoint: "ZI_SalesApi_HUB", status: lastError.kind, ms: Date.now() - started, attempt });
      if (attempt <= retries) {
        obs("SAP_RETRY", { reason: lastError.kind, attempt });
        await sleep(numberEnv("SAP_RETRY_DELAY_MS", 600) * attempt);
        continue;
      }
      throw lastError;
    }
    obs("SAP_RESPONSE", { endpoint: "ZI_SalesApi_HUB", status: response.status, ms: Date.now() - started, attempt });
    if (response.status === 401 || response.status === 403) throw new SapError("auth", response.status);
    if (response.status >= 500 || response.status === 429) {
      lastError = new SapError("server", response.status);
      if (attempt <= retries) {
        obs("SAP_RETRY", { reason: `status ${response.status}`, attempt });
        await sleep(numberEnv("SAP_RETRY_DELAY_MS", 600) * attempt);
        continue;
      }
      throw lastError;
    }
    if (!response.ok) throw new SapError("client", response.status);
    try {
      return { payload: await response.json(), attempts: attempt };
    } catch {
      throw new SapError("invalid", response.status);
    }
  }
  throw lastError;
}

function readSalesRows(payload: unknown): Array<Record<string, unknown>> {
  try {
    return readRows(payload);
  } catch {
    throw new SapError("invalid");
  }
}

async function loadSalesItems(filter: string): Promise<SalesFetchResult> {
  let config: ReturnType<typeof sapConfig>;
  try {
    config = sapConfig();
  } catch {
    throw new SapError("config");
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    Accept: "application/json",
  };
  const started = Date.now();
  let url: string | null = `${config.endpoint}?$filter=${encodeURIComponent(filter)}&$format=json`;
  const seenUrls = new Set<string>();
  const seenKeys = new Set<string>();
  const records: SalesItemRecord[] = [];
  const stats: NormalizationStats = {
    rawRows: 0, records: 0, duplicates: 0, invalidDates: 0, invalidNumbers: 0, missingCurrency: 0, pages: 0, truncated: false,
  };
  let attempts = 0;

  while (url) {
    if (seenUrls.has(url)) break;
    if (stats.pages >= MAX_PAGES) {
      stats.truncated = true;
      break;
    }
    seenUrls.add(url);
    const page = await fetchPageWithRetry(url, headers, filter);
    attempts += page.attempts;
    stats.pages += 1;
    const rawRows = readSalesRows(page.payload);
    if (rawRows.length > 0) {
      const missing = REQUIRED_FIELDS.filter((field) => !(field in rawRows[0]));
      if (missing.length > 0) {
        obs("ERROR", { stage: "field_validation", missing });
        throw new SapError("missing_field");
      }
    }
    for (const row of rawRows) {
      stats.rawRows += 1;
      const item = toItem(row);
      if (!item.SalesOrder) continue;
      const key = `${item.SalesOrder}|${item.SalesOrderItem}`;
      if (seenKeys.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seenKeys.add(key);
      if (!item.CreationDate) stats.invalidDates += 1;
      if (!isNumeric(row, "OrderQuantity") || !isNumeric(row, "NetAmount")) stats.invalidNumbers += 1;
      if (!textField(row, "TransactionCurrency")) stats.missingCurrency += 1;
      records.push(item);
    }
    const next = (page.payload as { d?: { __next?: unknown } }).d?.__next;
    url = typeof next === "string" && next !== "" ? next : null;
  }

  stats.records = records.length;
  currentAudit()?.sapCalls.push({
    endpoint: "ZI_SalesApi_HUB",
    filter,
    status: 200,
    rows: records.length,
    pages: stats.pages,
    attempts,
    ms: Date.now() - started,
  });
  lastSapOkAt = new Date().toISOString();
  return { records, stats, retrievedAt: lastSapOkAt, fromCache: false };
}

let lastSapOkAt: string | null = null;

export function sapStatus(): { configured: boolean; lastOkAt: string | null } {
  return {
    configured: Boolean(process.env.SAP_USERNAME?.trim() && process.env.SAP_PASSWORD?.trim()),
    lastOkAt: lastSapOkAt,
  };
}

/**
 * Cached, validated, normalized fetch of Sales item records for an OData filter.
 * Identical filters within SAP_CACHE_TTL_MS reuse one SAP round trip (in-flight requests are shared too).
 */
export async function fetchSalesItems(filter: string): Promise<SalesFetchResult> {
  const ttl = numberEnv("SAP_CACHE_TTL_MS", 120000);
  const now = Date.now();
  const hit = cache.get(filter);
  if (hit && hit.expires > now) {
    obs("SAP_CACHE_HIT", { endpoint: "ZI_SalesApi_HUB", filter });
    const value = await hit.value;
    currentAudit()?.sapCalls.push({ endpoint: "ZI_SalesApi_HUB", filter, status: "cache", rows: value.records.length, pages: 0, attempts: 0, ms: 0 });
    return { ...value, fromCache: true };
  }
  const value = loadSalesItems(filter);
  if (ttl > 0) cache.set(filter, { expires: now + ttl, value });
  try {
    return await value;
  } catch (error) {
    cache.delete(filter);
    throw error;
  }
}

async function fetchSap(filter: string): Promise<SalesItemRecord[]> {
  return (await fetchSalesItems(filter)).records;
}

export function sumAmountsByCurrency(records: SalesItemRecord[]): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    const currency = record.TransactionCurrency || "UNKNOWN";
    totals.set(currency, (totals.get(currency) ?? 0) + record.NetAmount);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

export function sumQuantities(records: SalesItemRecord[]): QuantityTotal[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    const unit = record.OrderQuantityUnit || "EA";
    totals.set(unit, (totals.get(unit) ?? 0) + record.OrderQuantity);
  }
  return [...totals.entries()]
    .map(([unit, quantity]) => ({ unit, quantity }))
    .sort((left, right) => left.unit.localeCompare(right.unit));
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

export function normalizeSalesOrderData(records: SalesItemRecord[]): UniqueSalesOrder[] {
  const grouped = new Map<string, SalesItemRecord[]>();
  for (const record of records) {
    const current = grouped.get(record.SalesOrder) ?? [];
    current.push(record);
    grouped.set(record.SalesOrder, current);
  }

  return [...grouped.entries()]
    .map(([salesOrder, items]) => {
      const firstDated = items.find((item) => item.CreationDate);
      const times = uniqueValues(items.map((item) => item.CreationTime));
      return {
        salesOrder,
        creationDate: firstDated?.CreationDate ? formatInBusinessZone(firstDated.CreationDate) : null,
        creationTime: times[0] ?? "",
        items: uniqueValues(items.map((item) => item.SalesOrderItem)).sort(),
        itemCount: items.length,
        quantities: sumQuantities(items),
        amounts: sumAmountsByCurrency(items),
        plants: uniqueValues(items.map((item) => item.Plant)),
        deliveryStatuses: uniqueValues(items.map((item) => item.DeliveryStatus)),
        billingStatuses: uniqueValues(items.map((item) => item.BillingStatus)),
        itemRecords: items,
      };
    })
    .sort((left, right) => left.salesOrder.localeCompare(right.salesOrder, undefined, { numeric: true }));
}

export function uniqueSalesOrderCount(records: SalesItemRecord[]): number {
  return new Set(records.map((record) => record.SalesOrder)).size;
}

function dailySalesFromOrders(orders: UniqueSalesOrder[]): DailySalesPoint[] {
  const grouped = new Map<string, UniqueSalesOrder[]>();
  for (const order of orders) {
    const date = order.creationDate ?? "";
    const current = grouped.get(date) ?? [];
    current.push(order);
    grouped.set(date, current);
  }
  return [...grouped.entries()]
    .filter(([date]) => date !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayOrders]) => ({
      date,
      salesOrders: dayOrders.length,
      salesOrderItems: dayOrders.reduce((sum, order) => sum + order.itemCount, 0),
      quantity: dayOrders.reduce((sum, order) => sum + order.quantities.reduce((total, entry) => total + entry.quantity, 0), 0),
    }));
}

function summarize(records: SalesItemRecord[], label: string, start: string, end: string): SalesPeriodResult {
  const orders = normalizeSalesOrderData(records);
  return {
    metric: "sales_orders",
    label,
    start,
    end,
    count: uniqueSalesOrderCount(records),
    itemCount: records.length,
    orders,
    quantities: sumQuantities(records),
    amounts: sumAmountsByCurrency(records),
    dailySales: dailySalesFromOrders(orders),
  };
}

export async function getSalesOrdersByDate(startDate: string, endDateInclusive: string, label: string): Promise<SalesPeriodResult> {
  const start = `${startDate}T00:00:00`;
  const end = `${nextCalendarDate(endDateInclusive)}T00:00:00`;
  const filter = `CreationDate ge datetime'${start}' and CreationDate lt datetime'${end}'`;
  console.log(`[sap] ${label}: ${start} <= CreationDate < ${end}`);
  const records = await fetchSap(filter);
  const summary = summarize(records, label, start, end);
  console.log(`[sap] item records=${summary.itemCount} unique sales orders=${summary.count}`);
  return summary;
}

/**
 * Raw normalized item records from the SALES hub (ZI_SalesApi_HUB) for a period.
 * This is the entry point for the analytics engine. CreationDate half-open window.
 */
export async function getSalesItemRecords(period: SalesPeriodName, now = new Date()): Promise<{ records: SalesItemRecord[]; range: DateRange }> {
  const range = getDateRange(period, now);
  const result = await getSalesItemsForRange(range);
  return { records: result.records, range };
}

/** Half-open CreationDate window [start, end) over the Sales hub, validated and normalized. */
export async function getSalesItemsForRange(range: DateRange): Promise<SalesFetchResult> {
  const filter = `CreationDate ge datetime'${range.start}' and CreationDate lt datetime'${range.end}'`;
  return fetchSalesItems(filter);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function prettyDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function monthAnchor(isoDate: string, monthOffset: number): string {
  const [year, month] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  return shifted.toISOString().slice(0, 10);
}

function range(period: SalesPeriodName, startDate: string, endDateExclusive: string, label: string): DateRange {
  return {
    period,
    start: `${startDate}T00:00:00`,
    end: `${endDateExclusive}T00:00:00`,
    startDate,
    endDateExclusive,
    label,
  };
}

export function getDateRange(period: SalesPeriodName, now = new Date()): DateRange {
  const today = businessToday(now).date;
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const thisMonday = shiftDate(today, -((weekday + 6) % 7));
  const thisMonth = `${today.slice(0, 7)}-01`;
  const nextMonth = monthAnchor(today, 1);
  const previousMonth = monthAnchor(today, -1);
  const quarterIndex = Math.floor((month - 1) / 3);
  const thisQuarterStart = `${year}-${String(quarterIndex * 3 + 1).padStart(2, "0")}-01`;
  const nextQuarterStart = quarterIndex === 3 ? `${year + 1}-01-01` : `${year}-${String(quarterIndex * 3 + 4).padStart(2, "0")}-01`;
  const lastQuarterStart = quarterIndex === 0 ? `${year - 1}-10-01` : `${year}-${String(quarterIndex * 3 - 2).padStart(2, "0")}-01`;

  const monthName = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const span = (from: string, toExclusive: string) => `${prettyDate(from)} – ${prettyDate(shiftDate(toExclusive, -1))}`;
  const quarterName = (start: string) => `Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1} ${start.slice(0, 4)}`;

  switch (period) {
    case "TODAY":
      return range(period, today, shiftDate(today, 1), `Today (${prettyDate(today)})`);
    case "YESTERDAY":
      return range(period, shiftDate(today, -1), today, `Yesterday (${prettyDate(shiftDate(today, -1))})`);
    case "THIS_WEEK":
      return range(period, thisMonday, shiftDate(thisMonday, 7), `This Week (${span(thisMonday, shiftDate(thisMonday, 7))})`);
    case "LAST_WEEK":
      return range(period, shiftDate(thisMonday, -7), thisMonday, `Last Week (${span(shiftDate(thisMonday, -7), thisMonday)})`);
    case "THIS_MONTH":
      return range(period, thisMonth, nextMonth, `This Month (${monthName(thisMonth)})`);
    case "LAST_MONTH":
      return range(period, previousMonth, thisMonth, `Last Month (${monthName(previousMonth)})`);
    case "THIS_QUARTER":
      return range(period, thisQuarterStart, nextQuarterStart, `This Quarter (${quarterName(thisQuarterStart)})`);
    case "LAST_QUARTER":
      return range(period, lastQuarterStart, thisQuarterStart, `Last Quarter (${quarterName(lastQuarterStart)})`);
    case "THIS_YEAR":
      return range(period, `${year}-01-01`, `${year + 1}-01-01`, `This Year (${year})`);
    case "LAST_YEAR":
      return range(period, `${year - 1}-01-01`, `${year}-01-01`, `Last Year (${year - 1})`);
  }
}

export async function getSalesOrdersByDateRange(period: SalesPeriodName, now = new Date()): Promise<SalesPeriodResult> {
  const bounds = getDateRange(period, now);
  const inclusiveEnd = shiftDate(bounds.endDateExclusive, -1);
  const filter = `QuotationDate ge datetime'${bounds.startDate}T00:00:00' and QuotationDate le datetime'${inclusiveEnd}T23:59:59'`;
  console.log(`[sap] ${period}: ${bounds.startDate} <= QuotationDate <= ${inclusiveEnd}`);
  const records = await fetchQuotationHub(filter);
  const summary = summarizeQuotations(records, bounds.label, bounds.start, bounds.end);
  console.log(`[sap] ${period} quotation records=${summary.count} quantity=${summary.quantities[0]?.quantity ?? 0} value=${summary.amounts[0]?.amount ?? 0}`);
  return summary;
}

export async function getTodaySalesOrders(now = new Date()): Promise<TodaySalesOrders> {
  const bounds = getDateRange("TODAY", now);
  const summary = await getSalesOrdersByDateRange("TODAY", now);
  return { ...summary, date: bounds.startDate, todayStart: bounds.start, todayEnd: bounds.end };
}

export async function getYesterdaySalesOrders(now = new Date()): Promise<SalesPeriodResult> {
  return getSalesOrdersByDateRange("YESTERDAY", now);
}

export async function getThisMonthSalesOrders(now = new Date()): Promise<SalesPeriodResult> {
  return getSalesOrdersByDateRange("THIS_MONTH", now);
}

export async function getLastMonthSalesOrders(now = new Date()): Promise<SalesPeriodResult> {
  return getSalesOrdersByDateRange("LAST_MONTH", now);
}

export function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function yesterdayBounds(now = new Date()): { startDate: string; endDate: string } {
  const today = businessToday(now).date;
  const yesterday = shiftDate(today, -1);
  return { startDate: yesterday, endDate: yesterday };
}

export function thisWeekBounds(now = new Date()): { startDate: string; endDate: string } {
  const today = businessToday(now).date;
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return { startDate: shiftDate(today, -daysSinceMonday), endDate: today };
}

export async function getTodaySalesSummary(now = new Date()): Promise<SalesPeriodResult> {
  return getTodaySalesOrders(now);
}

export async function getSalesAmountByCurrency(now = new Date()): Promise<SalesPeriodResult> {
  return getTodaySalesOrders(now);
}

export async function getSalesQuantity(now = new Date()): Promise<SalesPeriodResult> {
  return getTodaySalesOrders(now);
}

export async function getPendingSalesOrders(now = new Date()): Promise<SalesPeriodResult> {
  const week = thisWeekBounds(now);
  const period = await getSalesOrdersByDate(week.startDate, week.endDate, "pending this week");
  const pending = period.orders.filter((order) => order.deliveryStatuses.some((status) => status !== "" && status !== "C"));
  const records = pending.flatMap((order) => order.itemRecords);
  return summarize(records, "pending", period.start, period.end);
}

export function normalizeSalesOrderNumber(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (!digits || digits.length > 12) {
    throw new Error("Enter a sales order number.");
  }
  return digits;
}

export async function getSalesOrderRecords(salesOrder: string): Promise<SalesItemRecord[]> {
  const normalized = normalizeSalesOrderNumber(salesOrder);
  const direct = await fetchSap(`SalesOrder eq '${normalized}'`);
  if (direct.length > 0 || normalized.length >= 10) {
    return direct;
  }
  const padded = await fetchSap(`SalesOrder eq '${normalized.padStart(10, "0")}'`);
  return padded.length > 0 ? padded : direct;
}

export async function getSalesSummary(period: SalesPeriodName = "TODAY", now = new Date()): Promise<SalesPeriodResult> {
  return getSalesOrdersByDateRange(period, now);
}

export async function getSalesOrderById(salesOrder: string): Promise<UniqueSalesOrder | null> {
  return getSalesOrder(salesOrder);
}

export async function getSalesOrder(salesOrder: string): Promise<UniqueSalesOrder | null> {
  const records = await getSalesOrderRecords(salesOrder);
  return normalizeSalesOrderData(records)[0] ?? null;
}

export async function getSalesOrderDetails(salesOrder: string): Promise<UniqueSalesOrder | null> {
  return getSalesOrder(salesOrder);
}

export async function getSalesOrderItems(salesOrder: string): Promise<UniqueSalesOrder | null> {
  return getSalesOrder(salesOrder);
}

export async function getSalesOrderStatus(salesOrder: string): Promise<UniqueSalesOrder | null> {
  return getSalesOrder(salesOrder);
}
