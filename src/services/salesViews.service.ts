/*
 * Structured views for the Evolv Sales Assistant:
 * dashboard = KPIs + charts, report = full item table, count = KPI summary, comparison = two sales orders.
 * Same business rules as the tools: TAG rows never count, FOC separate, amounts never added across currencies.
 */
import type { SalesItemRecord } from "./sapSales.service";
import type { ChartSpec, StructuredView, ViewSection } from "./salesPlanner.service";
import { canSeeCost } from "./salesAccess.service";
import {
  blockWord,
  dataNotes,
  deliveryWord,
  displayDate,
  incompleteFields,
  isFoc,
  isoInZone,
  isRegular,
  isTag,
  loadItems,
  loadOrderItems,
  matchesStatus,
  orderNumber,
  processWord,
  STATUS_LABEL,
  type SalesFilters,
  type StatusType,
} from "./salesAssistantTools.service";

export type SalesViewMode = "dashboard" | "report" | "count" | "pdf";

export interface ViewPeriod {
  from: string;
  to: string;
  label: string;
}

export interface SalesViewResult {
  message: string;
  view?: StructuredView;
}

const REPORT_ROW_LIMIT = 2000;
const SOURCE = "SAP S/4HANA · Sales order items (ZI_SalesApi_HUB)";

export function viewModeFrom(text: string): SalesViewMode | null {
  if (/\bpdf\b/.test(text)) return "pdf";
  if (/\b(dashboard|charts?|graphs?|visual|visuali[sz]e|visualization)\b/.test(text)) return "dashboard";
  if (/\b(report|table|tabular|all details|full details|detailed|line items|excel)\b/.test(text)) return "report";
  if (/\b(summary|summarise|summarize|kpis?|key figures|overview|snapshot|scorecard)\b/.test(text)) return "count";
  return null;
}

// ---------------------------------------------------------------------------
// Formatting + aggregation

const amt = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (value: number) => Math.round(value).toLocaleString("en-US");
const round2 = (value: number) => Math.round(value * 100) / 100;

interface CurrencyTotals {
  currency: string;
  orders: number;
  items: number;
  quantity: number;
  net: number;
  tax: number;
  cost: number;
}

function byCurrency(items: SalesItemRecord[]): CurrencyTotals[] {
  const map = new Map<string, CurrencyTotals & { set: Set<string> }>();
  for (const item of items) {
    const key = item.TransactionCurrency || "UNKNOWN";
    if (!map.has(key)) map.set(key, { currency: key, orders: 0, items: 0, quantity: 0, net: 0, tax: 0, cost: 0, set: new Set() });
    const entry = map.get(key)!;
    entry.set.add(item.SalesOrder);
    entry.items += 1;
    entry.quantity += item.OrderQuantity;
    entry.net += item.NetAmount;
    entry.tax += item.TaxAmount ?? 0;
    entry.cost += item.CostAmount ?? 0;
  }
  return [...map.values()]
    .map(({ set, ...rest }) => ({ ...rest, orders: set.size, net: round2(rest.net), tax: round2(rest.tax), cost: round2(rest.cost) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function moneyList(rows: CurrencyTotals[], pick: (row: CurrencyTotals) => number): string {
  return rows.length ? rows.map((row) => `${row.currency} ${amt(pick(row))}`).join(", ") : "—";
}

function sumBy<T>(list: T[], key: (entry: T) => string, value: (entry: T) => number): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const entry of list) map.set(key(entry), (map.get(key(entry)) ?? 0) + value(entry));
  return [...map.entries()];
}

function top(entries: Array<[string, number]>, n: number): Array<[string, number]> {
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function bar(title: string, entries: Array<[string, number]>, name: string): ChartSpec {
  return { title, kind: "bar", labels: entries.map(([label]) => label), series: [{ name, values: entries.map(([, value]) => round2(value)) }] };
}

function donut(title: string, entries: Array<[string, number]>, name: string): ChartSpec {
  const kept = entries.filter(([, value]) => value > 0);
  return { title, kind: "donut", labels: kept.map(([label]) => label), series: [{ name, values: kept.map(([, value]) => round2(value)) }] };
}

const DELIVERY_ORDER = ["Delivered", "Partially delivered", "Open", "Not relevant"];

function deliveryMix(items: SalesItemRecord[]): Array<[string, number]> {
  const counts = new Map(sumBy(items, (item) => deliveryWord(item.DeliveryStatus), () => 1));
  return DELIVERY_ORDER.map((word) => [word, counts.get(word) ?? 0] as [string, number]);
}

function kpisFor(items: SalesItemRecord[], scope: "period" | "order"): Array<{ label: string; value: string }> {
  const regular = items.filter(isRegular);
  const foc = items.filter(isFoc);
  const totals = byCurrency(regular);
  const orders = new Set(regular.map((item) => item.SalesOrder)).size;
  const blocked = regular.filter((item) => item.DeliveryBlockStatus === "C" || item.BillingBlockStatus === "C").length;
  const delivered = regular.filter((item) => item.DeliveryStatus === "C").length;
  const partial = regular.filter((item) => item.DeliveryStatus === "B").length;
  const pending = regular.filter((item) => item.DeliveryStatus === "A").length;
  const confirmed = regular.reduce((sum, item) => sum + (item.ConfirmedOrderQuantity ?? 0), 0);
  const returns = regular.filter((item) => item.IsReturnsItem);
  return [
    ...(scope === "period" ? [{ label: "Sales orders", value: orders.toLocaleString("en-US") }] : []),
    { label: "Items", value: regular.length.toLocaleString("en-US") },
    { label: "Quantity", value: `${qty(regular.reduce((sum, item) => sum + item.OrderQuantity, 0))} EA` },
    { label: scope === "order" ? "Order value" : "Net sales", value: moneyList(totals, (row) => row.net) },
    { label: "Tax", value: moneyList(totals, (row) => row.tax) },
    ...(confirmed > 0 ? [{ label: "Confirmed delivery qty", value: `${qty(confirmed)} EA` }] : []),
    ...(returns.length ? [{ label: "Return items", value: `${returns.length.toLocaleString("en-US")} (${qty(returns.reduce((sum, item) => sum + item.OrderQuantity, 0))} EA)` }] : []),
    { label: "FOC items", value: `${foc.length.toLocaleString("en-US")} (${qty(foc.reduce((sum, item) => sum + item.OrderQuantity, 0))} EA)` },
    { label: "Delivered items", value: delivered.toLocaleString("en-US") },
    { label: "Partially delivered", value: partial.toLocaleString("en-US") },
    { label: "Pending delivery", value: pending.toLocaleString("en-US") },
    { label: "Blocked items", value: blocked.toLocaleString("en-US") },
  ];
}

function currencySection(items: SalesItemRecord[], title = "Totals by currency (regular items)"): ViewSection {
  return {
    title,
    columns: ["Currency", "Orders", "Items", "Quantity", "Net Amount", "Tax"],
    rows: byCurrency(items.filter(isRegular)).map((row) => [row.currency, qty(row.orders), qty(row.items), qty(row.quantity), amt(row.net), amt(row.tax)]),
  };
}

function focSection(items: SalesItemRecord[]): ViewSection | null {
  const foc = items.filter(isFoc);
  if (!foc.length) return null;
  return {
    title: "FOC items (kept out of sales value)",
    columns: ["Currency", "Items", "Quantity", "FOC value", "FOC tax", ...(canSeeCost() ? ["Cost"] : [])],
    rows: byCurrency(foc).map((row) => [row.currency, qty(row.items), qty(row.quantity), amt(row.net), amt(row.tax), ...(canSeeCost() ? [amt(row.cost)] : [])]),
  };
}

function categoryLabel(item: SalesItemRecord): string {
  return isFoc(item) ? "FOC" : item.ItemCategory || "—";
}

function itemNumber(item: SalesItemRecord): string {
  return item.SalesOrderItem.replace(/^0+/, "") || item.SalesOrderItem;
}

function footerFor(columns: string[], items: SalesItemRecord[], label: string): string[] {
  const regular = items.filter(isRegular);
  const currencies = [...new Set(regular.map((item) => item.TransactionCurrency))];
  return columns.map((column, index) => {
    if (index === 0) return label;
    if (column === "Qty") return qty(items.reduce((sum, item) => sum + item.OrderQuantity, 0));
    if (column === "Net Amount" && currencies.length === 1) return amt(regular.reduce((sum, item) => sum + item.NetAmount, 0));
    if (column === "Tax" && currencies.length === 1) return amt(regular.reduce((sum, item) => sum + (item.TaxAmount ?? 0), 0));
    if (column === "Currency" && currencies.length === 1) return currencies[0];
    return "";
  });
}

// ---------------------------------------------------------------------------
// Period views

export async function periodView(mode: SalesViewMode, period: ViewPeriod, filters: SalesFilters, status: StatusType | null, wantsCost: boolean): Promise<SalesViewResult> {
  const raw = (await loadItems(period.from, period.to, filters)).filter((item) => !isTag(item));
  const items = status ? raw.filter((item) => matchesStatus(item, status)) : raw;
  const statusText = status ? ` · ${STATUS_LABEL[status]}` : "";
  const scopeText = [
    filters.plant ? `Plant ${([] as string[]).concat(filters.plant).join(", ")}` : "",
    filters.currency ?? "",
    filters.material_group ?? "",
    filters.material ? `Material ${filters.material}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const titleBase = `Sales ${mode === "dashboard" ? "dashboard" : mode === "count" ? "summary" : "report"}${statusText} — ${period.label}${scopeText ? ` · ${scopeText}` : ""}`;

  if (!items.length) {
    return { message: `No records found for ${period.label}${statusText ? ` (${STATUS_LABEL[status!].toLowerCase()})` : ""}${scopeText ? `, ${scopeText}` : ""}. Try another date or order number?` };
  }

  const regular = items.filter(isRegular);
  const orders = new Set(regular.map((item) => item.SalesOrder)).size;
  const quantity = regular.reduce((sum, item) => sum + item.OrderQuantity, 0);
  const headline = `${period.label}: ${orders.toLocaleString("en-US")} orders, ${regular.length.toLocaleString("en-US")} sales items, ${qty(quantity)} units.`;
  const notes = dataNotes(items);
  const foc = items.filter(isFoc).length;
  if (foc) notes.unshift(`${foc} FOC item(s) excluded from sales value.`);
  const note = [headline, ...notes].join(" ");
  const base = { kpis: kpisFor(items, "period"), source: SOURCE, updatedAt: new Date().toISOString(), note };

  if (mode === "count") {
    const sections = [currencySection(items), focSection(items)].filter((section): section is ViewSection => Boolean(section));
    return { message: headline, view: { mode: "count", title: titleBase, ...base, columns: [], rows: [], sections } };
  }

  if (mode === "dashboard") {
    const days = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1;
    const trend: ChartSpec =
      days > 62
        ? bar(
            "Quantity by month",
            sumBy(regular, (item) => isoInZone(item.CreationDate).slice(0, 7), (item) => item.OrderQuantity)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([month, value]) => [displayDate(`${month}-01`).slice(3), value] as [string, number]),
            "Quantity",
          )
        : days > 1
        ? (() => {
            const perDay = new Map(sumBy(regular, (item) => isoInZone(item.CreationDate), (item) => item.OrderQuantity));
            const labels: string[] = [];
            const values: number[] = [];
            for (let offset = Math.max(0, days - 62); offset < days; offset += 1) {
              const date = new Date(Date.parse(`${period.from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
              labels.push(displayDate(date).slice(0, 6));
              values.push(perDay.get(date) ?? 0);
            }
            return { title: "Quantity by day", kind: "line" as const, labels, series: [{ name: "Quantity", values }] };
          })()
        : bar(
            "Quantity by hour",
            sumBy(regular, (item) => `${(item.CreationTime || "00").slice(0, 2)}:00`, (item) => item.OrderQuantity).sort(([a], [b]) => a.localeCompare(b)),
            "Quantity",
          );
    const charts: ChartSpec[] = [
      trend,
      bar("Quantity by plant", top(sumBy(regular, (item) => item.Plant || "—", (item) => item.OrderQuantity), 8), "Quantity"),
      bar("Top 8 materials by quantity", top(sumBy(regular, (item) => item.Material || "—", (item) => item.OrderQuantity), 8), "Quantity"),
      bar("Top 8 material groups by quantity", top(sumBy(regular, (item) => item.MaterialGroup || "—", (item) => item.OrderQuantity), 8), "Quantity"),
      donut("Items by delivery status", deliveryMix(regular), "Items"),
      donut("Items by currency", sumBy(regular, (item) => item.TransactionCurrency, () => 1), "Items"),
      donut("Regular vs FOC quantity", [
        ["Regular", quantity],
        ["FOC", items.filter(isFoc).reduce((sum, item) => sum + item.OrderQuantity, 0)],
      ], "Quantity"),
    ];
    const sections = [currencySection(items)];
    return { message: headline, view: { mode: "dashboard", title: titleBase, ...base, columns: [], rows: [], charts, sections } };
  }

  const columns = ["Order", "Item", "Date", "Category", "Material", "Material Group", "Plant", "Qty", "Unit Price", "Net Amount", "Tax", ...(wantsCost ? ["Cost"] : []), "Currency", "Delivery", "Billing", "Block", "Incomplete"];
  const sorted = [...items].sort((a, b) => (a.CreationDate?.getTime() ?? 0) - (b.CreationDate?.getTime() ?? 0) || a.SalesOrder.localeCompare(b.SalesOrder) || a.SalesOrderItem.localeCompare(b.SalesOrderItem));
  const rows = sorted.slice(0, REPORT_ROW_LIMIT).map((item) => [
    orderNumber(item.SalesOrder),
    itemNumber(item),
    displayDate(isoInZone(item.CreationDate)),
    categoryLabel(item),
    item.Material,
    item.MaterialGroup || "—",
    item.Plant || "—",
    qty(item.OrderQuantity),
    amt(item.NetPriceAmount ?? 0),
    amt(item.NetAmount),
    amt(item.TaxAmount ?? 0),
    ...(wantsCost ? [amt(item.CostAmount ?? 0)] : []),
    item.TransactionCurrency,
    deliveryWord(item.DeliveryStatus),
    processWord(item.BillingStatus),
    blockWord(item),
    incompleteFields(item).join(", ") || "—",
  ]);
  if (items.length > REPORT_ROW_LIMIT) base.note = `${note} Showing first ${REPORT_ROW_LIMIT.toLocaleString("en-US")} of ${items.length.toLocaleString("en-US")} items — add a plant, material or date filter to narrow down.`;
  const sections = [currencySection(items), focSection(items)].filter((section): section is ViewSection => Boolean(section));
  return {
    message: headline,
    view: { mode: mode === "pdf" ? "pdf" : "report", title: titleBase, ...base, columns, rows, footer: footerFor(columns, sorted, `Total (${items.length} items)`), sections },
  };
}

// ---------------------------------------------------------------------------
// Order views

function orderItemRows(items: SalesItemRecord[], wantsCost: boolean): { columns: string[]; rows: string[][] } {
  const columns = [
    "Item",
    "Category",
    "Material",
    "Material Group",
    "Plant",
    "Qty",
    "Confirmed",
    "Unit Price",
    "Net Amount",
    "Tax",
    ...(wantsCost ? ["Cost"] : []),
    "Currency",
    "Delivery",
    "Billing",
    "Confirmation",
    "Block",
    "Incomplete",
    "Billing Date",
    "Route",
    "Shipping Point",
  ];
  const rows = items.map((item) => [
    itemNumber(item),
    categoryLabel(item),
    item.Material,
    item.MaterialGroup || "—",
    item.Plant || "—",
    qty(item.OrderQuantity),
    qty(item.ConfirmedQuantity ?? 0),
    amt(item.NetPriceAmount ?? 0),
    amt(item.NetAmount),
    amt(item.TaxAmount ?? 0),
    ...(wantsCost ? [amt(item.CostAmount ?? 0)] : []),
    item.TransactionCurrency,
    deliveryWord(item.DeliveryStatus),
    processWord(item.BillingStatus),
    item.DeliveryConfirmationStatus === "C" ? "Confirmed" : item.DeliveryConfirmationStatus === "A" ? "Not confirmed" : "Not relevant",
    blockWord(item),
    incompleteFields(item).join(", ") || "—",
    item.BillingDocumentDate ? displayDate(isoInZone(item.BillingDocumentDate)) : "—",
    item.Route || "—",
    item.ShippingPoint || "—",
  ]);
  return { columns, rows };
}

export async function orderView(mode: SalesViewMode, salesOrder: string, wantsCost: boolean): Promise<SalesViewResult> {
  const all = await loadOrderItems(salesOrder);
  if (!all.length) return { message: `No records found for order \`${salesOrder}\`. Try another order number?` };
  const items = all.filter((item) => !isTag(item));
  const id = orderNumber(all[0].SalesOrder);
  const regular = items.filter(isRegular);
  const totals = byCurrency(regular);
  const created = items.map((item) => isoInZone(item.CreationDate)).filter(Boolean).sort()[0];
  const plants = [...new Set(items.map((item) => item.Plant).filter(Boolean))];
  const headline = `Order \`${id}\`${created ? ` (created ${displayDate(created)}${plants.length ? `, plant ${plants.join(", ")}` : ""})` : ""}: ${regular.length} sales items, value ${moneyList(totals, (row) => row.net)}.`;
  const notes = dataNotes(items);
  const foc = items.filter(isFoc).length;
  if (foc) notes.unshift(`${foc} FOC item(s) kept out of the order value.`);
  const note = [headline.replace(/`/g, ""), ...notes].join(" ");
  const label = mode === "dashboard" ? "dashboard" : mode === "count" ? "summary" : "report";
  const base = { kpis: kpisFor(items, "order"), source: SOURCE, updatedAt: new Date().toISOString(), note };
  const title = `Sales order ${id} — ${label}`;

  if (mode === "count") {
    const sections = [currencySection(items, "Order value by currency (regular items)"), focSection(items)].filter((section): section is ViewSection => Boolean(section));
    return { message: headline, view: { mode: "count", title, ...base, columns: [], rows: [], sections } };
  }
  if (mode === "dashboard") {
    const charts: ChartSpec[] = [
      donut("Items by delivery status", deliveryMix(regular), "Items"),
      bar("Top 10 materials by quantity", top(sumBy(regular, (item) => item.Material || "—", (item) => item.OrderQuantity), 10), "Quantity"),
      bar(
        `Net amount by material group${totals.length === 1 ? ` (${totals[0].currency})` : ""}`,
        top(sumBy(totals.length === 1 ? regular : regular.filter((item) => item.TransactionCurrency === totals[0]?.currency), (item) => item.MaterialGroup || "—", (item) => item.NetAmount), 8),
        "Net amount",
      ),
      donut("Items by block", sumBy(regular, blockWord, () => 1), "Items"),
      donut("Regular vs FOC quantity", [
        ["Regular", regular.reduce((sum, item) => sum + item.OrderQuantity, 0)],
        ["FOC", items.filter(isFoc).reduce((sum, item) => sum + item.OrderQuantity, 0)],
      ], "Quantity"),
    ];
    return { message: headline, view: { mode: "dashboard", title, ...base, columns: [], rows: [], charts } };
  }
  const { columns, rows } = orderItemRows(items, wantsCost);
  const sections = [currencySection(items, "Order value by currency (regular items)"), focSection(items)].filter((section): section is ViewSection => Boolean(section));
  return { message: headline, view: { mode: mode === "pdf" ? "pdf" : "report", title, ...base, columns, rows, footer: footerFor(columns, items, `Total (${items.length} items)`), sections } };
}

// ---------------------------------------------------------------------------
// Compare two orders

interface OrderFacts {
  id: string;
  items: SalesItemRecord[];
  regular: SalesItemRecord[];
  foc: SalesItemRecord[];
  totals: CurrencyTotals[];
  created: string;
  plants: string[];
}

function facts(all: SalesItemRecord[]): OrderFacts {
  const items = all.filter((item) => !isTag(item));
  const regular = items.filter(isRegular);
  return {
    id: orderNumber(all[0].SalesOrder),
    items,
    regular,
    foc: items.filter(isFoc),
    totals: byCurrency(regular),
    created: items.map((item) => isoInZone(item.CreationDate)).filter(Boolean).sort()[0] ?? "",
    plants: [...new Set(items.map((item) => item.Plant).filter(Boolean))],
  };
}

function diffText(a: number, b: number, money = false): string {
  const delta = b - a;
  if (delta === 0) return "0";
  const text = money ? amt(Math.abs(delta)) : qty(Math.abs(delta));
  return `${delta > 0 ? "+" : "−"}${text}`;
}

export async function compareOrdersView(first: string, second: string, mode: SalesViewMode | null, wantsCost: boolean): Promise<SalesViewResult> {
  const [rawA, rawB] = await Promise.all([loadOrderItems(first), loadOrderItems(second)]);
  const missing = [!rawA.length ? first : null, !rawB.length ? second : null].filter(Boolean);
  if (missing.length) return { message: `No records found for order ${missing.map((order) => `\`${order}\``).join(" and ")}. Try another order number?` };
  const a = facts(rawA);
  const b = facts(rawB);
  const count = (list: SalesItemRecord[], fn: (item: SalesItemRecord) => boolean) => list.filter(fn).length;
  const sumQty = (list: SalesItemRecord[]) => list.reduce((sum, item) => sum + item.OrderQuantity, 0);

  const rows: string[][] = [
    ["Created on", a.created ? displayDate(a.created) : "—", b.created ? displayDate(b.created) : "—", ""],
    ["Plant", a.plants.join(", ") || "—", b.plants.join(", ") || "—", ""],
    ["Currency", a.totals.map((row) => row.currency).join(", ") || "—", b.totals.map((row) => row.currency).join(", ") || "—", ""],
    ["Items", String(a.regular.length), String(b.regular.length), diffText(a.regular.length, b.regular.length)],
    ["FOC items", String(a.foc.length), String(b.foc.length), diffText(a.foc.length, b.foc.length)],
    ["Quantity (EA)", qty(sumQty(a.regular)), qty(sumQty(b.regular)), diffText(sumQty(a.regular), sumQty(b.regular))],
  ];
  const currencies = [...new Set([...a.totals, ...b.totals].map((row) => row.currency))].sort();
  for (const currency of currencies) {
    const ta = a.totals.find((row) => row.currency === currency);
    const tb = b.totals.find((row) => row.currency === currency);
    const both = Boolean(ta && tb);
    rows.push([`Net amount (${currency})`, ta ? amt(ta.net) : "—", tb ? amt(tb.net) : "—", both ? diffText(ta!.net, tb!.net, true) : "n/a"]);
    rows.push([`Tax (${currency})`, ta ? amt(ta.tax) : "—", tb ? amt(tb.tax) : "—", both ? diffText(ta!.tax, tb!.tax, true) : "n/a"]);
    if (wantsCost) {
      rows.push([`Cost (${currency})`, ta ? amt(ta.cost) : "—", tb ? amt(tb.cost) : "—", both ? diffText(ta!.cost, tb!.cost, true) : "n/a"]);
      rows.push([`Margin (${currency})`, ta ? amt(ta.net - ta.cost) : "—", tb ? amt(tb.net - tb.cost) : "—", both ? diffText(ta!.net - ta!.cost, tb!.net - tb!.cost, true) : "n/a"]);
    }
  }
  const delivered = (list: SalesItemRecord[]) => count(list, (item) => item.DeliveryStatus === "C");
  const partial = (list: SalesItemRecord[]) => count(list, (item) => item.DeliveryStatus === "B");
  const open = (list: SalesItemRecord[]) => count(list, (item) => item.DeliveryStatus === "A");
  const blocked = (list: SalesItemRecord[]) => count(list, (item) => item.DeliveryBlockStatus === "C" || item.BillingBlockStatus === "C");
  const incomplete = (list: SalesItemRecord[]) => count(list, (item) => incompleteFields(item).length > 0);
  rows.push(
    ["Delivered items", String(delivered(a.regular)), String(delivered(b.regular)), diffText(delivered(a.regular), delivered(b.regular))],
    ["Partially delivered", String(partial(a.regular)), String(partial(b.regular)), diffText(partial(a.regular), partial(b.regular))],
    ["Open items", String(open(a.regular)), String(open(b.regular)), diffText(open(a.regular), open(b.regular))],
    ["Blocked items", String(blocked(a.regular)), String(blocked(b.regular)), diffText(blocked(a.regular), blocked(b.regular))],
    ["Incomplete items", String(incomplete(a.regular)), String(incomplete(b.regular)), diffText(incomplete(a.regular), incomplete(b.regular))],
    [
      "Material groups",
      String(new Set(a.regular.map((item) => item.MaterialGroup)).size),
      String(new Set(b.regular.map((item) => item.MaterialGroup)).size),
      "",
    ],
  );

  const materialsA = new Map(sumBy(a.regular, (item) => item.Material, (item) => item.OrderQuantity));
  const materialsB = new Map(sumBy(b.regular, (item) => item.Material, (item) => item.OrderQuantity));
  const common = [...materialsA.keys()].filter((material) => materialsB.has(material));
  const sections: ViewSection[] = [];
  if (common.length) {
    sections.push({
      title: `Common materials (${common.length})`,
      columns: ["Material", `Qty ${a.id}`, `Qty ${b.id}`, "Difference"],
      rows: common
        .sort((x, y) => (materialsB.get(y)! + materialsA.get(y)!) - (materialsB.get(x)! + materialsA.get(x)!))
        .slice(0, 50)
        .map((material) => [material, qty(materialsA.get(material)!), qty(materialsB.get(material)!), diffText(materialsA.get(material)!, materialsB.get(material)!)]),
    });
  }
  if (mode === "report" || mode === "pdf") {
    for (const order of [a, b]) {
      const { columns, rows: itemRows } = orderItemRows(order.items, wantsCost);
      sections.push({ title: `Items of order ${order.id}`, columns, rows: itemRows });
    }
  }

  const sameCurrency = a.totals.length === 1 && b.totals.length === 1 && a.totals[0].currency === b.totals[0].currency;
  const charts: ChartSpec[] = [
    {
      title: "Items by delivery status",
      kind: "bar",
      labels: ["Delivered", "Partial", "Open", "Blocked"],
      series: [
        { name: a.id, values: [delivered(a.regular), partial(a.regular), open(a.regular), blocked(a.regular)] },
        { name: b.id, values: [delivered(b.regular), partial(b.regular), open(b.regular), blocked(b.regular)] },
      ],
    },
    {
      title: "Quantity (EA)",
      kind: "bar",
      labels: ["Regular", "FOC"],
      series: [
        { name: a.id, values: [sumQty(a.regular), sumQty(a.foc)] },
        { name: b.id, values: [sumQty(b.regular), sumQty(b.foc)] },
      ],
    },
    ...(sameCurrency
      ? [
          {
            title: `Net amount (${a.totals[0].currency})`,
            kind: "bar" as const,
            labels: [a.id, b.id],
            series: [{ name: "Net amount", values: [a.totals[0].net, b.totals[0].net] }],
          },
        ]
      : []),
  ];

  const qa = sumQty(a.regular);
  const qb = sumQty(b.regular);
  const headline = `Order \`${a.id}\` vs \`${b.id}\`: ${a.regular.length} vs ${b.regular.length} sales items, ${qty(qa)} vs ${qty(qb)} units${sameCurrency ? `, ${amt(a.totals[0].net)} vs ${amt(b.totals[0].net)} ${a.totals[0].currency}` : ""}.`;
  const notes: string[] = [];
  if (!sameCurrency) notes.push("The orders use different currencies, so amounts are shown per currency and not subtracted across currencies.");
  if (a.foc.length || b.foc.length) notes.push("FOC items are kept out of net amount.");
  return {
    message: headline,
    view: {
      mode: mode === "pdf" ? "pdf" : "comparison",
      title: `Sales order ${a.id} vs ${b.id}`,
      kpis: [
        { label: `Order ${a.id} value`, value: moneyList(a.totals, (row) => row.net) },
        { label: `Order ${b.id} value`, value: moneyList(b.totals, (row) => row.net) },
        { label: "Quantity difference", value: `${diffText(qa, qb)} EA` },
        { label: "Common materials", value: String(common.length) },
      ],
      columns: ["Metric", `Order ${a.id}`, `Order ${b.id}`, `Difference (${b.id} − ${a.id})`],
      rows,
      charts,
      sections,
      source: SOURCE,
      updatedAt: new Date().toISOString(),
      note: [headline.replace(/`/g, ""), ...notes].join(" "),
    },
  };
}
