/*
 * Who is asking: role + allowed plants for the Evolv Sales Assistant.
 * The EVOL portal signs a short-lived token (HMAC-SHA256, shared secret AI_ASSISTANT_TOKEN_SECRET)
 * and passes it to the widget; the frontend forwards it in the X-Evolv-Context header.
 * Role/plant claims typed in the chat are never trusted — only this context is.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type SalesRole = "sales_user" | "manager" | "finance" | "admin";

export interface SalesAccess {
  role: SalesRole;
  /** Allowed plant codes; ["*"] = all plants. */
  plants: string[];
  username: string | null;
  source: "token" | "default";
}

interface AccessConfig {
  defaultRole?: string;
  defaultPlants?: string[];
  portalRoles?: Record<string, { role?: string; plants?: string[] } | string>;
  departments?: Record<string, { role?: string; plants?: string[] } | string>;
  users?: Record<string, { role?: string; plants?: string[] } | string>;
}

const ROLES: SalesRole[] = ["sales_user", "manager", "finance", "admin"];
const MAX_TOKEN_AGE_S = 12 * 60 * 60;
const storage = new AsyncLocalStorage<SalesAccess>();

let cached: { file: string; mtime: number; config: AccessConfig } | null = null;

function configPath(): string {
  return process.env.SALES_ACCESS_CONFIG || path.resolve(process.cwd(), "config", "sales-access.json");
}

function loadConfig(): AccessConfig {
  const file = configPath();
  try {
    const mtime = statSync(file).mtimeMs;
    if (cached && cached.file === file && cached.mtime === mtime) return cached.config;
    const config = JSON.parse(readFileSync(file, "utf8")) as AccessConfig;
    cached = { file, mtime, config };
    return config;
  } catch {
    return {};
  }
}

function asRole(value: unknown): SalesRole | null {
  const role = String(value ?? "").trim().toLowerCase();
  return (ROLES as string[]).includes(role) ? (role as SalesRole) : null;
}

function asPlants(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const plants = value.map((plant) => String(plant).trim().toUpperCase()).filter(Boolean);
  return plants.length ? [...new Set(plants)] : null;
}

function entry(map: AccessConfig["users"], key: string | null | undefined): { role?: string; plants?: string[] } | null {
  if (!map || !key) return null;
  const found = Object.entries(map).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  if (!found) return null;
  return typeof found === "string" ? { role: found } : found;
}

export function defaultSalesAccess(): SalesAccess {
  const config = loadConfig();
  return {
    role: asRole(config.defaultRole) ?? "sales_user",
    plants: asPlants(config.defaultPlants) ?? ["*"],
    username: null,
    source: "default",
  };
}

/** Maps a verified portal identity to an assistant role/plants: user entry > department > portal role > defaults. */
export function resolveSalesAccess(identity: { username?: string | null; role?: string | null; department?: string | null }): SalesAccess {
  const config = loadConfig();
  const base = defaultSalesAccess();
  const layers = [entry(config.portalRoles, identity.role), entry(config.departments, identity.department), entry(config.users, identity.username)];
  let role = base.role;
  let plants = base.plants;
  for (const layer of layers) {
    if (!layer) continue;
    role = asRole(layer.role) ?? role;
    plants = asPlants(layer.plants) ?? plants;
  }
  return { role, plants, username: identity.username?.trim() || null, source: "token" };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signSalesToken(payload: { u: string; r?: string; d?: string }, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat, exp: iat + 8 * 60 * 60 }));
  const signature = b64url(createHmac("sha256", secret).update(`v1.${body}`).digest());
  return `v1.${body}.${signature}`;
}

/** Returns the verified identity, or null when the token is missing, malformed, expired or unsigned. */
export function verifySalesToken(token: string | undefined | null, secret = process.env.AI_ASSISTANT_TOKEN_SECRET, now = Date.now()) {
  if (!token || !secret || secret.length < 16) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = createHmac("sha256", secret).update(`v1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      u?: unknown;
      r?: unknown;
      d?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    const seconds = Math.floor(now / 1000);
    const exp = Number(payload.exp);
    const iat = Number(payload.iat);
    if (!Number.isFinite(exp) || exp < seconds || !Number.isFinite(iat) || exp - iat > MAX_TOKEN_AGE_S || iat > seconds + 300) return null;
    const username = typeof payload.u === "string" ? payload.u.slice(0, 80) : "";
    if (!username) return null;
    return { username, role: typeof payload.r === "string" ? payload.r : null, department: typeof payload.d === "string" ? payload.d : null };
  } catch {
    return null;
  }
}

export function accessFromToken(token: string | undefined | null): SalesAccess {
  const identity = verifySalesToken(token);
  return identity ? resolveSalesAccess(identity) : defaultSalesAccess();
}

export function runWithSalesAccess<T>(access: SalesAccess, work: () => Promise<T>): Promise<T> {
  return storage.run(access, work);
}

export function currentSalesAccess(): SalesAccess {
  return storage.getStore() ?? defaultSalesAccess();
}

export function canSeeCost(access = currentSalesAccess()): boolean {
  return access.role !== "sales_user";
}

export function allPlantsAllowed(access = currentSalesAccess()): boolean {
  return access.plants.includes("*");
}

export function plantAllowed(plant: string, access = currentSalesAccess()): boolean {
  return allPlantsAllowed(access) || access.plants.includes(plant.trim().toUpperCase());
}

export function allowedPlantsText(access = currentSalesAccess()): string {
  return allPlantsAllowed(access) ? "All plants" : access.plants.join(", ");
}

/** Drops records of plants the current user may not see (rows without a plant are kept only for all-plant users). */
export function restrictToAllowedPlants<T extends { Plant?: string | null }>(records: T[], access = currentSalesAccess()): T[] {
  if (allPlantsAllowed(access)) return records;
  return records.filter((record) => Boolean(record.Plant) && access.plants.includes(String(record.Plant).toUpperCase()));
}
