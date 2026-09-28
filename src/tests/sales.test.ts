/*
 * Sales module unit + failure-mode tests (no network; SAP HTTP is replaced via setSapFetch).
 * Run: npx tsx src/tests/sales.test.ts
 * Live SAP end-to-end cases: npx tsx src/tests/sales.live.test.ts
 */
import "dotenv/config";
process.env.AUDIT_LOG_DISABLED = "1";
process.env.SAP_RETRY_DELAY_MS = "0";
process.env.SAP_CACHE_TTL_MS = "0";

import { answerSales } from "../services/ai.service";
import { runWithAudit, currentAudit } from "../services/audit.service";
import { previousSpec, rangeForSpec, resolvePeriodSpec, validateDateRange } from "../services/dateEngine.service";
import {
  applyFilters,
  buildTrend,
  compareKpis,
  computeKpis,
  distinctSalesOrders,
  groupSales,
  pendingRecords,
  percentChange,
  rankGroups,
  ZERO_BASE_TEXT,
} from "../services/salesAnalytics.service";
import { buildExportDocument, toCsv, toPdf, toXlsx } from "../services/salesExport.service";
import {
  buildPlannerContext,
  MSG_ASK_PERIOD,
  MSG_EMPTY,
  MSG_SAP_FAILURE,
  planFromText,
  suggestionsForOutcome,
  validateQueryPlan,
  type QueryPlan,
} from "../services/salesPlanner.service";
import { businessToday, clearSapCache, fetchSalesItems, getDateRange, SapError, setSapFetch, type SalesItemRecord } from "../services/sapSales.service";
import { resolveSalesAccess, runWithSalesAccess, signSalesToken, verifySalesToken, type SalesAccess } from "../services/salesAccess.service";
import { answerSalesAssistant, salesHelpReply } from "../services/salesAssistant.service";
import { runSalesTool } from "../services/salesAssistantTools.service";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

function record(overrides: Partial<SalesItemRecord>): SalesItemRecord {
  return {
    SalesOrder: "1",
    SalesOrderItem: "10",
    CreationDate: new Date("2026-09-10T00:00:00Z"),
    CreationTime: "10:00:00",
    Material: "MAT-A",
    OrderQuantity: 10,
    OrderQuantityUnit: "EA",
    NetAmount: 100,
    TransactionCurrency: "EUR",
    Plant: "P001",
    CustomerGroup: "CG1",
    DeliveryStatus: "",
    BillingStatus: "",
    ...overrides,
  };
}

function sapRow(order: string, item: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SalesOrder: order,
    SalesOrderItem: item,
    CreationDate: "/Date(1789430400000)/",
    CreationTime: "PT10H00M00S",
    Material: "MAT-A",
    OrderQuantity: "5.000",
    OrderQuantityUnit: "EA",
    NetAmount: "50.00",
    TransactionCurrency: "USD",
    Plant: "P001",
    CustomerGroup: "",
    DeliveryStatus: "A",
    OrderRelatedBillingStatus: "",
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function main(): Promise<void> {
  const fixedNow = new Date("2026-09-25T12:00:00+05:30");

  console.log("Date engine");
  ok("business today (IST)", businessToday(fixedNow).date === "2026-09-25");
  ok("IST rollover: 20:00Z is next day in Kolkata", businessToday(new Date("2026-09-24T20:00:00Z")).date === "2026-09-25");
  const month = getDateRange("THIS_MONTH", fixedNow);
  ok("this month [09-01, 10-01)", month.startDate === "2026-09-01" && month.endDateExclusive === "2026-10-01");
  ok("last month start", getDateRange("LAST_MONTH", fixedNow).startDate === "2026-08-01");
  ok("this quarter start", getDateRange("THIS_QUARTER", fixedNow).startDate === "2026-07-01");
  ok("yesterday", getDateRange("YESTERDAY", fixedNow).startDate === "2026-09-24");
  const range = resolvePeriodSpec("sales from September 1 to September 10", fixedNow);
  ok("custom range", range?.period === "CUSTOM_RANGE" && range.dateRange?.startDate === "2026-09-01" && range.dateRange.endDateExclusive === "2026-09-11", JSON.stringify(range));
  const iso = resolvePeriodSpec("orders 2026-09-01 to 2026-09-05", fixedNow);
  ok("iso range inclusive end", iso?.dateRange?.endDateExclusive === "2026-09-06");
  const day = resolvePeriodSpec("sales on 5 September 2026", fixedNow);
  ok("custom date", day?.period === "CUSTOM_DATE" && day.dateRange?.startDate === "2026-09-05");
  const aug = resolvePeriodSpec("august sales", fixedNow);
  ok("specific month", aug?.period === "SPECIFIC_MONTH" && aug.dateRange?.startDate === "2026-08-01" && aug.dateRange.endDateExclusive === "2026-09-01");
  ok("future month without year → previous year", resolvePeriodSpec("december sales", fixedNow)?.dateRange?.startDate === "2025-12-01");
  const y2025 = resolvePeriodSpec("sales in 2025", fixedNow);
  ok("specific year", y2025?.period === "SPECIFIC_YEAR" && y2025.dateRange?.startDate === "2025-01-01");
  ok("'may I' is not May", resolvePeriodSpec("may i see sales", fixedNow) === null);
  ok("custom beats named", resolvePeriodSpec("this month from sep 1 to sep 3", fixedNow)?.period === "CUSTOM_RANGE");
  ok("invalid calendar date rejected", validateDateRange({ period: "CUSTOM_DATE", dateRange: { startDate: "2026-02-30", endDateExclusive: "2026-03-01" } }) !== null);
  ok("reversed range rejected", validateDateRange({ period: "CUSTOM_RANGE", dateRange: { startDate: "2026-09-10", endDateExclusive: "2026-09-01" } }) !== null);
  ok("over-long range rejected", validateDateRange({ period: "CUSTOM_RANGE", dateRange: { startDate: "2024-01-01", endDateExclusive: "2026-01-01" } }) !== null);
  const prevAug = previousSpec({ period: "SPECIFIC_MONTH", dateRange: { startDate: "2026-08-01", endDateExclusive: "2026-09-01" } }, fixedNow);
  ok("previous of August is July", prevAug.dateRange?.startDate === "2026-07-01" && prevAug.dateRange.endDateExclusive === "2026-08-01");
  const prevRange = previousSpec({ period: "CUSTOM_RANGE", dateRange: { startDate: "2026-09-11", endDateExclusive: "2026-09-21" } }, fixedNow);
  ok("previous custom range same length", prevRange.dateRange?.startDate === "2026-09-01" && prevRange.dateRange.endDateExclusive === "2026-09-11");
  ok("custom label", rangeForSpec({ period: "CUSTOM_RANGE", dateRange: { startDate: "2026-09-01", endDateExclusive: "2026-09-11" } }, fixedNow).label === "September 1, 2026 – September 10, 2026");

  console.log("Query planning");
  const p = (text: string, ctx = {}) => planFromText(text, ctx, fixedNow);
  ok("1 count today", p("How many sales orders today?").plan?.metric === "COUNT" && p("How many sales orders today?").plan?.period === "TODAY");
  ok("2 today summary", p("Today's sales summary").plan?.output === "SUMMARY");
  ok("3 month summary", p("This month's summary").plan?.output === "SUMMARY" && p("This month's summary").plan?.period === "THIS_MONTH");
  ok("4 dashboard", p("This month's dashboard").plan?.output === "DASHBOARD");
  ok("5 daily trend", p("Daily sales orders this month").plan?.output === "CHART");
  const top10 = p("Top 10 materials by quantity this month").plan;
  ok("6 top materials by qty", top10?.groupBy[0] === "MATERIAL" && top10.limit === 10 && top10.sort?.field === "QUANTITY");
  const top5o = p("Top 5 sales orders by amount this month").plan;
  ok("7 top sales orders", top5o?.groupBy[0] === "SALES_ORDER" && top5o.limit === 5 && top5o.sort?.field === "AMOUNT", JSON.stringify(top5o));
  ok("8 by plant", p("Sales by plant this month").plan?.groupBy[0] === "PLANT");
  const byStatus = p("Sales by delivery status").plan;
  ok("9 by delivery status (assumed month)", byStatus?.groupBy[0] === "DELIVERY_STATUS" && byStatus.periodAssumed === true);
  const cmp = p("Compare this month with last month").plan;
  ok("10 compare", cmp?.output === "COMPARISON" && cmp.period === "THIS_MONTH" && cmp.comparePeriod === "LAST_MONTH", JSON.stringify(cmp));
  ok("11 order detail", p("Show sales order 70026657").plan?.salesOrder === "70026657");
  ok("12 order item count", p("How many items are in 70026657?").plan?.metric === "ITEM_COUNT");
  ok("13 report", p("Show this month's sales report").plan?.output === "REPORT");
  const pdf = p("Generate this month's sales report PDF").plan;
  ok("14 report pdf", pdf?.output === "REPORT" && pdf.wantPdf === true);
  ok("year is not a sales order", p("sales in 2025").plan?.salesOrder === undefined);
  const pending = p("show pending sales orders this week").plan;
  ok("pending list", pending?.filters?.pendingOnly === true && pending.groupBy[0] === "SALES_ORDER" && pending.sort?.field === "ITEM_COUNT", JSON.stringify(pending?.sort));
  ok("why → comparison", p("why are sales lower this month?").plan?.explainWhy === true);
  ok("custom range plan", p("sales summary from September 1 to September 10").plan?.dateRange?.startDate === "2026-09-01");

  console.log("Clarification + follow-up context");
  ok("'Show sales.' asks period", p("Show sales.").clarification === MSG_ASK_PERIOD);
  const topCustomers = p("Top customers");
  ok("'Top customers' asks metric", topCustomers.plan === null && /amount, quantity, or number of orders/.test(topCustomers.clarification ?? ""));
  const afterCustomer = buildPlannerContext(["Top customers"], fixedNow);
  const answered = planFromText("by amount", afterCustomer, fixedNow).plan;
  ok("metric answer completes plan", answered?.groupBy[0] === "CUSTOMER_GROUP" && answered.sort?.field === "AMOUNT" && answered.customerRequested === true);
  const afterSales = buildPlannerContext(["Show sales."], fixedNow);
  ok("period answer completes plan", planFromText("this month", afterSales, fixedNow).plan?.output === "SUMMARY");
  ok("count without period asks", p("How many sales orders?").clarification === MSG_ASK_PERIOD);
  ok("period chips offered", suggestionsForOutcome(p("How many sales orders?")).some((item) => item.question === "this month"));
  ok("metric chips offered", suggestionsForOutcome(p("Top customers")).some((item) => item.question === "by amount"));

  const convo = ["How many sales orders today?"];
  const c15 = planFromText("Not today. I want this month.", buildPlannerContext(convo, fixedNow), fixedNow).plan;
  ok("15 period swap keeps metric", c15?.period === "THIS_MONTH" && c15.metric === "COUNT", JSON.stringify(c15));
  convo.push("Not today. I want this month.");
  const c16 = planFromText("Show the top 5 materials", buildPlannerContext(convo, fixedNow), fixedNow).plan;
  ok("16 top 5 materials uses context month", c16?.groupBy[0] === "MATERIAL" && c16.limit === 5 && c16.period === "THIS_MONTH" && !c16.periodAssumed);
  convo.push("Show the top 5 materials");
  const c17 = planFromText("Compare that with last month", buildPlannerContext(convo, fixedNow), fixedNow).plan;
  ok("17 compare that keeps materials", c17?.output === "COMPARISON" && c17.period === "THIS_MONTH" && c17.comparePeriod === "LAST_MONTH" && c17.groupBy[0] === "MATERIAL", JSON.stringify(c17));
  convo.push("Compare that with last month");
  const c18 = planFromText("Make this a PDF", buildPlannerContext(convo, fixedNow), fixedNow).plan;
  ok("18 make this a PDF reuses comparison", c18?.output === "COMPARISON" && c18.wantPdf === true && c18.groupBy[0] === "MATERIAL");

  console.log("Plan validation");
  const valid = p("this month sales summary").plan as QueryPlan;
  ok("valid plan passes", validateQueryPlan(valid, "this month sales summary").valid);
  ok("SQL rejected", !validateQueryPlan(valid, "select * from vbak").valid);
  ok("DELETE rejected", !validateQueryPlan(valid, "delete sales order 123").valid);
  ok("limit > 100 rejected", !validateQueryPlan({ ...valid, limit: 9999 }, "x").valid);
  ok("unknown period rejected", !validateQueryPlan({ ...valid, period: "FOREVER" as never }, "x").valid);
  ok("bad custom range rejected", !validateQueryPlan({ ...valid, period: "CUSTOM_RANGE", dateRange: { startDate: "2026-13-01", endDateExclusive: "2026-13-05" } }, "x").valid);
  ok("unknown filter rejected", !validateQueryPlan({ ...valid, filters: { PASSWORD: ["x"] } as never }, "x").valid);
  ok("injection in filter rejected", !validateQueryPlan({ ...valid, filters: { PLANT: ["P001' or 1 eq 1"] } }, "x").valid);
  ok("unknown groupBy rejected", !validateQueryPlan({ ...valid, groupBy: ["CUSTOMER" as never] }, "x").valid);

  console.log("Analytics metrics");
  const records = [
    record({ SalesOrder: "1", NetAmount: 100, OrderQuantity: 10 }),
    record({ SalesOrder: "1", SalesOrderItem: "20", NetAmount: 50, OrderQuantity: 5 }),
    record({ SalesOrder: "2", NetAmount: 200, OrderQuantity: 20, Material: "MAT-B", Plant: "P002", DeliveryStatus: "B" }),
    record({ SalesOrder: "3", NetAmount: 30, OrderQuantity: 3, TransactionCurrency: "USD", CreationDate: new Date("2026-09-11T00:00:00Z"), DeliveryStatus: "C" }),
  ];
  ok("distinct orders = 3 (not 4 records)", distinctSalesOrders(records) === 3);
  const kpis = computeKpis(records);
  ok("items = 4", kpis.salesOrderItems === 4);
  ok("EUR 350 / USD 30 never merged", kpis.totalAmount.length === 2 && kpis.totalAmount.find((e) => e.currency === "EUR")?.amount === 350 && kpis.totalAmount.find((e) => e.currency === "USD")?.amount === 30);
  ok("avg items/order", kpis.averageItemsPerOrder === Math.round((4 / 3) * 1000) / 1000);
  ok("avg qty/order", kpis.averageQuantityPerOrder === Math.round((38 / 3) * 1000) / 1000);
  ok("avg order value EUR", kpis.averageOrderValue.find((e) => e.currency === "EUR")?.amount === Math.round((350 / 3) * 100) / 100);
  const empty = computeKpis([]);
  ok("divide-by-zero safe", empty.averageItemsPerOrder === 0 && empty.averageQuantityPerOrder === 0 && empty.ordersPerDay === 0);

  console.log("Grouping + ranking + trend");
  ok("two materials", groupSales(records, "MATERIAL").length === 2);
  ok("top material by EUR amount = MAT-B", rankGroups(groupSales(records, "MATERIAL"), "AMOUNT", "DESC", 1, "EUR")[0].key === "MAT-B");
  ok("top by qty = MAT-B", rankGroups(groupSales(records, "MATERIAL"), "QUANTITY", "DESC", 1)[0].key === "MAT-B");
  ok("bottom by qty = MAT-A", rankGroups(groupSales(records, "MATERIAL"), "QUANTITY", "ASC", 1)[0].key === "MAT-A");
  const bySo = groupSales(records, "SALES_ORDER");
  ok("sales order grouping sums items", bySo.find((row) => row.key === "1")?.items === 2);
  const trend = buildTrend(records);
  ok("daily trend distinct orders per day", trend.length === 2 && trend[0].salesOrders === 2 && trend[1].salesOrders === 1);
  ok("status labels", groupSales(records, "DELIVERY_STATUS").some((row) => row.key.startsWith("Partially")));
  ok("pending = orders with A/B items", distinctSalesOrders(pendingRecords(records)) === 1);
  ok("filter by plant", applyFilters(records, { PLANT: ["P002"] }).length === 1);

  console.log("Comparison");
  const cur = { range: getDateRange("THIS_MONTH", fixedNow), kpis: computeKpis(records) };
  const zero = compareKpis(cur, { range: getDateRange("LAST_MONTH", fixedNow), kpis: computeKpis([]) });
  ok("zero previous → exact message", zero.salesOrders.percentText === ZERO_BASE_TEXT && zero.salesOrders.percent === null);
  ok("percent change", percentChange("x", 150, 100).percentText === "+50.0%");
  ok("negative change", percentChange("x", 50, 100).percentText === "-50.0%");
  ok("difference", percentChange("x", 50, 100).difference === -50);

  console.log("Exports");
  const doc = buildExportDocument(
    {
      mode: "report", title: "Sales Report · Test", kpis: [{ label: "Sales Orders", value: "3" }], columns: ["A", "B"], rows: [["=cmd", "(x)"]],
      bullets: ["One — two"], provenance: { source: "SAP_SALES_API", retrievedAt: new Date().toISOString(), period: "Test", recordCount: 4, calculation: "DISTINCT SalesOrder" },
    },
    records,
  );
  ok("excel has Summary/Sales Orders/Sales Items/Daily Trend", ["Summary", "Sales Orders", "Sales Items", "Daily Trend"].every((name) => doc.sheets.some((sheet) => sheet.name === name)));
  ok("orders sheet splits currencies", doc.sheets.find((sheet) => sheet.name === "Sales Orders")!.rows.length === 3);
  const pdfBytes = toPdf(doc);
  ok("pdf header/trailer", pdfBytes.subarray(0, 8).toString("latin1") === "%PDF-1.4" && pdfBytes.toString("latin1").trimEnd().endsWith("%%EOF"));
  ok("pdf escapes parens", pdfBytes.toString("latin1").includes("\\(x\\)"));
  const xlsx = toXlsx(doc.sheets);
  ok("xlsx is a zip", xlsx.subarray(0, 2).toString("latin1") === "PK");
  ok("csv neutralizes formula", toCsv(doc.csv).toString("utf8").includes("'=cmd"));

  console.log("SAP client failure modes (mocked HTTP)");
  const ask = async (question: string) => runWithAudit("test", question, () => answerSales(question, [], fixedNow));

  let calls = 0;
  setSapFetch(async () => {
    calls += 1;
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  });
  const timeout = await ask("This month's summary");
  ok("timeout → safe message", timeout?.message === MSG_SAP_FAILURE, timeout?.message);
  ok("timeout retried (3 attempts)", calls === 3, String(calls));

  calls = 0;
  setSapFetch(async () => {
    calls += 1;
    return json({ error: "unauthorized" }, 401);
  });
  ok("401 → safe message", (await ask("This month's summary"))?.message === MSG_SAP_FAILURE);
  ok("401 not retried", calls === 1, String(calls));
  try {
    await fetchSalesItems("x");
    ok("401 kind auth", false);
  } catch (error) {
    ok("401 kind auth", error instanceof SapError && error.kind === "auth");
  }

  calls = 0;
  setSapFetch(async () => {
    calls += 1;
    return json({ error: "boom" }, 500);
  });
  ok("500 → safe message", (await ask("This month's summary"))?.message === MSG_SAP_FAILURE);
  ok("500 retried", calls === 3, String(calls));

  calls = 0;
  setSapFetch(async () => {
    calls += 1;
    return calls === 1 ? json({}, 503) : json({ d: { results: [sapRow("100", "10")] } });
  });
  const recovered = await ask("This month's summary");
  ok("503 then success recovers", recovered?.view?.kpis[0]?.value === "1", recovered?.message);

  setSapFetch(async () => json({ d: { results: [] } }));
  const emptyReply = await ask("This month's summary");
  ok("empty → exact message", emptyReply?.message.startsWith(MSG_EMPTY) === true, emptyReply?.message);

  setSapFetch(async () => new Response("<html>not json</html>", { status: 200 }));
  ok("invalid JSON → safe message", (await ask("This month's summary"))?.message === MSG_SAP_FAILURE);

  setSapFetch(async () => json({ unexpected: true }));
  ok("invalid structure → safe message", (await ask("This month's summary"))?.message === MSG_SAP_FAILURE);

  setSapFetch(async () => json({ d: { results: [{ SalesOrder: "1", CreationDate: "/Date(1789430400000)/" }] } }));
  ok("missing required field → safe message", (await ask("This month's summary"))?.message === MSG_SAP_FAILURE);

  let page = 0;
  setSapFetch(async () => {
    page += 1;
    return page === 1
      ? json({ d: { results: [sapRow("100", "10"), sapRow("100", "10")], __next: "http://sap/next" } })
      : json({ d: { results: [sapRow("101", "10", { OrderQuantity: "abc", TransactionCurrency: "" })] } });
  });
  const fetched = await fetchSalesItems("pagination-test");
  ok("pagination follows __next", fetched.stats.pages === 2 && fetched.records.length === 2, JSON.stringify(fetched.stats));
  ok("duplicate SalesOrder+Item removed", fetched.stats.duplicates === 1);
  ok("non-numeric counted + zeroed", fetched.stats.invalidNumbers === 1 && fetched.records[1].OrderQuantity === 0);
  ok("missing currency counted", fetched.stats.missingCurrency === 1);

  process.env.SAP_CACHE_TTL_MS = "60000";
  clearSapCache();
  calls = 0;
  setSapFetch(async () => {
    calls += 1;
    return json({ d: { results: [sapRow("100", "10")] } });
  });
  await runWithAudit("t", "q", async () => {
    await Promise.all([fetchSalesItems("cache-test"), fetchSalesItems("cache-test")]);
    const again = await fetchSalesItems("cache-test");
    ok("cache + in-flight dedupe (1 SAP call)", calls === 1 && again.fromCache, String(calls));
    ok("audit records SAP calls", (currentAudit()?.sapCalls.length ?? 0) >= 2);
  });
  process.env.SAP_CACHE_TTL_MS = "0";

  setSapFetch(async () => {
    throw new Error("no network in unit tests");
  });
  const rejected = await ask("delete all sales orders from table");
  ok("write request refused (read-only)", /read-only/.test(rejected?.message ?? ""), rejected?.message);

  console.log("Sales Assistant v2: access, tools, rules");
  const secret = "unit-test-secret-0123456789";
  const token = signSalesToken({ u: "Ravi", r: "user", d: "Sales" }, secret, fixedNow.getTime());
  ok("token verifies", verifySalesToken(token, secret, fixedNow.getTime())?.username === "Ravi");
  ok("tampered token rejected", verifySalesToken(`${token.slice(0, -2)}xx`, secret, fixedNow.getTime()) === null);
  ok("wrong secret rejected", verifySalesToken(token, "another-secret-0123456789", fixedNow.getTime()) === null);
  ok("expired token rejected", verifySalesToken(token, secret, fixedNow.getTime() + 9 * 3600 * 1000) === null);
  ok("unmapped user → sales_user, all plants", (() => {
    const access = resolveSalesAccess({ username: "nobody-here", role: "user" });
    return access.role === "sales_user" && access.plants.includes("*");
  })());
  ok("portal admin → admin", resolveSalesAccess({ username: "x", role: "admin" }).role === "admin");

  const salesUser: SalesAccess = { role: "sales_user", plants: ["P002"], username: "t", source: "token" };
  const manager: SalesAccess = { role: "manager", plants: ["*"], username: "m", source: "token" };
  const v2Rows = [
    sapRow("4645", "10", { Plant: "P002", TransactionCurrency: "EUR", SalesOrderItemCategory: "ZTAN", NetAmount: "100.00", CostAmount: "40.00", TaxAmount: "5.00" }),
    sapRow("4645", "20", { Plant: "P002", TransactionCurrency: "EUR", SalesOrderItemCategory: "ZFOC", NetAmount: "7.00", TaxAmount: "1.00", CostAmount: "3.00" }),
    sapRow("4645", "30", { Plant: "P002", TransactionCurrency: "EUR", SalesOrderItemCategory: "TAG", SalesOrderItemType: "B", NetAmount: "0.00", OrderQuantity: "99" }),
    sapRow("5000", "10", { Plant: "P003", TransactionCurrency: "INR", SalesOrderItemCategory: "ZTAN", NetAmount: "900.00" }),
    sapRow("6000", "10", { Plant: "P002", TransactionCurrency: "USD", SalesOrderItemCategory: "ZFOC", NetAmount: "0.00" }),
  ];
  setSapFetch(async (url) => {
    const order = /SalesOrder eq '(\w+)'/.exec(decodeURIComponent(String(url)))?.[1];
    return json({ d: { results: order ? v2Rows.filter((row) => row.SalesOrder === order) : v2Rows } });
  });
  const v2Range = { date_from: "2026-09-01", date_to: "2026-09-25" };

  const managerSummary = (await runWithSalesAccess(manager, () => runSalesTool("get_sales_summary", v2Range, fixedNow))) as Record<string, any>;
  ok("summary excludes TAG + FOC from items", managerSummary.item_count === 2, String(managerSummary.item_count));
  ok("summary counts FOC-only orders", managerSummary.foc_only_order_count === 1, String(managerSummary.foc_only_order_count));
  ok("summary has envelope", typeof managerSummary.data_as_of === "string" && Array.isArray(managerSummary.warnings) && managerSummary.row_count === 5);
  ok("manager sees cost", managerSummary.by_currency.some((row: any) => row.cost_amount === 40));
  ok("FOC value/tax reported separately", managerSummary.foc.by_currency.some((row: any) => row.foc_value === 7 && row.foc_tax === 1));

  const userSummary = (await runWithSalesAccess(salesUser, () => runSalesTool("get_sales_summary", v2Range, fixedNow))) as Record<string, any>;
  ok("sales_user: other plant hidden", userSummary.item_count === 1 && !userSummary.by_currency.some((row: any) => row.currency === "INR"), JSON.stringify(userSummary.by_currency));
  ok("sales_user: cost stripped", !/"(cost_amount|margin|cost)":/.test(JSON.stringify(userSummary)));
  let plantError = "";
  await runWithSalesAccess(salesUser, () => runSalesTool("get_sales_summary", { ...v2Range, filters: { plant: "P003" } }, fixedNow)).catch((error: Error) => (plantError = error.message));
  ok("sales_user: other plant filter refused", /No access to plant P003/.test(plantError), plantError);
  let costError = "";
  await runWithSalesAccess(salesUser, () => runSalesTool("top_n", { ...v2Range, metric: "cost_amount", dimension: "material" }, fixedNow)).catch((error: Error) => (costError = error.message));
  ok("sales_user: cost ranking refused", /not available/.test(costError), costError);
  let rangeError = "";
  await runSalesTool("get_sales_summary", { date_from: "2026-07-01", date_to: "2026-09-25" }, fixedNow).catch((error: Error) => (rangeError = error.message));
  ok("range over 31 days refused", /31 days/.test(rangeError), rangeError);
  const compared = (await runWithSalesAccess(manager, () => runSalesTool("compare_periods", { period_a: v2Range, period_b: { date_from: "2026-08-01", date_to: "2026-08-25" } }, fixedNow))) as Record<string, any>;
  ok("compare_periods returns differences", typeof compared.totals?.item_count?.difference === "number" && Array.isArray(compared.by_currency));
  const search = (await runWithSalesAccess(manager, () => runSalesTool("search_material", { text: "mat-a" }, fixedNow))) as Record<string, any>;
  ok("search_material finds partial code", search.total_matches >= 1 && search.matches[0].material === "MAT-A");

  const orderOther = await runWithSalesAccess(salesUser, () => runSalesTool("get_order_details", { sales_order: "5000" }, fixedNow).catch(() => null));
  ok("sales_user: order of other plant not revealed", (orderOther as { found?: boolean } | null)?.found === false);

  const rules = (question: string, history: Array<{ role: "user" | "assistant"; content: string }> = [], access: SalesAccess = manager) =>
    runWithSalesAccess(access, () => answerSalesAssistant(question, history, fixedNow));
  const costReply = await rules("sales margin this month", [], salesUser);
  ok("rules: cost/margin refused for sales_user", /ungalukku available illa|not available for your role/.test(costReply?.message ?? ""), costReply?.message);
  const yesNo = await rules("4645 delivered ah?");
  ok("rules: yes/no answer starts with Illa", /^Illa, order `4645`/.test(yesNo?.message ?? ""), yesNo?.message);
  const refined = await rules("adhula INR mattum", [{ role: "user", content: "this month evlo sales?" }, { role: "assistant", content: "…" }]);
  ok("rules: filter carry-over keeps date", /^Same date, INR only:/.test(refined?.message ?? "") && /This month/.test(refined?.message ?? "") && /INR/.test(refined?.message ?? ""), refined?.message);
  const basis = await rules("sales this month");
  ok("rules: based-on + data-as-of line", /Based on items created from 01-Sep-2026 to 25-Sep-2026\. Data as of /.test(basis?.message ?? ""), basis?.message);
  const bigRange = await rules("sales in 2026");
  ok("rules: big range asks to narrow", /31 days/.test(bigRange?.message ?? ""), bigRange?.message);
  const help = salesHelpReply("enna panna mudiyum");
  ok("help: Tanglish intro + 5 examples", /Evolv Sales Assistant/.test(help.message) && (help.suggestions?.length ?? 0) === 5);
  const forecast = await rules("next week sales increase aagumaa?");
  ok("rules: forecast declined", /Forecast panna ennala mudiyadhu/.test(forecast?.message ?? ""), forecast?.message);
  setSapFetch();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
