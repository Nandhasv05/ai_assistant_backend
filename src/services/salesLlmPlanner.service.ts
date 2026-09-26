/*
 * Optional LLM query planner. The LLM only returns a JSON QueryPlan; it never sees SAP credentials
 * or SAP data, and its plan is validated by validateQueryPlan before any tool runs.
 * Any failure (no key, timeout, bad JSON, invalid plan) falls back to the rule planner.
 */
import { obs } from "./audit.service";
import { businessToday } from "./sapSales.service";
import { planFromText, validateQueryPlan, type PlanOutcome, type PlannerContext, type QueryPlan } from "./salesPlanner.service";

const PLAN_PROMPT = `You convert a sales question into a JSON query plan for a read-only SAP Sales analytics backend.
Return ONLY a JSON object, no prose. Schema:
{
 "intent": "SALES_KPI"|"SALES_SUMMARY"|"SALES_ORDER_DETAIL"|"SALES_GROUPING"|"SALES_TREND"|"SALES_COMPARISON"|"SALES_DASHBOARD"|"SALES_REPORT"|"SALES_PENDING",
 "entity": "SALES"|"SALES_ORDER"|"SALES_ITEM",
 "metric": "COUNT"|"ITEM_COUNT"|"QUANTITY"|"NET_AMOUNT"|"AVG_ORDER_VALUE"|"SUMMARY",
 "period": "TODAY"|"YESTERDAY"|"THIS_WEEK"|"LAST_WEEK"|"THIS_MONTH"|"LAST_MONTH"|"THIS_QUARTER"|"LAST_QUARTER"|"THIS_YEAR"|"LAST_YEAR"|"CUSTOM_DATE"|"CUSTOM_RANGE"|"SPECIFIC_MONTH"|"SPECIFIC_YEAR",
 "dateRange": {"startDate":"YYYY-MM-DD","endDateExclusive":"YYYY-MM-DD"} (only for CUSTOM_*/SPECIFIC_*),
 "comparePeriod": same values as period (only for comparisons), "compareDateRange": optional,
 "groupBy": [] or one of ["DATE","SALES_ORDER","MATERIAL","PLANT","CUSTOMER_GROUP","CURRENCY","DELIVERY_STATUS","BILLING_STATUS"],
 "sort": null or {"field":"AMOUNT"|"QUANTITY"|"ITEM_COUNT"|"SALES_ORDERS","direction":"DESC"|"ASC"},
 "limit": null or integer 1..100,
 "output": "KPI"|"SUMMARY"|"TABLE"|"DETAIL"|"CHART"|"DASHBOARD"|"COMPARISON"|"REPORT",
 "salesOrder": optional digits,
 "filters": optional {"pendingOnly": true} or {"PLANT":["..."]} etc,
 "wantPdf": boolean
}
If the question is ambiguous (no period for a count, or "top customers" without a metric), return {"clarify":"<short question>"}.
Never produce SQL. There is no customer field; customers map to CUSTOMER_GROUP.`;

function llmConfigured(): boolean {
  const key = process.env.AI_API_KEY?.trim();
  return Boolean(key && key !== "your_api_key_here") && process.env.SALES_LLM_PLANNER !== "off";
}

async function requestPlan(message: string, context: PlannerContext, now: Date): Promise<unknown> {
  const baseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY?.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLAN_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            today: businessToday(now).date,
            timezone: process.env.BUSINESS_TIMEZONE || "Asia/Kolkata",
            previousPlan: context.lastPlan ?? null,
            question: message,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`LLM status ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return JSON.parse(payload.choices?.[0]?.message?.content ?? "");
}

/** LLM plan when configured and valid; otherwise the deterministic rule plan. */
export async function planQuestion(message: string, context: PlannerContext, now = new Date()): Promise<PlanOutcome & { planner: "llm" | "rules" }> {
  const rules = planFromText(message, context, now);
  if (!llmConfigured()) return { ...rules, planner: "rules" };
  try {
    const raw = (await requestPlan(message, context, now)) as Record<string, unknown>;
    if (typeof raw.clarify === "string" && raw.clarify.trim()) {
      return { plan: null, clarification: raw.clarify.trim().slice(0, 300), pending: rules.pending, planner: "llm" };
    }
    const plan = { groupBy: [], sort: null, limit: null, ...raw } as unknown as QueryPlan;
    const validation = validateQueryPlan(plan, message);
    if (validation.valid) return { plan, planner: "llm" };
    obs("QUERY_PLAN_REJECTED", { planner: "llm", reason: validation.reason });
  } catch (error) {
    obs("ERROR", { stage: "llm_planner", reason: error instanceof Error ? error.message : "unknown" });
  }
  return { ...rules, planner: "rules" };
}
