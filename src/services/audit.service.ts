/*
 * Audit logging + observability for AI data requests.
 * One JSON line per request in logs/audit.log. Never logs credentials, tokens, or env values.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type ObsEvent =
  | "AI_REQUEST"
  | "INTENT_DETECTED"
  | "QUERY_PLAN_CREATED"
  | "QUERY_PLAN_VALIDATED"
  | "QUERY_PLAN_REJECTED"
  | "CLARIFICATION_REQUESTED"
  | "SAP_REQUEST"
  | "SAP_RESPONSE"
  | "SAP_CACHE_HIT"
  | "SAP_RETRY"
  | "ANALYTICS_COMPLETED"
  | "AI_RESPONSE"
  | "ERROR";

export interface SapCallRecord {
  endpoint: string;
  filter: string;
  status: number | "timeout" | "network" | "cache";
  rows: number;
  pages: number;
  attempts: number;
  ms: number;
}

export interface AuditContext {
  requestId: string;
  sessionId: string;
  question: string;
  startedAt: number;
  intent?: string;
  plan?: unknown;
  tool?: string;
  dateRange?: { start: string; end: string; label: string };
  sapCalls: SapCallRecord[];
}

const storage = new AsyncLocalStorage<AuditContext>();
const LOG_DIR = path.resolve(process.cwd(), "logs");
const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|credential/i;

export function currentAudit(): AuditContext | undefined {
  return storage.getStore();
}

export function runWithAudit<T>(sessionId: string, question: string, work: () => Promise<T>): Promise<T> {
  const context: AuditContext = {
    requestId: Math.random().toString(36).slice(2, 10),
    sessionId: sanitizeSession(sessionId),
    question: question.slice(0, 500),
    startedAt: Date.now(),
    sapCalls: [],
  };
  return storage.run(context, work);
}

function sanitizeSession(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  return cleaned || "anonymous";
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, SECRET_KEYS.test(key) ? "[redacted]" : redact(inner)]),
    );
  }
  return value;
}

/** Structured observability line, tagged with the request id when inside a request. */
export function obs(event: ObsEvent, fields: Record<string, unknown> = {}): void {
  const context = currentAudit();
  const line = { event, requestId: context?.requestId, ...(redact(fields) as Record<string, unknown>) };
  const text = `[sales] ${event} ${JSON.stringify(line)}`;
  if (event === "ERROR") console.error(text);
  else console.log(text);
}

export function annotateAudit(update: Partial<Pick<AuditContext, "intent" | "plan" | "tool" | "dateRange">>): void {
  const context = currentAudit();
  if (context) Object.assign(context, update);
}

export async function writeAudit(status: "ok" | "empty" | "clarification" | "rejected" | "error" | "unhandled", error?: string): Promise<void> {
  const context = currentAudit();
  if (!context) return;
  const entry = redact({
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    sessionId: context.sessionId,
    question: context.question,
    intent: context.intent ?? null,
    plan: context.plan ?? null,
    tool: context.tool ?? null,
    sapEndpoint: context.sapCalls.length > 0 ? [...new Set(context.sapCalls.map((call) => call.endpoint))] : [],
    sapCalls: context.sapCalls,
    dateRange: context.dateRange ?? null,
    durationMs: Date.now() - context.startedAt,
    status,
    error: error ?? null,
  });
  if (process.env.AUDIT_LOG_DISABLED === "1") return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(path.join(LOG_DIR, "audit.log"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (writeError) {
    console.error(`[audit] write failed: ${writeError instanceof Error ? writeError.message : "unknown"}`);
  }
}
