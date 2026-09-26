import { businessService } from "./business.service";
import type { LowStockResult, PendingOrdersResult, PendingQuotationsResult } from "./business.service";
import {
  businessToday,
  getSalesAmountByCurrency,
  getSalesOrderDetails,
  getSalesOrderItems,
  getSalesOrderStatus,
  getSalesOrdersByDate,
  getSalesQuantity,
  getDateRange,
  getLastMonthSalesOrders,
  getSalesOrdersByDateRange,
  getThisMonthSalesOrders,
  getTodaySalesOrders,
  getTodaySalesSummary,
  getYesterdaySalesOrders,
  SAP_EMPTY,
  sapDataError,
  thisWeekBounds,
  yesterdayBounds,
} from "./sapSales.service";
import type { CurrencyTotal, QuantityTotal, SalesPeriodName, SalesPeriodResult, UniqueSalesOrder } from "./sapSales.service";
import { getBom, getFabric, getMaterialsByPeriod, getMaterialsByProduct, getProcurement, getSalesCreated, getTrims, moduleFailure } from "./sapModules.service";
import type { ModuleReport } from "./sapModules.service";
import { annotateAudit, obs, writeAudit } from "./audit.service";
import { planQuestion } from "./salesLlmPlanner.service";
import {
  buildPlannerContext,
  executePlan,
  followUpSuggestions,
  isWriteRequest,
  logPlan,
  MSG_NEED_INFO,
  MSG_SAP_FAILURE,
  suggestionsForOutcome,
  validateQueryPlan,
} from "./salesPlanner.service";
import type { ReplySuggestion, StructuredView } from "./salesPlanner.service";
import type { SalesItemRecord } from "./sapSales.service";

const SYSTEM_PROMPT = [
  "You are an enterprise SAP AI assistant.",
  "For company/SAP questions, always use the appropriate backend API tool.",
  "Never use mock data when real SAP data is available.",
  "Never invent company data.",
  "Never guess numbers.",
  "For Sales Order counts, count DISTINCT SalesOrder.",
  "For Sales Order Item counts, count item records.",
  "For quantity questions, calculate OrderQuantity.",
  "For amount questions, calculate NetAmount grouped by TransactionCurrency.",
  "For status questions, use the SAP API response.",
  "For date questions, dynamically calculate the requested date range.",
  "If SAP data cannot be retrieved, clearly tell the user that SAP data could not be retrieved.",
  "Always distinguish between Sales Order and Sales Order Item.",
].join("\n");

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type AssistantViewMode = StructuredView["mode"];

export type AssistantView = StructuredView;

export interface AssistantReply {
  message: string;
  view?: AssistantView;
  suggestions?: ReplySuggestion[];
  /** Server-side only: normalized SAP records backing the view, used to build Excel/CSV exports. */
  records?: SalesItemRecord[];
}

function requestedMode(message: string): AssistantViewMode {
  const text = message.toLowerCase();
  if (/\bpdf\b/.test(text)) return "pdf";
  if (/\btable\b/.test(text)) return "table";
  if (/\bdetails?\b/.test(text)) return "details";
  if (/\breport\b/.test(text)) return "report";
  if (/\b(total count|how many|count)\b/.test(text)) return "count";
  return "report";
}

function replyFromReport(message: string, report: ModuleReport, mode: AssistantViewMode): AssistantReply {
  if (report.rows.length === 0) return { message: report.text || message };
  return {
    message: report.text,
    view: { mode, title: report.title, kpis: report.kpis, columns: report.columns, rows: report.rows },
    suggestions: HELP_SUGGESTIONS,
  };
}

function textReply(message: string, suggestions?: ReplySuggestion[]): AssistantReply {
  return suggestions?.length ? { message, suggestions } : { message };
}

const HELP_SUGGESTIONS: ReplySuggestion[] = [
  { label: "Sales today", question: "How many sales orders today?" },
  { label: "Quotations", question: "This month's quotations" },
  { label: "Materials", question: "Materials created this month" },
  { label: "Procurement", question: "View procurement details for a sales order" },
  { label: "BOM", question: "Show BOM components for a sales order" },
  { label: "Trims", question: "Show trims utilization for a sales order" },
];

const NEED_ORDER: ReplySuggestion[] = [
  { label: "Sales order 42003", question: "42003" },
  { label: "Sales order 43002", question: "43002" },
];

function isHelpMessage(message: string): boolean {
  return /^(hi|hai|hello|hey|who are you|what can you do|help)\b/i.test(message.trim());
}

function helpReply(): AssistantReply {
  return textReply(
    "I answer from live SAP across Sales, Quotations, Materials, Procurement, BOM, Trims, and Fabric. Ask for a period, a product code, or a sales document number.",
    HELP_SUGGESTIONS,
  );
}

function needOrderReply(kind: string): AssistantReply {
  return textReply(`Tell me the sales order number for ${kind}.`, NEED_ORDER);
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "getTodaySalesOrderCount",
      description: "Count unique SAP sales orders created today. The count is distinct SalesOrder values, not item rows.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getPendingOrders",
      description: "Get how many orders are currently pending.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getPendingQuotations",
      description: "Get how many quotations are currently pending.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getTodaySalesOrderList",
      description: "List unique SAP sales order numbers created today.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getTodaySalesAmount",
      description: "Sum today's SAP net amounts grouped by currency. Never add different currencies together.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getTodayOrderQuantity",
      description: "Return today's unique sales order count, item record count, and order quantity by unit.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getLowStockProducts",
      description: "Get how many products are low in stock, with product details.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getSalesOrderDetails",
      description: "Get one SAP sales order grouped by SalesOrder, including items, quantity, and net amount by currency.",
      parameters: {
        type: "object",
        properties: {
          salesOrder: { type: "string", description: "Sales order number." },
          view: {
            type: "string",
            enum: ["details", "items", "status"],
            description: "details, items, or status.",
          },
        },
        required: ["salesOrder"],
        additionalProperties: false,
      },
    },
  },
];

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface LlmAssistantMessage {
  content?: string | null;
  tool_calls?: ToolCall[];
}

interface LlmChoice {
  message?: LlmAssistantMessage;
}

export function isLiveAiConfigured(): boolean {
  const key = process.env.AI_API_KEY?.trim();
  return Boolean(key && key !== "your_api_key_here");
}

function readToolArgs(raw: string | undefined): Record<string, unknown> {
  console.log(`[ai] readToolArgs: `, raw);
  if (!raw || raw.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

type SalesIntent =
  | "TODAY_SALES_ORDER_COUNT"
  | "TODAY_SALES_ORDER_LIST"
  | "TODAY_SALES_AMOUNT"
  | "TODAY_ORDER_QUANTITY"
  | "TODAY_ITEM_COUNT"
  | "TODAY_SALES_SUMMARY"
  | "TODAY_SALES_ORDER_DETAILS"
  | "SALES_ORDER_DETAILS"
  | "SALES_ORDER_ITEM_DETAILS"
  | "SALES_ORDER_ITEM_COUNT"
  | "SALES_ORDER_STATUS"
  | "DATE_RANGE_LIST";

async function runApprovedTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  console.log(`[ai] runApprovedTool: `, name, args);
  switch (name) {
    case "getTodaySalesOrderCount": {
      const today = await getTodaySalesOrders();
      return { metric: "today_sales_orders", count: today.count, date: today.date };
    }
    case "getTodaySalesOrderList": {
      const today = await getTodaySalesOrders();
      return { date: today.date, count: today.count, salesOrders: today.orders.map((order) => order.salesOrder) };
    }
    case "getTodaySalesAmount": {
      const today = await getTodaySalesOrders();
      return { date: today.date, count: today.count, amounts: today.amounts };
    }
    case "getTodayOrderQuantity": {
      const today = await getTodaySalesOrders();
      return { date: today.date, salesOrders: today.count, itemRecords: today.itemCount, quantities: today.quantities };
    }
    case "getPendingOrders":
      return businessService.getPendingOrders();
    case "getPendingQuotations":
      return businessService.getPendingQuotations();
    case "getLowStockProducts":
      return businessService.getLowStockProducts();
    case "getSalesOrderDetails": {
      const salesOrder = typeof args.salesOrder === "string" ? args.salesOrder : "";
      const view = args.view === "items" || args.view === "status" ? args.view : "details";
      const order = await getSalesOrderDetails(salesOrder);
      return { view, order };
    }
    default:
      throw new Error(`Rejected unknown tool: ${name}`);
  }
}

function salesOrderFromMessage(message: string): string | null {
  console.log(`[ai] salesOrderFromMessage: `, message);
  const year = businessToday().date.slice(0, 4);
  const matches = [...message.matchAll(/\b(\d{4,12})\b/g)]
    .map((match) => match[1])
    .filter((value) => value !== year);
  return matches.sort((left, right) => right.length - left.length)[0] ?? null;
}

type DateSpan = { startDate: string; endDate: string; label: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function spokenDateSpan(message: string): DateSpan | null {
  const text = message.toLowerCase();
  const today = businessToday().date;
  if (/yesterday/.test(text)) {
    const bounds = yesterdayBounds();
    return { ...bounds, label: "yesterday" };
  }
  if (/this week/.test(text)) {
    const bounds = thisWeekBounds();
    return { ...bounds, label: "this week" };
  }
  const range = text.match(
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\s+(?:and|to|through)\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})(?:\s*,?\s*(\d{4}))?/,
  );
  if (!range) {
    return null;
  }
  const startMonth = MONTHS.indexOf(range[1]) + 1;
  const endMonth = range[4] ? MONTHS.indexOf(range[4]) + 1 : startMonth;
  const year = range[6] || range[3] || today.slice(0, 4);
  const startDate = `${year}-${String(startMonth).padStart(2, "0")}-${range[2].padStart(2, "0")}`;
  const endDate = `${year}-${String(endMonth).padStart(2, "0")}-${range[5].padStart(2, "0")}`;
  return { startDate, endDate, label: `${range[1]} ${range[2]} to ${range[4] ?? range[1]} ${range[5]}` };
}

type SalesMetric = "COUNT" | "ITEM_COUNT" | "QUANTITY" | "AMOUNT" | "SUMMARY" | "LIST" | "DETAILS" | "STATUS" | "CHART";

interface SalesQuery {
  metric: SalesMetric;
  period: SalesPeriodName;
  salesOrder?: string;
}

function periodFromText(text: string): SalesPeriodName | null {
  if (/last year/.test(text)) return "LAST_YEAR";
  if (/this year/.test(text)) return "THIS_YEAR";
  if (/last month/.test(text)) return "LAST_MONTH";
  if (/this month/.test(text)) return "THIS_MONTH";
  if (/last week/.test(text)) return "LAST_WEEK";
  if (/this week/.test(text)) return "THIS_WEEK";
  if (/yesterday/.test(text)) return "YESTERDAY";
  if (/today/.test(text)) return "TODAY";
  return null;
}

function metricFromText(text: string, salesOrder?: string): SalesMetric | null {
  if (/chart/.test(text)) return "CHART";
  if (/report|summary/.test(text)) return "SUMMARY";
  if (/amount|sales value|net amount/.test(text)) return "AMOUNT";
  if (/quantity|how many products/.test(text)) return "QUANTITY";
  if (salesOrder && /status/.test(text)) return "STATUS";
  if (/sales order items|how many items|number of items|items are in/.test(text)) return "ITEM_COUNT";
  if (/detail/.test(text)) return "DETAILS";
  if (/how many sales orders|^how many\??$/.test(text)) return "COUNT";
  if (/which sales orders|show|list|what are/.test(text)) return "LIST";
  if (/\b(sale|sales)\b/.test(text)) return "SUMMARY";
  return null;
}

function parseSalesQuery(message: string): SalesQuery | null {
  const text = message.toLowerCase().trim();
  const salesOrder = salesOrderFromMessage(message) ?? undefined;
  if (salesOrder && /status|item|detail|sales|order/.test(text)) {
    const metric = /status/.test(text) ? "STATUS" : /how many items|items are in|number of items/.test(text) ? "ITEM_COUNT" : "DETAILS";
    return { metric, period: "TODAY", salesOrder };
  }
  const period = periodFromText(text);
  const metric = metricFromText(text);
  if (!metric && !period) return null;
  if (!metric) return null;
  return { metric, period: period ?? "TODAY" };
}

function interpretSales(message: string, history: ChatTurn[]): SalesQuery | null {
  const direct = parseSalesQuery(message);
  const text = message.toLowerCase().trim();
  const previous = [...history].reverse().map((turn) => (turn.role === "user" ? parseSalesQuery(turn.content) : null)).find((query) => query !== null && query !== undefined);
  if (!previous) return direct;
  if (/^how many\??$/.test(text)) {
    return { ...previous, metric: "COUNT", salesOrder: undefined };
  }
  const period = periodFromText(text);
  if (period && /not today|i want|instead|for this|for last/.test(text)) {
    return { ...previous, period, salesOrder: undefined };
  }
  return direct;
}

function detectSalesIntent(message: string): SalesIntent | null {
  console.log(`[ai] detectSalesIntent: `, message);
  const text = message.toLowerCase();
  const order = salesOrderFromMessage(message);

  if (order && /status/.test(text)) {
    return "SALES_ORDER_STATUS";
  }
  if (order && /how many items|number of items|items are in/.test(text)) {
    return "SALES_ORDER_ITEM_COUNT";
  }
  if (order && /item/.test(text)) {
    return "SALES_ORDER_ITEM_DETAILS";
  }
  if (order && /sales|order/.test(text)) {
    return "SALES_ORDER_DETAILS";
  }
  if (spokenDateSpan(message)) {
    return "DATE_RANGE_LIST";
  }
  if (/sales summary|today'?s sales summary/.test(text)) {
    return "TODAY_SALES_SUMMARY";
  }
  if (/amount|sales value|net amount/.test(text)) {
    return "TODAY_SALES_AMOUNT";
  }
  if (/quantity|products were ordered|how many products/.test(text)) {
    return "TODAY_ORDER_QUANTITY";
  }
  if (/sales order items|how many items/.test(text)) {
    return "TODAY_ITEM_COUNT";
  }
  if (/which sales orders|what are today'?s sales orders|show today'?s sales orders|list today'?s sales orders/.test(text)) {
    return "TODAY_SALES_ORDER_LIST";
  }
  if (/how many sales orders/.test(text)) {
    return "TODAY_SALES_ORDER_COUNT";
  }
  if (/detail/.test(text) && /\b(sale|sales|order)\b/.test(text)) {
    return "TODAY_SALES_ORDER_DETAILS";
  }
  if (/\b(sale|sales)\b/.test(text)) {
    return "TODAY_SALES_SUMMARY";
  }
  return null;
}

function identifyBusinessTools(message: string): string[] {
  const text = message.toLowerCase();
  const tools: string[] = [];

  if (/quotation/.test(text)) {
    tools.push("getPendingQuotations");
  }
  if (/low(\s+in)?\s+stock|out of stock|stock level/.test(text)) {
    tools.push("getLowStockProducts");
  }
  if (/pending\s+orders?|orders?\s+(are\s+|is\s+)?pending/.test(text) && !/sales/.test(text)) {
    tools.push("getPendingOrders");
  }

  return tools;
}

function formatDashboardQty(data: SalesPeriodResult): string {
  const quantity = data.quantities.reduce((sum, entry) => sum + entry.quantity, 0);
  return quantity.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function formatDashboardValue(data: SalesPeriodResult): string {
  const amount = data.amounts.reduce((sum, entry) => sum + entry.amount, 0);
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAmounts(amounts: CurrencyTotal[]): string {
  console.log(`[ai] formatAmounts: `, amounts);
  if (amounts.length === 0) {
    return "No net amount was returned.";
  }
  return amounts
    .map((entry) => `${entry.currency}: ${entry.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)
    .join("\n");
}

function formatQuantities(quantities: QuantityTotal[]): string {
  console.log(`[ai] formatQuantities: `, quantities);
  if (quantities.length === 0) {
    return "0";
  }
  return quantities
    .map((entry) => `${entry.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${entry.unit}`)
    .join(", ");
}

function  formatOrder(order: UniqueSalesOrder, view: "details" | "items" | "status"): string {
  console.log(`[ai] formatOrder: `, order, view);
  if (view === "items") {
    const lines = order.itemRecords.map(
      (item) =>
        `- ${item.SalesOrderItem || "—"} | ${item.Material || "—"} | ${item.OrderQuantity} ${item.OrderQuantityUnit} | ${item.NetAmount} ${item.TransactionCurrency}`,
    );
    return [`Sales Order: ${order.salesOrder}`, "", "Items:", ...lines, "", `The order contains ${order.itemCount} item records.`].join("\n");
  }

  if (view === "status") {
    return [
      `Sales Order: ${order.salesOrder}`,
      `Delivery Status: ${order.deliveryStatuses.join(", ") || "—"}`,
      `Billing Status: ${order.billingStatuses.join(", ") || "—"}`,
    ].join("\n");
  }

  const items = order.items.map((item) => `• ${item}`);
  return [
    `Sales Order: ${order.salesOrder}`,
    "",
    `Creation Date: ${order.creationDate || "—"}`,
    `Creation Time: ${order.creationTime || "—"}`,
    "",
    "Items:",
    ...(items.length > 0 ? items : ["• —"]),
    "",
    `Total Items: ${order.itemCount}`,
    `Total Quantity: ${formatQuantities(order.quantities)}`,
    `Net Amount: ${formatAmounts(order.amounts).replaceAll("\n", "; ")}`,
    `Currency: ${order.amounts.map((entry) => entry.currency).join(", ") || "—"}`,
    `Plant: ${order.plants.join(", ") || "—"}`,
    `Delivery Status: ${order.deliveryStatuses.join(", ") || "—"}`,
    `Billing Status: ${order.billingStatuses.join(", ") || "—"}`,
  ].join("\n");
}

function formatOrderCards(data: SalesPeriodResult): string {
  console.log(`[ai] formatOrderCards: `, data);
  if (data.count === 0) {
    return SAP_EMPTY;
  }
  const blocks = data.orders.map((order, index) =>
    [
      `${index + 1}. Sales Order: ${order.salesOrder}`,
      `   Created: ${order.creationTime || "—"}`,
      `   Items: ${order.itemCount}`,
      `   Quantity: ${formatQuantities(order.quantities)}`,
      `   Amount: ${formatAmounts(order.amounts)}`,
      `   Currency: ${order.amounts.map((entry) => entry.currency).join(", ") || "—"}`,
      `   Delivery Status: ${order.deliveryStatuses.join(", ") || "—"}`,
      `   Billing Status: ${order.billingStatuses.join(", ") || "—"}`,
    ].join("\n"),
  );
  return ["Today's Sales Orders", "", ...blocks].join("\n\n");
}

function formatPeriodList(data: SalesPeriodResult, title: string): string {
  console.log(`[ai] formatPeriodList: `, data , title);
  if (data.count === 0) {
    return SAP_EMPTY;
  }
  const lines = data.orders.map((order) => order.salesOrder);
  return [title, "", ...lines, "", `Total: ${data.count.toLocaleString("en-US")} quotations`].join("\n");
}

function formatPeriod(data: SalesPeriodResult, intent: SalesIntent): string {
  if (data.count === 0 && intent !== "TODAY_SALES_AMOUNT") {
    return SAP_EMPTY;
  }
  if (intent === "TODAY_SALES_ORDER_DETAILS") {
    return formatOrderCards(data);
  }
  if (intent === "TODAY_SALES_ORDER_LIST" || intent === "DATE_RANGE_LIST") {
    const title = data.label === "today" ? "Today's Sales Orders" : data.label === "yesterday" ? "Yesterday's Sales Orders" : `Sales Orders Created ${data.label}`;
    return formatPeriodList(data, title);
  }
  if (intent === "TODAY_SALES_AMOUNT") {
    if (data.itemCount === 0) {
      return SAP_EMPTY;
    }
    return ["Sales Amount:", "", formatAmounts(data.amounts)].join("\n");
  }
  if (intent === "TODAY_ORDER_QUANTITY") {
    return `Today's total order quantity is ${formatQuantities(data.quantities)}.`;
  }
  if (intent === "TODAY_SALES_SUMMARY") {
    return [
      "Sales Summary",
      "",
      `Period: ${data.label}`,
      `Quotations: ${data.count.toLocaleString("en-US")}`,
      `Quotation Qty: ${formatDashboardQty(data)}`,
      `Quotation Value: ${formatDashboardValue(data)}`,
    ].join("\n");
  }
  if (intent === "TODAY_ITEM_COUNT") {
    return `There are ${data.itemCount} sales order items created today.`;
  }
  return `Today, ${data.count} unique sales orders were created.`;
}

function formatSalesQuery(data: SalesPeriodResult, query: SalesQuery): string {
  if (data.count === 0) return SAP_EMPTY;
  if (query.metric === "CHART") {
    const lines = data.dailySales.map((point) => `${point.date}: ${point.salesOrders} quotations, ${point.quantity.toLocaleString("en-US")} quantity`);
    return [`Quotation value trend`, "", `Period: ${data.label}`, "", ...lines].join("\n");
  }
  if (query.metric === "SUMMARY" || query.metric === "DETAILS") {
    if (query.metric === "DETAILS") return formatOrderCards(data);
    return formatPeriod(data, "TODAY_SALES_SUMMARY");
  }
  if (query.metric === "LIST") return formatPeriodList(data, query.period === "TODAY" ? "Today's Quotations" : "Quotations");
  if (query.metric === "AMOUNT") return ["Quotation Value:", "", `Period: ${data.label}`, "", formatDashboardValue(data)].join("\n");
  if (query.metric === "QUANTITY") return `Quotation quantity for ${data.label} is ${formatDashboardQty(data)}.`;
  if (query.metric === "ITEM_COUNT") return `There are ${data.count.toLocaleString("en-US")} quotation records for ${data.label}.`;
  const prefix = query.period === "TODAY" ? "Today" : data.label;
  return `${prefix}: ${data.count.toLocaleString("en-US")} quotations.`;
}

function formatToolResult(name: string, result: unknown): string {
  switch (name) {
    case "getPendingOrders": {
      const data = result as PendingOrdersResult;
      return `There are **${data.pendingOrders}** orders pending.`;
    }
    case "getPendingQuotations": {
      const data = result as PendingQuotationsResult;
      return `There are **${data.pendingQuotations}** quotations pending.`;
    }
    case "getLowStockProducts": {
      const data = result as LowStockResult;
      const lines = data.products.map(
        (product) =>
          `- ${product.name} (${product.sku}): ${product.quantityOnHand} on hand, reorder level ${product.reorderLevel}`,
      );
      return [`There are **${data.lowStockProducts}** products low in stock.`, "", ...lines].join("\n");
    }
    default:
      return "I do not have enough information to answer that.";
  }
}

function formatSalesHub(data: SalesPeriodResult): string {
  if (data.count === 0) return SAP_EMPTY;
  return [
    "Sales Orders",
    "",
    `Period: ${data.label}`,
    `Sales Orders: ${data.count.toLocaleString("en-US")}`,
    `Sales Order Items: ${data.itemCount.toLocaleString("en-US")}`,
    `Total Quantity: ${formatQuantities(data.quantities)}`,
    "Sales Amount:",
    formatAmounts(data.amounts),
  ].join("\n");
}

function viewFromPeriod(title: string, data: SalesPeriodResult, mode: AssistantViewMode, kind: "quotation" | "sales"): AssistantView {
  const kpis = kind === "quotation"
    ? [
        { label: "Quotations", value: data.count.toLocaleString("en-US") },
        { label: "Quotation Qty", value: formatQuantities(data.quantities) },
        { label: "Quotation Value", value: formatAmounts(data.amounts).replace(/\n/g, ", ") },
      ]
    : [
        { label: "Sales Orders", value: data.count.toLocaleString("en-US") },
        { label: "Items", value: data.itemCount.toLocaleString("en-US") },
        { label: "Quantity", value: formatQuantities(data.quantities) },
        { label: "Amount", value: formatAmounts(data.amounts).replace(/\n/g, ", ") },
      ];
  const columns = kind === "quotation"
    ? ["Quotation", "Date", "Quantity", "Value", "Plant"]
    : ["Sales Order", "Date", "Items", "Quantity", "Amount", "Plant"];
  const rows = data.orders.slice(0, 80).map((order) => {
    const quantity = order.quantities.reduce((sum, entry) => sum + entry.quantity, 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
    const amount = formatAmounts(order.amounts).replace(/\n/g, ", ");
    return kind === "quotation"
      ? [order.salesOrder, order.creationDate || "—", quantity, amount, order.plants.join(", ") || "—"]
      : [order.salesOrder, order.creationDate || "—", String(order.itemCount), quantity, amount, order.plants.join(", ") || "—"];
  });
  return { mode, title, kpis, columns, rows };
}

function viewFromOrder(order: UniqueSalesOrder, mode: AssistantViewMode): AssistantView {
  const columns = ["Item", "Material", "Quantity", "Amount", "Currency"];
  const rows = order.itemRecords.slice(0, 80).map((item) => [
    item.SalesOrderItem || "—",
    item.Material || "—",
    `${item.OrderQuantity} ${item.OrderQuantityUnit}`,
    item.NetAmount.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    item.TransactionCurrency || "—",
  ]);
  return {
    mode,
    title: `Sales order ${order.salesOrder}`,
    kpis: [
      { label: "Sales order", value: order.salesOrder },
      { label: "Items", value: order.itemCount.toLocaleString("en-US") },
      { label: "Quantity", value: formatQuantities(order.quantities) },
      { label: "Amount", value: formatAmounts(order.amounts).replace(/\n/g, ", ") },
    ],
    columns: rows.length > 0 ? columns : ["Field", "Value"],
    rows: rows.length > 0
      ? rows
      : [
          ["Created", order.creationDate || "—"],
          ["Plant", order.plants.join(", ") || "—"],
          ["Delivery", order.deliveryStatuses.join(", ") || "—"],
          ["Billing", order.billingStatuses.join(", ") || "—"],
        ],
  };
}

async function answerSapModule(message: string, history: ChatTurn[] = []): Promise<AssistantReply | null> {
  const text = message.toLowerCase();
  const order = salesOrderFromMessage(message);
  const period = periodFromText(text) ?? "THIS_MONTH";
  const product = message.match(/\b(?:material|product)\s+([A-Za-z0-9][A-Za-z0-9\-_/]{2,})/i)?.[1];
  const mode = requestedMode(message);
  const lastAssistant = [...history].reverse().find((turn) => turn.role === "assistant")?.content ?? "";
  const pendingModule = /for procurement/i.test(lastAssistant)
    ? "procurement"
    : /for the BOM/i.test(lastAssistant)
      ? "bom"
      : /for trims utilization/i.test(lastAssistant)
        ? "trims"
        : /for fabric utilization/i.test(lastAssistant)
          ? "fabric"
          : null;

  try {
    if (pendingModule && order && !/\b(quotation|material|procurement|bom|coois|trim|fabric)\b/.test(text)) {
      if (pendingModule === "procurement") return replyFromReport(message, await getProcurement(order), mode);
      if (pendingModule === "bom") return replyFromReport(message, await getBom(order), mode);
      if (pendingModule === "trims") return replyFromReport(message, await getTrims(order), mode);
      return replyFromReport(message, await getFabric(order), mode);
    }
    if (/\bquotations?\b/.test(text)) {
      const data = await getSalesOrdersByDateRange(period);
      if (data.count === 0) return textReply(`No quotations were found for ${data.label}.`);
      return {
        message: `Quotations for ${data.label}: ${data.count.toLocaleString("en-US")} quotations.`,
        view: viewFromPeriod(`Quotations ${data.label}`, data, mode, "quotation"),
        suggestions: HELP_SUGGESTIONS,
      };
    }
    if (/\b(trim|trims)\b/.test(text)) {
      if (!order) return needOrderReply("trims utilization");
      return replyFromReport(message, await getTrims(order), mode);
    }
    if (/\bfabric\b/.test(text)) {
      if (!order) return needOrderReply("fabric utilization");
      return replyFromReport(message, await getFabric(order), mode);
    }
    if (/\b(bom|coois|component)\b/.test(text)) {
      if (!order) return needOrderReply("the BOM");
      return replyFromReport(message, await getBom(order), mode);
    }
    if (/\bprocurement\b/.test(text)) {
      if (!order) return needOrderReply("procurement");
      return replyFromReport(message, await getProcurement(order), mode);
    }
    const salesRanking = /\b(top|bottom|highest|lowest|by amount|by quantity|by sales|net amount|revenue)\b/.test(text);
    const salesContext = /\b(sales|sold|by material|per material|materials? (sales|performance))\b/.test(text);
    if (/\b(material|materials)\b/.test(text) && !salesRanking && !salesContext) {
      if (product && !/^\d{4}$/.test(product)) return replyFromReport(message, await getMaterialsByProduct(product), mode);
      if (/\b(created|master|stock|product master|new material)\b/.test(text) || periodFromText(text)) {
        return replyFromReport(message, await getMaterialsByPeriod(period), mode);
      }
      return textReply("Ask for materials created this week or this month, or give a product code.", [
        { label: "This month", question: "Materials created this month" },
        { label: "This week", question: "Materials created this week" },
      ]);
    }
  } catch (error) {
    console.error(`[ai] SAP module failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return textReply(moduleFailure());
  }

  return null;
}

function refusesSql(message: string): boolean {
  return /\b(select|insert|update|delete|drop|alter)\b/i.test(message) && /\b(from|into|table|sql|database)\b/i.test(message);
}

/**
 * Advanced Sales orchestrator: context → intent/plan → validate → controlled tools → analytics → composer.
 * Returns null when the message is not a Sales question so other modules can answer.
 */
export async function answerSales(message: string, history: ChatTurn[], now = new Date()): Promise<AssistantReply | null> {
  if (isWriteRequest(message)) {
    obs("QUERY_PLAN_REJECTED", { reason: "read-only" });
    annotateAudit({ intent: "WRITE_REQUEST" });
    await writeAudit("rejected", "read-only");
    return textReply("The Sales assistant is read-only. I can report on sales data but cannot create, change, or delete it.");
  }
  const context = buildPlannerContext(history.filter((turn) => turn.role === "user").map((turn) => turn.content), now);
  const outcome = await planQuestion(message, context, now);
  const { plan, clarification } = outcome;

  if (!plan) {
    if (!clarification) return null;
    obs("AI_REQUEST", { question: message.slice(0, 200) });
    obs("CLARIFICATION_REQUESTED", { pending: outcome.pending?.kind });
    annotateAudit({ intent: "CLARIFICATION" });
    await writeAudit("clarification");
    return textReply(clarification, suggestionsForOutcome(outcome));
  }

  obs("AI_REQUEST", { question: message.slice(0, 200), planner: outcome.planner });
  obs("INTENT_DETECTED", { intent: plan.intent, entity: plan.entity, metric: plan.metric, output: plan.output, followUp: Boolean(context.lastPlan) });
  annotateAudit({ intent: plan.intent, plan });

  const validation = validateQueryPlan(plan, message);
  if (!validation.valid) {
    obs("QUERY_PLAN_REJECTED", { reason: validation.reason });
    await writeAudit("rejected", validation.reason);
    if (validation.reason === "read-only") {
      return textReply("The Sales assistant is read-only. I can report on sales data but cannot create, change, or delete it.");
    }
    return textReply(MSG_NEED_INFO);
  }
  logPlan("QUERY_PLAN_CREATED", plan, { planner: outcome.planner });
  logPlan("QUERY_PLAN_VALIDATED", plan);

  try {
    const result = await executePlan(plan, now);
    obs("AI_RESPONSE", { output: plan.output, tool: result.tool, hasView: Boolean(result.view), records: result.records?.length ?? 0 });
    await writeAudit(result.view ? "ok" : "empty");
    return { message: result.message, view: result.view, records: result.records, suggestions: followUpSuggestions(plan) };
  } catch (error) {
    const kind = (error as { kind?: string }).kind ?? "unknown";
    obs("ERROR", { stage: "execute", kind, status: (error as { status?: number }).status });
    await writeAudit("error", kind);
    return textReply(MSG_SAP_FAILURE);
  }
}

async function generateDemoReply(message: string, history: ChatTurn[] = []): Promise<AssistantReply> {
  if (refusesSql(message)) {
    return textReply("I cannot execute SQL or query a database. I can answer from approved business functions such as sales orders, pending orders, quotations, and stock levels.");
  }

  const moduleReply = await answerSapModule(message, history);
  if (moduleReply) return moduleReply;

  const salesReply = await answerSales(message, history);
  if (salesReply) return salesReply;

  const tools = identifyBusinessTools(message);
  console.log(`[ai] demo tools: ${tools.join(", ") || "none"}`);

  if (tools.length === 0) {
    if (isHelpMessage(message)) {
      return helpReply();
    }

    return textReply(
      "I do not have enough information to answer that. Ask about sales, quotations, materials, procurement, BOM, trims, or fabric — with a period, product code, or sales order number.",
      HELP_SUGGESTIONS,
    );
  }

  const parts: string[] = [];
  for (const tool of tools) {
    const result = await runApprovedTool(tool);
    parts.push(formatToolResult(tool, result));
  }
  return textReply(parts.join("\n\n"));
}

async function callLlm(messages: LlmMessage[], includeTools: boolean): Promise<LlmAssistantMessage> {
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("AI_API_KEY is not configured");
  }

  const baseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  const body: Record<string, unknown> = {
    model,
    temperature: 0.2,
    messages,
  };

  if (includeTools) {
    body.tools = TOOL_DEFINITIONS;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`[ai] LLM request failed: ${response.status} ${detail.slice(0, 300)}`);
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { choices?: LlmChoice[] };
  const message = payload.choices?.[0]?.message;
  if (!message) {
    throw new Error("LLM response did not include a message");
  }
  return message;
}

async function generateLiveReply(message: string, history: ChatTurn[]): Promise<string> {
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message },
  ];

  for (let round = 0; round < 3; round += 1) {
    const assistantMessage = await callLlm(messages, true);
    const toolCalls = assistantMessage.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const content = assistantMessage.content?.trim();
      if (!content) {
        throw new Error("LLM returned an empty response");
      }
      return content;
    }

    console.log(`[ai] live tools: ${toolCalls.map((call) => call.function.name).join(", ")}`);
    messages.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      let toolContent: string;
      try {
        const result = await runApprovedTool(call.function.name, readToolArgs(call.function.arguments));
        toolContent = JSON.stringify(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Tool execution failed";
        toolContent = JSON.stringify({ error: reason });
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolContent,
      });
    }
  }

  throw new Error("Tool calling did not finish within the allowed rounds");
}

export async function generateReply(message: string, history: ChatTurn[]): Promise<AssistantReply> {
  if (isHelpMessage(message)) {
    return helpReply();
  }

  if (!isLiveAiConfigured()) {
    return generateDemoReply(message, history);
  }

  if (refusesSql(message)) {
    return textReply("I cannot execute SQL or query a database. I can answer from approved business functions such as sales orders, pending orders, quotations, and stock levels.");
  }
  const moduleReply = await answerSapModule(message, history);
  if (moduleReply) return moduleReply;
  const salesReply = await answerSales(message, history);
  if (salesReply) return salesReply;

  try {
    return textReply(await generateLiveReply(message, history));
  } catch (error) {
    console.error(`[ai] live mode failed: ${error instanceof Error ? error.message : "unknown error"}`);
    throw error;
  }
}
