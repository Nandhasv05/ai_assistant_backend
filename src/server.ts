import { existsSync } from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { requestLogger } from "./middleware/logger";
import { chatRouter, exportRouter } from "./routes/chat.routes";
import { isLiveAiConfigured } from "./services/ai.service";
import { sapStatus } from "./services/sapSales.service";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();

const corsOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://10.103.10.33",
  "http://10.103.10.33:5050",
  ...(process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
];

app.use(requestLogger);
app.use(
  cors({
    origin: corsOrigins,
  }),
);
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  const sap = sapStatus();
  res.json({
    success: true,
    message: "ok",
    sapConfigured: sap.configured,
    lastSapOkAt: sap.lastOkAt,
  });
});

app.use("/api/chat", chatRouter);
app.use("/api/sales/export", exportRouter);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ success: false, message: "Request body must be valid JSON." });
    return;
  }
  next(error);
});

const frontendDir = path.resolve(__dirname, "../../frontend/dist");
if (existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Not found." });
});

const parsedPort = Number(process.env.PORT);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5000;
const bindHost = process.env.BIND_HOST || "0.0.0.0";

app.listen(port, bindHost, () => {
  const mode = isLiveAiConfigured() ? "live LLM" : "demo (set AI_API_KEY to use a live LLM)";
  console.log(`AI Assistant API listening on http://${bindHost}:${port}`);
  console.log(`AI mode: ${mode}`);
});
