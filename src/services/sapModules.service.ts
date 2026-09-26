import { getDateRange, getSalesOrdersByDate, parseSapDate, shiftDate, type SalesPeriodName, type SalesPeriodResult } from "./sapSales.service";

const SAP_FAILURE = "Unable to retrieve the latest data from SAP.";
const SAP_EMPTY = "No records were found for that request.";

const ENDPOINTS = {
  material: "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZI_MATERIALAPI_HUB_CDS/ZI_MaterialAPI_HUB",
  procurement: "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZBUSINESS_API_SRV/ProcurementDashboardSet",
  coois: "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZC_COOISCOMP_HUB_CDS/ZC_COOISComp_Hub",
  trims: "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZBUSINESS_API_SRV/TRIMS_UTILIZATIONSet",
  fabric: "http://app-prod.evolvclothing.com:8000/sap/opu/odata/sap/ZBUSINESS_API_SRV/FABRIC_UTILIZATIONSet",
};

function authHeader(): string {
  const username = process.env.SAP_USERNAME?.trim() ?? "";
  const password = process.env.SAP_PASSWORD?.trim() ?? "";
  if (!username || !password) {
    throw new Error(SAP_FAILURE);
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
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

async function fetchOData(endpoint: string, filter: string, top = 200): Promise<Array<Record<string, unknown>>> {
  const headers = { Authorization: authHeader(), Accept: "application/json" };
  let url: string | null = `${endpoint}?$filter=${encodeURIComponent(filter)}&$top=${top}&$format=json`;
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (let page = 0; url && page < 8; page += 1) {
    if (seen.has(url)) break;
    seen.add(url);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
    } catch {
      throw new Error(SAP_FAILURE);
    }
    if (!response.ok) {
      console.error(`[sap] module request failed status=${response.status}`);
      throw new Error(SAP_FAILURE);
    }
    const payload: unknown = await response.json();
    rows.push(...readRows(payload));
    const next = (payload as { d?: { __next?: unknown } }).d?.__next;
    url = typeof next === "string" && next !== "" ? next : null;
  }

  return rows;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value);
  const date = parseSapDate(raw);
  if (date) return date.toISOString().slice(0, 10);
  return raw;
}

function line(row: Record<string, unknown>, fields: string[]): string {
  return fields
    .map((field) => {
      const value = text(row, field);
      return value ? `${field}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" | ");
}

function visibleFields(row: Record<string, unknown>, fields: string[]): string[] {
  const chosen = fields.filter((field) => text(row, field));
  if (chosen.length > 0) return chosen;
  return Object.keys(row)
    .filter((key) => key !== "__metadata" && !key.startsWith("__") && text(row, key))
    .slice(0, 6);
}

export interface ModuleReport {
  title: string;
  text: string;
  kpis: Array<{ label: string; value: string }>;
  columns: string[];
  rows: string[][];
}

function columnsFor(rows: Array<Record<string, unknown>>, fields: string[]): string[] {
  const chosen = fields.filter((field) => rows.some((row) => text(row, field)));
  if (chosen.length > 0) return chosen.slice(0, 7);
  const sample = rows[0];
  if (!sample) return [];
  return Object.keys(sample)
    .filter((key) => key !== "__metadata" && !key.startsWith("__"))
    .slice(0, 6);
}

function formatRows(title: string, rows: Array<Record<string, unknown>>, fields: string[]): string {
  const shown = rows.slice(0, 12);
  const body = shown.map((row, index) => `${index + 1}. ${line(row, visibleFields(row, fields)) || "Record returned"}`);
  const more = rows.length > shown.length ? ["", `... and ${(rows.length - shown.length).toLocaleString("en-US")} more records`] : [];
  return [title, "", `Records: ${rows.length.toLocaleString("en-US")}`, "", ...body, ...more].join("\n");
}

function toReport(title: string, rows: Array<Record<string, unknown>>, fields: string[], extra: Array<{ label: string; value: string }> = []): ModuleReport {
  if (rows.length === 0) {
    return { title, text: SAP_EMPTY, kpis: [], columns: [], rows: [] };
  }
  const columns = columnsFor(rows, fields);
  const table = rows.slice(0, 80).map((row) => columns.map((column) => text(row, column) || "—"));
  const kpis = [{ label: "Total records", value: rows.length.toLocaleString("en-US") }, ...extra];
  return { title, text: formatRows(title, rows, fields), kpis, columns, rows: table };
}

async function fetchEither(endpoint: string, field: string, raw: string): Promise<Array<Record<string, unknown>>> {
  const plain = raw.replace(/^0+/, "") || raw;
  const padded = plain.padStart(10, "0");
  const first = await fetchOData(endpoint, `${field} eq '${plain}'`);
  if (first.length > 0 || plain === padded) return first;
  return fetchOData(endpoint, `${field} eq '${padded}'`);
}

export async function getMaterialsByProduct(product: string): Promise<ModuleReport> {
  const rows = await fetchOData(ENDPOINTS.material, `Product eq '${product.replace(/'/g, "''")}'`, 50);
  return toReport(`Material ${product}`, rows, ["Product", "ProductName", "ProductType", "ProductGroup", "Plant", "StorageLocation", "BaseUnit", "Brand"]);
}

export async function getMaterialsByPeriod(period: SalesPeriodName): Promise<ModuleReport> {
  const bounds = getDateRange(period);
  const end = shiftDate(bounds.endDateExclusive, -1);
  const filter = `CreationDate ge datetime'${bounds.startDate}T00:00:00' and CreationDate le datetime'${end}T23:59:59'`;
  const rows = await fetchOData(ENDPOINTS.material, filter, 200);
  const products = new Set(rows.map((row) => text(row, "Product")).filter(Boolean));
  const report = toReport(`Materials created ${bounds.label}`, rows, ["Product", "ProductName", "ProductType", "Plant", "CreationDate"], [
    { label: "Products", value: products.size.toLocaleString("en-US") },
  ]);
  if (report.rows.length > 0) {
    report.text = report.text.replace(
      `Records: ${rows.length.toLocaleString("en-US")}`,
      `Records: ${rows.length.toLocaleString("en-US")}\nProducts: ${products.size.toLocaleString("en-US")}`,
    );
  }
  return report;
}

export async function getProcurement(salesDoc: string): Promise<ModuleReport> {
  const rows = await fetchEither(ENDPOINTS.procurement, "SalesDoc", salesDoc);
  return toReport(`Procurement for sales document ${salesDoc.replace(/^0+/, "")}`, rows, [
    "SalesDoc",
    "ComponentMaterial",
    "ComponentDescription",
    "RequirementQuantity",
    "OpenQuantity",
    "Plant",
    "Unit",
  ]);
}

export async function getBom(salesOrder: string): Promise<ModuleReport> {
  const rows = await fetchEither(ENDPOINTS.coois, "SalesOrder", salesOrder);
  return toReport(`BOM components for sales order ${salesOrder.replace(/^0+/, "")}`, rows, [
    "SalesOrder",
    "Material",
    "MaterialDescription",
    "RequirementQuantity",
    "Component",
    "Plant",
    "OrderQuantity",
  ]);
}

export async function getTrims(salesOrder: string): Promise<ModuleReport> {
  const rows = await fetchEither(ENDPOINTS.trims, "SalesOrder", salesOrder);
  return toReport(`Trims utilization for sales order ${salesOrder.replace(/^0+/, "")}`, rows, [
    "SalesOrder",
    "Material",
    "MaterialDescription",
    "RequirementQuantity",
    "IssuedQuantity",
    "BalanceQuantity",
    "Unit",
  ]);
}

export async function getFabric(salesOrder: string): Promise<ModuleReport> {
  const rows = await fetchEither(ENDPOINTS.fabric, "SalesOrder", salesOrder);
  return toReport(`Fabric utilization for sales order ${salesOrder.replace(/^0+/, "")}`, rows, [
    "SalesOrder",
    "Material",
    "MaterialDescription",
    "RequirementQuantity",
    "IssuedQuantity",
    "BalanceQuantity",
    "Unit",
  ]);
}

export async function getSalesCreated(period: SalesPeriodName): Promise<SalesPeriodResult> {
  const bounds = getDateRange(period);
  const end = shiftDate(bounds.endDateExclusive, -1);
  return getSalesOrdersByDate(bounds.startDate, end, bounds.label);
}

export function moduleFailure(): string {
  return SAP_FAILURE;
}

export function moduleEmpty(): string {
  return SAP_EMPTY;
}
