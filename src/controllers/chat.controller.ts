import type { Request, Response } from "express";
import { generateReply } from "../services/ai.service";
import type { ChatTurn } from "../services/ai.service";
import { runWithAudit, writeAudit } from "../services/audit.service";
import { buildExportDocument, exportFileName, getExport, registerExport, renderExport, type ExportFormat } from "../services/salesExport.service";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY = 40;

function readHistory(input: unknown): ChatTurn[] | { error: string } {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    return { error: "History must be an array of messages." };
  }

  const history: ChatTurn[] = [];
  for (const item of input.slice(-MAX_HISTORY)) {
    if (!item || typeof item !== "object") {
      return { error: "Each history item must include a role and content." };
    }

    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") {
      return { error: "History roles must be user or assistant." };
    }
    if (typeof content !== "string") {
      return { error: "History content must be a string." };
    }

    const trimmed = content.trim();
    if (!trimmed) continue;
    // Assistant replies (reports) can be long; only their start matters for context.
    history.push({ role, content: trimmed.slice(0, MAX_MESSAGE_LENGTH) });
  }

  return history;
}

function readSessionId(req: Request, body: { sessionId?: unknown }): string {
  const header = req.header("x-session-id");
  const value = typeof body.sessionId === "string" ? body.sessionId : header ?? "";
  return value.slice(0, 64);
}

export async function postChat(req: Request, res: Response): Promise<void> {
  const body = req.body as { message?: unknown; history?: unknown; sessionId?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ success: false, message: "Request body must be a JSON object." });
    return;
  }

  if (typeof body.message !== "string") {
    res.status(400).json({ success: false, message: "Message is required." });
    return;
  }

  const message = body.message.trim();
  if (!message) {
    res.status(400).json({ success: false, message: "Message is required." });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ success: false, message: "Message must be 4000 characters or fewer." });
    return;
  }

  const history = readHistory(body.history);
  if ("error" in history) {
    res.status(400).json({ success: false, message: history.error });
    return;
  }

  console.log(`[chat] message received (${message.length} chars, history ${history.length})`);

  await runWithAudit(readSessionId(req, body), message, async () => {
    try {
      const reply = await generateReply(message, history);
      let view = reply.view ?? null;
      if (view && view.provenance) {
        const exportId = registerExport(buildExportDocument(view, reply.records ?? []));
        view = { ...view, exportId, exportFormats: ["pdf", "xlsx", "csv"] };
      }
      res.json({ success: true, message: reply.message, view, suggestions: reply.suggestions ?? [] });
    } catch (error) {
      console.error(`[chat] failed: ${error instanceof Error ? error.message : "unknown error"}`);
      await writeAudit("error", error instanceof Error ? error.name : "unknown");
      res.status(502).json({
        success: false,
        message: "The assistant could not complete this request. Please try again.",
      });
    }
  });
}

const FORMATS: ExportFormat[] = ["pdf", "xlsx", "csv"];

export function getSalesExport(req: Request, res: Response): void {
  const id = String(req.params.id ?? "");
  const format = String(req.query.format ?? "pdf").toLowerCase() as ExportFormat;
  if (!/^[0-9a-f-]{36}$/.test(id) || !FORMATS.includes(format)) {
    res.status(400).json({ success: false, message: "Invalid export request." });
    return;
  }
  const doc = getExport(id);
  if (!doc) {
    res.status(404).json({ success: false, message: "This export has expired. Ask the question again to regenerate it." });
    return;
  }
  const { data, contentType } = renderExport(doc, format);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${exportFileName(doc, format)}"`);
  res.setHeader("Cache-Control", "no-store");
  console.log(`[export] ${format} ${data.length} bytes`);
  res.send(data);
}
