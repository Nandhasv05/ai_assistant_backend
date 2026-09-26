/*
 * Live SAP end-to-end run of the 18 Sales acceptance questions through the full chat path
 * (generateReply → planner → tools → SAP → analytics → composer → export).
 * Run: npx tsx src/tests/sales.live.test.ts   (needs SAP credentials in .env)
 */
import "dotenv/config";
process.env.AUDIT_LOG_DISABLED = "1";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateReply, type ChatTurn } from "../services/ai.service";
import { runWithAudit } from "../services/audit.service";
import { distinctSalesOrders } from "../services/salesAnalytics.service";
import { buildExportDocument, renderExport } from "../services/salesExport.service";
import { getDateRange, getSalesItemsForRange, getSalesOrderRecords } from "../services/sapSales.service";

let passed = 0;
let failed = 0;
const OUT = path.resolve(process.cwd(), "test-output");

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

async function ask(question: string, history: ChatTurn[]) {
  const started = Date.now();
  const reply = await runWithAudit("live-test", question, () => generateReply(question, history));
  const ms = Date.now() - started;
  const view = reply.view;
  console.log(`\n> ${question}   (${ms} ms)`);
  console.log(`  ${reply.message.split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 260)}`);
  if (view) {
    console.log(`  view=${view.mode} title="${view.title}" kpis=${view.kpis.slice(0, 3).map((k) => `${k.label}:${k.value}`).join("; ")} rows=${view.rows.length} sections=${view.sections?.length ?? 0} charts=${view.charts?.length ?? 0}`);
    if (view.note) console.log(`  note: ${view.note.slice(0, 220)}`);
  }
  history.push({ role: "user", content: question }, { role: "assistant", content: reply.message });
  return reply;
}

function kpi(reply: Awaited<ReturnType<typeof ask>>, label: string): string | undefined {
  return reply.view?.kpis.find((entry) => entry.label === label)?.value;
}

const n = (value: string | undefined) => Number(String(value ?? "").replace(/,/g, ""));

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const month = getDateRange("THIS_MONTH");
  const today = getDateRange("TODAY");
  const [monthRaw, todayRaw] = await Promise.all([getSalesItemsForRange(month), getSalesItemsForRange(today)]);
  const monthOrders = distinctSalesOrders(monthRaw.records);
  const todayOrders = distinctSalesOrders(todayRaw.records);
  console.log(`Reference: ${month.label} = ${monthRaw.records.length} items / ${monthOrders} orders; ${today.label} = ${todayRaw.records.length} items / ${todayOrders} orders`);

  const fresh = () => [] as ChatTurn[];

  const r1 = await ask("How many sales orders today?", fresh());
  ok("1 today count = distinct SalesOrder", todayOrders === 0 ? r1.message.startsWith("No sales records") : n(kpi(r1, "Sales Orders")) === todayOrders, r1.message);

  const r2 = await ask("Today's sales summary", fresh());
  ok("2 today summary", todayOrders === 0 ? r2.message.startsWith("No sales records") : n(kpi(r2, "Sales Orders")) === todayOrders);

  const r3 = await ask("This month's summary", fresh());
  ok("3 month summary orders", n(kpi(r3, "Sales Orders")) === monthOrders, kpi(r3, "Sales Orders"));
  ok("3 month summary items", n(kpi(r3, "Order Items")) === monthRaw.records.length);
  ok("3 provenance", r3.view?.provenance?.source === "SAP_SALES_API" && r3.view.provenance.calculation === "DISTINCT SalesOrder");

  const r4 = await ask("This month's dashboard", fresh());
  ok("4 dashboard with 5 charts", r4.view?.mode === "dashboard" && r4.view.charts?.length === 5);

  const r5 = await ask("Daily sales orders this month", fresh());
  const dailySum = (r5.view?.rows ?? []).reduce((sum, row) => sum + n(row[2]), 0);
  ok("5 daily trend items add up", r5.view?.mode === "chart" && dailySum === monthRaw.records.length, `${dailySum}`);

  const r6 = await ask("Top 10 materials by quantity this month", fresh());
  const qtys = (r6.view?.rows ?? []).map((row) => parseFloat(String(row[3]).replace(/,/g, "")));
  ok("6 top 10 materials sorted by qty", qtys.length === Math.min(10, qtys.length) && qtys.length > 0 && qtys.every((value, index) => index === 0 || value <= qtys[index - 1]));

  const r7 = await ask("Top 5 sales orders by amount this month", fresh());
  ok("7 top 5 sales orders", r7.view?.rows.length === 5 && r7.view.columns[0] === "Sales Order", r7.view?.columns.join(","));

  const r8 = await ask("Sales by plant this month", fresh());
  const plantOrders = new Set(monthRaw.records.map((record) => record.Plant || "—")).size;
  ok("8 plant groups", r8.view?.rows.length === plantOrders, `${r8.view?.rows.length} vs ${plantOrders}`);

  const r9 = await ask("Sales by delivery status", fresh());
  ok("9 delivery status (assumed this month noted)", (r9.view?.rows.length ?? 0) > 0 && /No period was specified/.test(r9.view?.note ?? ""));

  const r10 = await ask("Compare this month with last month", fresh());
  ok("10 comparison current matches", r10.view?.mode === "comparison" && n(r10.view.rows[0]?.[1]) === monthOrders, r10.view?.rows[0]?.join(" | "));

  const r11 = await ask("Show sales order 70026657", fresh());
  const orderRecords = await getSalesOrderRecords("70026657");
  ok("11 order detail", orderRecords.length === 0 ? r11.message.includes("not found") : r11.view?.mode === "details" && r11.view.rows.length === orderRecords.length, r11.message.slice(0, 80));

  const r12 = await ask("How many items are in 70026657?", fresh());
  ok("12 order item count", orderRecords.length === 0 ? r12.message.includes("not found") : r12.message.includes(`has ${orderRecords.length} sales order item`), r12.message);

  const r13 = await ask("Show this month's sales report", fresh());
  ok("13 report sections", r13.view?.mode === "report" && (r13.view.sections?.length ?? 0) >= 5 && (r13.view.bullets?.length ?? 0) >= 5);

  const r14 = await ask("Generate this month's sales report PDF", fresh());
  ok("14 report as pdf", r14.view?.mode === "pdf");
  if (r14.view) {
    const doc = buildExportDocument(r14.view, r14.records ?? []);
    const pdf = renderExport(doc, "pdf").data;
    const xlsx = renderExport(doc, "xlsx").data;
    const csv = renderExport(doc, "csv").data;
    await writeFile(path.join(OUT, "this-month-sales-report.pdf"), pdf);
    await writeFile(path.join(OUT, "this-month-sales-report.xlsx"), xlsx);
    await writeFile(path.join(OUT, "this-month-sales-report.csv"), csv);
    ok("14 pdf generated by backend", pdf.subarray(0, 5).toString("latin1") === "%PDF-" && pdf.length > 2000, `${pdf.length} bytes`);
    ok("14 excel sheets", doc.sheets.map((sheet) => sheet.name).join(",").includes("Summary,Sales Orders,Sales Items,Daily Trend"));
    ok("14 excel items = SAP items", doc.sheets.find((sheet) => sheet.name === "Sales Items")?.rows.length === monthRaw.records.length);
  }

  console.log("\n--- Follow-up conversation ---");
  const convo = fresh();
  await ask("How many sales orders today?", convo);
  const r15 = await ask("Not today. I want this month.", convo);
  ok("15 switches to this month count", n(kpi(r15, "Sales Orders")) === monthOrders, r15.message);
  const r16 = await ask("Show the top 5 materials", convo);
  ok("16 top 5 materials this month", r16.view?.rows.length === 5 && /This Month/.test(r16.view.title), r16.view?.title);
  const r10Units = (r10.view?.rows ?? []).filter((row) => row[0].startsWith("Quantity "));
  const monthUnits = new Set(monthRaw.records.map((record) => record.OrderQuantityUnit || "EA"));
  ok("10 quantity compared per unit (units never added)", r10Units.length >= monthUnits.size && r10Units.every((row) => monthUnits.has(row[0].slice(9)) || row[0].length > 9), r10Units.map((row) => row[0]).join(","));
  const r17 = await ask("Compare that with last month", convo);
  ok("17 compare with materials section", r17.view?.mode === "comparison" && (r17.view.sections?.[0]?.rows.length ?? 0) === 5, r17.view?.title);
  const r18 = await ask("Make this a PDF", convo);
  ok("18 same comparison as pdf", r18.view?.mode === "pdf" && r18.view.title === r17.view?.title);
  if (r18.view) {
    const pdf = renderExport(buildExportDocument(r18.view, r18.records ?? []), "pdf").data;
    await writeFile(path.join(OUT, "comparison-follow-up.pdf"), pdf);
    ok("18 pdf rendered", pdf.subarray(0, 5).toString("latin1") === "%PDF-");
  }

  console.log("\n--- Clarifications ---");
  const c1 = await ask("Show sales.", fresh());
  ok("'Show sales.' asks for period", /Which period/.test(c1.message));
  const c2 = await ask("Top customers", fresh());
  ok("'Top customers' asks metric", /amount, quantity, or number of orders/.test(c2.message));

  console.log(`\nExports written to ${OUT}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
