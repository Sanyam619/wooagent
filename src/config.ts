import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AuthMode = "auto" | "basic" | "oauth1";

export interface Credentials {
  consumerKey: string;
  consumerSecret: string;
}

export interface Config {
  baseUrl: string;
  credentials?: Credentials;
  authMode: AuthMode;
  rateLimitRps: number;
  rateLimitBurst: number;
  maxConcurrency: number;
  maxRetries: number;
  timeoutMs: number;
  exposePii: boolean;
}

export const CREDENTIALS_FILE = resolve(process.env.WOO_CREDENTIALS_FILE ?? ".credentials.json");

function loadDotEnv() {
  const file = resolve(".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function num(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`);
  return value;
}

export function readStoredCredentials(): (Credentials & { baseUrl?: string }) | undefined {
  if (!existsSync(CREDENTIALS_FILE)) return undefined;
  const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  if (!parsed.consumer_key || !parsed.consumer_secret) return undefined;
  return { consumerKey: parsed.consumer_key, consumerSecret: parsed.consumer_secret, baseUrl: parsed.base_url };
}

export function loadConfig(): Config {
  loadDotEnv();
  const stored = readStoredCredentials();
  const baseUrl = (process.env.WOO_BASE_URL || stored?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("WOO_BASE_URL is not set");

  const key = process.env.WOO_CONSUMER_KEY;
  const secret = process.env.WOO_CONSUMER_SECRET;
  const credentials = key && secret ? { consumerKey: key, consumerSecret: secret } : stored;

  const authMode = (process.env.WOO_AUTH_MODE || "auto") as AuthMode;
  if (!["auto", "basic", "oauth1"].includes(authMode)) throw new Error("WOO_AUTH_MODE must be auto, basic or oauth1");

  return {
    baseUrl,
    credentials,
    authMode,
    rateLimitRps: num("WOO_RATE_LIMIT_RPS", 5, 0.1),
    rateLimitBurst: num("WOO_RATE_LIMIT_BURST", 10),
    maxConcurrency: num("WOO_MAX_CONCURRENCY", 4),
    maxRetries: Math.floor(num("WOO_MAX_RETRIES", 4, 0)),
    timeoutMs: num("WOO_TIMEOUT_MS", 15000),
    exposePii: process.env.WOO_EXPOSE_PII === "true",
  };
}
