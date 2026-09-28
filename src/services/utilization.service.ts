import type { ChartSpec } from "./salesPlanner.service";
import { fetchOData, moduleEndpoint, type ModuleReport } from "./sapModules.service";
import { getDateRange, getSalesOrdersByDate, shiftDate, type SalesPeriodName } from "./sapSales.service";

export type UtilizationKind = "fabric" | "trims";

interface UtilRow {
  salesOrder: string;
  material: string;
  category: string;
  purchaseOrder: string;
  poLine: string;
  bom: number;
  planned: number;
  production: number;
  po: number;
  grn: number;
  issue: number;
  additionalOrders: string[];
}

interface UtilTotals {
  lines: number;
  materials: number;
  bom: number;
  planned: number;
  production: number;
  po: number;
  grn: number;
  issue: number;
}

const QTY_LABELS = ["BOM", "Planned", "Production", "PO", "GRN", "Issue"];
const QTY_COLORS = ["#0f766e", "#0284c7", "#16a34a", "#d97706", "#7c3aed", "#e11d48"];
const MIX_COLORS = ["#0f766e", "#0284c7", "#7c3aed", "#d97706", "#e11d48", "#16a34a", "#0891b2", "#94a3b8"];
const SUMMARY_ORDER_LIMIT = 600;
const CONCURRENCY = 10;
const CACHE_TTL_MS = Number(process.env.SAP_CACHE_TTL_MS) > 0 ? Number(process.env.SAP_CACHE_TTL_MS) : 120000;

const cache = new Map<string, { at: number; rows: UtilRow[] }>();

const KIND_NAME: Record<UtilizationKind, string> = { fabric: "Fabric", trims: "Trims" };
const KIND_SET: Record<UtilizationKind, string> = { fabric: "FABRIC_UTILIZATIONSet", trims: "TRIMS_UTILIZATIONSet" };

function stripZeros(raw: string): string {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!cleaned) return "";
  return cleaned.replace(/^0+/, "") || "0";
}

function padOrder(raw: string): string {
  const plain = stripZeros(raw);
  return /^\d+$/.test(plain) ? plain.slice(-10).padStart(10, "0") : plain;
}

function qty(value: unknown): number {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function categorizeTrim(material: string): string {
  const mat = material.trim().toUpperCase();
  const has = (...parts: string[]) => parts.some((part) => mat.includes(part));
  if (mat.startsWith("60") || has("BTN", "BUTTON", "LSB")) return "Button";
  if (mat.startsWith("50") || has("ZIP", "FASTENER", "SLIDER")) return "Zipper";
  if (mat.startsWith("70") || has("THR", "THREAD")) return "Thread";
  if (mat.startsWith("30") || has("LBL", "LABEL", "MAL", "CNL", "SIZ", "WCA", "WRL", "SML")) return "Labels";
  if (mat.startsWith("40") || has("PLB", "MTG", "CBD", "BKS", "BFY", "CRP", "HNT", "SLG", "TIP")) return "Packing";
  if (mat.startsWith("80") || has("FUS", "NFU")) return "Lining";
  if (mat.startsWith("90") || has("GTP", "TAPE")) return "Consumables";
  return "Other";
}

function mapRow(row: Record<string, unknown>, kind: UtilizationKind): UtilRow {
  const material = String(row.Material ?? "").trim();
  const additional = [
    ...new Set(
      String(row.GRN_SalesOrders ?? "")
        .split(/[\s,]+/)
        .map(stripZeros)
        .filter(Boolean),
    ),
  ];
  return {
    salesOrder: stripZeros(String(row.SalesOrder ?? "")),
    material,
    category: kind === "trims" ? categorizeTrim(material) : "",
    purchaseOrder: String(row.PurchaseOrder ?? "").trim(),
    poLine: stripZeros(String(row.PO_Item ?? "")),
    bom: qty(row.BOM_QTY),
    planned: qty(row.Planned_Qty),
    production: qty(row.Production_Qty),
    po: qty(row.PO_QTY),
    grn: qty(row.GRN_QTY),
    issue: qty(row.Issue_QTY),
    additionalOrders: additional,
  };
}

async function loadRows(kind: UtilizationKind, salesOrder: string): Promise<UtilRow[]> {
  const padded = padOrder(salesOrder);
  const key = `${kind}:${padded}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const raw = await fetchOData(moduleEndpoint(kind), `SalesOrder eq '${padded.replace(/'/g, "''")}'`, 500);
  const rows = raw.map((row) => mapRow(row, kind));
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** BOM, planned, production and issue are per material (repeated on every PO line); PO and GRN are per line. */
function summarize(rows: UtilRow[]): UtilTotals {
  const totals: UtilTotals = { lines: rows.length, materials: 0, bom: 0, planned: 0, production: 0, po: 0, grn: 0, issue: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    totals.po += row.po;
    totals.grn += row.grn;
    if (!row.material || seen.has(row.material)) continue;
    seen.add(row.material);
    totals.bom += row.bom;
    totals.planned += row.planned;
    totals.production += row.production;
    totals.issue += row.issue;
  }
  totals.materials = seen.size;
  return totals;
}

function addTotals(target: UtilTotals, next: UtilTotals): void {
  target.lines += next.lines;
  target.materials += next.materials;
  target.bom += next.bom;
  target.planned += next.planned;
  target.production += next.production;
  target.po += next.po;
  target.grn += next.grn;
  target.issue += next.issue;
}

function vsBom(value: number, bom: number): string {
  if (bom <= 0) return "";
  return value >= bom ? " (≥ BOM)" : " (< BOM)";
}

function kpisFor(totals: UtilTotals, leading: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  return [
    ...leading,
    { label: "BOM Qty", value: fmt(totals.bom) },
    { label: "Planned", value: fmt(totals.planned) },
    { label: "Production", value: fmt(totals.production) },
    { label: "PO Qty", value: fmt(totals.po) },
    { label: "GRN Qty", value: fmt(totals.grn) },
    { label: "Issue Qty", value: fmt(totals.issue) },
  ];
}

function utilizationChart(totals: UtilTotals, title: string): ChartSpec {
  return {
    title,
    kind: "bar",
    labels: QTY_LABELS,
    colors: QTY_COLORS,
    series: [{ name: "Quantity", values: [totals.bom, totals.planned, totals.production, totals.po, totals.grn, totals.issue].map((v) => Math.round(v * 100) / 100) }],
  };
}

function mixChart(title: string, entries: Array<[string, number]>): ChartSpec | null {
  const sorted = entries.filter(([, value]) => value > 0).sort((left, right) => right[1] - left[1]);
  if (sorted.length === 0) return null;
  const top = sorted.slice(0, 7);
  const other = sorted.slice(7).reduce((sum, [, value]) => sum + value, 0);
  if (other > 0) {
    const existing = top.find(([label]) => label === "Other");
    if (existing) existing[1] += other;
    else top.push(["Other", other]);
  }
  return {
    title,
    kind: "donut",
    labels: top.map(([label]) => label),
    colors: MIX_COLORS,
    series: [{ name: "BOM Qty", values: top.map(([, value]) => Math.round(value * 100) / 100) }],
  };
}

function bomByMaterial(rows: UtilRow[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const row of rows) if (row.material && !map.has(row.material)) map.set(row.material, row.bom);
  return [...map.entries()];
}

function bomByCategory(rows: UtilRow[]): Array<[string, number]> {
  const map = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.salesOrder}|${row.material}`;
    if (!row.material || seen.has(key)) continue;
    seen.add(key);
    map.set(row.category, (map.get(row.category) ?? 0) + row.bom);
  }
  return [...map.entries()];
}

function lineStatus(totals: UtilTotals): string {
  const parts: string[] = [];
  if (totals.bom > 0) {
    const issuePct = Math.round((totals.issue / totals.bom) * 100);
    const productionPct = Math.round((totals.production / totals.bom) * 100);
    parts.push(`Issued ${issuePct}% of BOM`, `production at ${productionPct}% of BOM`);
  }
  if (totals.po > 0) parts.push(`GRN covers ${Math.round((totals.grn / totals.po) * 100)}% of PO`);
  return parts.length ? `${parts.join(", ")}.` : "";
}

export async function getUtilizationReport(kind: UtilizationKind, salesOrder: string): Promise<ModuleReport> {
  const name = KIND_NAME[kind];
  const display = stripZeros(salesOrder);
  const title = `${name} utilization · Sales order ${display}`;
  const rows = await loadRows(kind, salesOrder);
  if (rows.length === 0) {
    return { title, text: `No ${name.toLowerCase()} utilization records were found for sales order ${display}.`, kpis: [], columns: [], rows: [] };
  }

  const totals = summarize(rows);
  const trims = kind === "trims";
  const columns = [
    "S.No",
    "Sales Order",
    "Material",
    ...(trims ? ["Category"] : []),
    "Purchase Order",
    "PO Line",
    "BOM Qty",
    "Planned",
    "Production",
    "PO Qty",
    "GRN Qty",
    "Issue Qty",
    "Additional Sale Orders",
  ];
  const table = rows.map((row, index) => [
    String(index + 1),
    row.salesOrder || "—",
    row.material || "—",
    ...(trims ? [row.category] : []),
    row.purchaseOrder || "—",
    row.poLine || "—",
    fmt(row.bom),
    fmt(row.planned),
    fmt(row.production),
    fmt(row.po),
    fmt(row.grn),
    fmt(row.issue),
    row.additionalOrders.filter((order) => order !== row.salesOrder).join(", ") || "—",
  ]);
  const footer = [
    `Total (${rows.length} lines)`,
    "",
    "",
    ...(trims ? [""] : []),
    "",
    "",
    fmt(totals.bom),
    fmt(totals.planned),
    fmt(totals.production),
    fmt(totals.po),
    fmt(totals.grn),
    fmt(totals.issue),
    "",
  ];

  const charts = [utilizationChart(totals, "Sale Order Quantity Utilization")];
  const mix = trims ? mixChart("Trims BOM Quantity By Category", bomByCategory(rows)) : mixChart("Sales Order BOM Quantity By Material", bomByMaterial(rows));
  if (mix) charts.push(mix);

  const text = [
    `**${name} utilization · Sales order ${display}**`,
    "",
    `- Materials: ${totals.materials} (${rows.length} PO lines)`,
    `- BOM Qty: ${fmt(totals.bom)}`,
    `- Planned: ${fmt(totals.planned)}${vsBom(totals.planned, totals.bom)}`,
    `- Production: ${fmt(totals.production)}${vsBom(totals.production, totals.bom)}`,
    `- PO Qty: ${fmt(totals.po)}${vsBom(totals.po, totals.bom)}`,
    `- GRN Qty: ${fmt(totals.grn)}${vsBom(totals.grn, totals.bom)}`,
    `- Issue Qty: ${fmt(totals.issue)}${vsBom(totals.issue, totals.bom)}`,
    "",
    `Enter another sales order number for ${name.toLowerCase()} utilization, or ask for the ${name.toLowerCase()} dashboard.`,
  ].join("\n");

  return {
    title,
    text,
    kpis: kpisFor(totals, [{ label: "Materials", value: fmt(totals.materials) }]),
    columns,
    rows: table,
    footer,
    charts,
    note: lineStatus(totals),
    source: `SAP ZBUSINESS_API_SRV / ${KIND_SET[kind]}`,
    dashboard: true,
    utilization: {
      kind,
      scope: "order",
      salesOrder: display,
      totals: { orders: 1, ...totals },
      lines: rows,
      ...(mix ? { mix: { title: mix.title, labels: mix.labels, values: mix.series[0].values } } : {}),
    },
  };
}

async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await task(items[index]);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getUtilizationSummary(kind: UtilizationKind, period: SalesPeriodName): Promise<ModuleReport> {
  const name = KIND_NAME[kind];
  const bounds = getDateRange(period);
  const end = shiftDate(bounds.endDateExclusive, -1);
  const sales = await getSalesOrdersByDate(bounds.startDate, end, bounds.label);
  const title = `${name} dashboard · ${bounds.label}`;

  const orders = [...new Set(sales.orders.map((order) => stripZeros(order.salesOrder)).filter(Boolean))]
    .sort((left, right) => Number(right) - Number(left));
  const scanned = orders.slice(0, SUMMARY_ORDER_LIMIT);
  if (scanned.length === 0) {
    return { title, text: `No sales orders were created ${bounds.label}, so there is no ${name.toLowerCase()} utilization to summarize.`, kpis: [], columns: [], rows: [] };
  }

  const results = await mapLimited(scanned, CONCURRENCY, (order) => loadRows(kind, order));
  const failed = results.filter((rows) => rows === null).length;
  const perOrder = scanned
    .map((order, index) => ({ order, rows: results[index] ?? [] }))
    .filter((entry) => entry.rows.length > 0)
    .map((entry) => ({ ...entry, totals: summarize(entry.rows) }));

  if (perOrder.length === 0) {
    const reason = failed === scanned.length ? "SAP did not respond for these orders." : `None of the ${scanned.length} sales orders created ${bounds.label} have ${name.toLowerCase()} records yet.`;
    return { title, text: `${reason} Enter a sales order number for ${name.toLowerCase()} utilization to check a specific order.`, kpis: [], columns: [], rows: [] };
  }

  const grand: UtilTotals = { lines: 0, materials: 0, bom: 0, planned: 0, production: 0, po: 0, grn: 0, issue: 0 };
  for (const entry of perOrder) addTotals(grand, entry.totals);
  perOrder.sort((left, right) => right.totals.bom - left.totals.bom);

  const pct = (value: number, base: number) => (base > 0 ? `${Math.round((value / base) * 100)}%` : "—");
  const columns = ["Sales Order", "Materials", "Lines", "BOM Qty", "Planned", "Production", "PO Qty", "GRN Qty", "Issue Qty", "Issue % of BOM"];
  const table = perOrder.map(({ order, totals }) => [
    order,
    fmt(totals.materials),
    fmt(totals.lines),
    fmt(totals.bom),
    fmt(totals.planned),
    fmt(totals.production),
    fmt(totals.po),
    fmt(totals.grn),
    fmt(totals.issue),
    pct(totals.issue, totals.bom),
  ]);
  const footer = [
    `Total (${perOrder.length} orders)`,
    fmt(grand.materials),
    fmt(grand.lines),
    fmt(grand.bom),
    fmt(grand.planned),
    fmt(grand.production),
    fmt(grand.po),
    fmt(grand.grn),
    fmt(grand.issue),
    pct(grand.issue, grand.bom),
  ];

  const charts = [utilizationChart(grand, `${name} Quantity Utilization`)];
  const mix =
    kind === "trims"
      ? mixChart("Trims BOM Quantity By Category", bomByCategory(perOrder.flatMap((entry) => entry.rows)))
      : mixChart("BOM Quantity By Sales Order", perOrder.map((entry) => [entry.order, entry.totals.bom] as [string, number]));
  if (mix) charts.push(mix);

  const capped = orders.length > scanned.length ? ` (latest ${scanned.length} of ${orders.length})` : "";
  const notes = [
    `Scanned ${scanned.length} sales orders created ${bounds.label}${capped}; ${perOrder.length} have ${name.toLowerCase()} records.`,
    failed > 0 ? `${failed} orders could not be read from SAP.` : "",
    lineStatus(grand),
  ].filter(Boolean);

  const top = perOrder.slice(0, 5).map(({ order, totals }) => `- ${order}: BOM ${fmt(totals.bom)}, issued ${fmt(totals.issue)} (${pct(totals.issue, totals.bom)})`);
  const text = [
    `**${name} dashboard · ${bounds.label}**`,
    "",
    `- Sales orders with ${name.toLowerCase()}: ${perOrder.length}`,
    `- Materials: ${fmt(grand.materials)} (${fmt(grand.lines)} PO lines)`,
    `- BOM Qty: ${fmt(grand.bom)} · Production: ${fmt(grand.production)} · Issue: ${fmt(grand.issue)}`,
    `- PO Qty: ${fmt(grand.po)} · GRN Qty: ${fmt(grand.grn)}`,
    "",
    "**Top orders by BOM**",
    ...top,
    "",
    `Enter a sales order number for ${name.toLowerCase()} utilization to open the full report.`,
  ].join("\n");

  return {
    title,
    text,
    kpis: kpisFor(grand, [
      { label: "Sales Orders", value: fmt(perOrder.length) },
      { label: "Materials", value: fmt(grand.materials) },
    ]),
    columns,
    rows: table,
    footer,
    charts,
    note: notes.join(" "),
    source: `SAP ZBUSINESS_API_SRV / ${KIND_SET[kind]} + ZI_SalesApi_HUB`,
    dashboard: true,
    utilization: {
      kind,
      scope: "summary",
      period: bounds.label,
      totals: { orders: perOrder.length, ...grand },
      lines: perOrder.flatMap((entry) => entry.rows),
      orders: perOrder.map(({ order, totals }) => ({
        salesOrder: order,
        materials: totals.materials,
        lines: totals.lines,
        bom: totals.bom,
        planned: totals.planned,
        production: totals.production,
        po: totals.po,
        grn: totals.grn,
        issue: totals.issue,
      })),
      ...(mix ? { mix: { title: mix.title, labels: mix.labels, values: mix.series[0].values } } : {}),
    },
  };
}
