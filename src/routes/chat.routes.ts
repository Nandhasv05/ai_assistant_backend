import { Router } from "express";
import { getSalesExport, postChat } from "../controllers/chat.controller";

export const chatRouter = Router();

chatRouter.post("/", postChat);

export const exportRouter = Router();

exportRouter.get("/:id", getSalesExport);
