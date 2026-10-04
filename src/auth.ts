import { createHmac, randomBytes } from "node:crypto";
import type { AuthMode, Credentials } from "./config.js";

export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1SignatureBaseString(method: string, url: URL, params: Record<string, string>): string {
  const normalized = Object.entries(params)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  return [method.toUpperCase(), rfc3986(baseUrl), rfc3986(normalized)].join("&");
}

export function oauth1Sign(baseString: string, consumerSecret: string): string {
  // WooCommerce REST API v2+ expects the consumer secret followed by "&" as the HMAC key
  return createHmac("sha256", `${consumerSecret}&`).update(baseString).digest("base64");
}

export function resolveAuthMode(mode: AuthMode, url: URL): Exclude<AuthMode, "auto"> {
  if (mode !== "auto") return mode;
  return url.protocol === "https:" ? "basic" : "oauth1";
}

export function applyAuth(method: string, url: URL, creds: Credentials, mode: AuthMode): Record<string, string> {
  if (resolveAuthMode(mode, url) === "basic") {
    const token = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  };
  const allParams: Record<string, string> = { ...Object.fromEntries(url.searchParams), ...oauthParams };
  const signature = oauth1Sign(oauth1SignatureBaseString(method, url, allParams), creds.consumerSecret);
  for (const [k, v] of Object.entries(oauthParams)) url.searchParams.set(k, v);
  url.searchParams.set("oauth_signature", signature);
  return {};
}
