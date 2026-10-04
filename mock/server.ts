import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { WooOrder, WooProduct } from "../src/woo-types.js";
import { notes, orders, products, settings, variations } from "./data.js";

export interface MockOptions {
  port?: number;
  keys?: Record<string, { secret: string; permissions: "read" | "write" | "read_write" }>;
  /** Fixed-window limit applied to API calls, like a host or WAF in front of a real store. */
  rateLimit?: { requests: number; windowMs: number };
  log?: boolean;
}

export const DEFAULT_KEY = "ck_mock_0000000000000000000000000000000000000";
export const DEFAULT_SECRET = "cs_mock_0000000000000000000000000000000000000";

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function verifyOauth1(method: string, url: URL, secret: string) {
  const params = Object.fromEntries(url.searchParams);
  const provided = params.oauth_signature;
  delete params.oauth_signature;
  if (params.oauth_signature_method !== "HMAC-SHA256" && params.oauth_signature_method !== "HMAC-SHA1") {
    throw new HttpError(401, "woocommerce_rest_authentication_error", "Invalid signature method.");
  }
  if (Math.abs(Date.now() / 1000 - Number(params.oauth_timestamp)) > 15 * 60) {
    throw new HttpError(401, "woocommerce_rest_authentication_error", "Invalid timestamp.");
  }
  const paramString = Object.keys(params)
    .map((k) => [enc(k), enc(params[k])])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method}&${enc(`${url.protocol}//${url.host}${url.pathname}`)}&${enc(paramString)}`;
  const algo = params.oauth_signature_method === "HMAC-SHA1" ? "sha1" : "sha256";
  const expected = createHmac(algo, `${secret}&`).update(base).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "woocommerce_rest_authentication_error", "Invalid signature - provided signature does not match.");
  }
}

function paginate<T>(items: T[], url: URL, res: ServerResponse) {
  const perPage = Number(url.searchParams.get("per_page") ?? 10);
  const page = Number(url.searchParams.get("page") ?? 1);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new HttpError(400, "rest_invalid_param", "Invalid parameter(s): per_page");
  }
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "rest_invalid_param", "Invalid parameter(s): page");
  res.setHeader("X-WP-Total", String(items.length));
  res.setHeader("X-WP-TotalPages", String(Math.max(1, Math.ceil(items.length / perPage))));
  return items.slice((page - 1) * perPage, page * perPage);
}

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function sortBy<T>(items: T[], url: URL, keys: Record<string, (x: T) => string | number>, fallback: string) {
  const key = keys[url.searchParams.get("orderby") ?? fallback] ?? keys[fallback];
  const dir = url.searchParams.get("order") === "asc" ? 1 : -1;
  return [...items].sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0));
}

function filterOrders(url: URL): WooOrder[] {
  const q = url.searchParams;
  const statuses = list(q.get("status")).filter((s) => s !== "any");
  const search = q.get("search")?.toLowerCase();
  let result = orders.filter((o) => {
    if (statuses.length && !statuses.includes(o.status)) return false;
    if (q.get("after") && o.date_created < q.get("after")!) return false;
    if (q.get("before") && o.date_created > q.get("before")!) return false;
    if (q.get("modified_after") && (o.date_modified ?? "") < q.get("modified_after")!) return false;
    if (q.get("customer") && o.customer_id !== Number(q.get("customer"))) return false;
    if (q.get("product") && !o.line_items.some((li) => li.product_id === Number(q.get("product")))) return false;
    if (search) {
      const b = o.billing;
      const haystack = [String(o.id), b.first_name, b.last_name, b.email, b.phone, b.city, b.address_1, ...o.line_items.map((li) => li.name)]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  result = sortBy(result, url, { date: (o) => o.date_created, id: (o) => o.id }, "date");
  return result;
}

function filterProducts(url: URL): WooProduct[] {
  const q = url.searchParams;
  const status = q.get("status") ?? "any";
  const search = q.get("search")?.toLowerCase();
  const skus = list(q.get("sku"));
  const result = products.filter((p) => {
    if (status !== "any" && p.status !== status) return false;
    if (q.get("stock_status") && p.stock_status !== q.get("stock_status")) return false;
    if (q.get("type") && p.type !== q.get("type")) return false;
    if (q.get("category") && !p.categories?.some((c) => c.id === Number(q.get("category")))) return false;
    if (skus.length && !skus.includes(p.sku)) return false;
    if (search && !`${p.name} ${p.short_description}`.toLowerCase().includes(search)) return false;
    return true;
  });
  return sortBy(
    result,
    url,
    { date: (p) => p.date_modified ?? "", id: (p) => p.id, title: (p) => p.name, price: (p) => Number(p.price), popularity: (p) => -p.id },
    "date",
  );
}

async function readBody(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;max-width:520px;margin:60px auto;padding:0 16px}button{padding:10px 18px;font-size:15px}</style></head><body>${body}</body></html>`;

export function startMockStore(opts: MockOptions = {}) {
  const keys = new Map(Object.entries(opts.keys ?? { [DEFAULT_KEY]: { secret: DEFAULT_SECRET, permissions: "read" as const } }));
  const control = { forcedFailures: [] as Array<{ status: number; retryAfter?: string }>, apiRequests: 0, rateLimited: 0 };
  let windowStart = Date.now();
  let windowCount = 0;

  function authenticate(req: IncomingMessage, url: URL) {
    let key: string | undefined;
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const [ck, cs] = Buffer.from(header.slice(6), "base64").toString().split(":");
      const entry = keys.get(ck);
      if (!entry || entry.secret !== cs) throw new HttpError(401, "woocommerce_rest_authentication_error", "Consumer secret is invalid.");
      key = ck;
    } else if (url.searchParams.has("oauth_consumer_key")) {
      key = url.searchParams.get("oauth_consumer_key")!;
      const entry = keys.get(key);
      if (!entry) throw new HttpError(401, "woocommerce_rest_authentication_error", "Consumer key is invalid.");
      verifyOauth1("GET", url, entry.secret);
    } else {
      throw new HttpError(401, "woocommerce_rest_cannot_view", "Sorry, you cannot list resources.");
    }
    return key;
  }

  function throttle() {
    const forced = control.forcedFailures.shift();
    if (forced) {
      if (forced.status === 429) control.rateLimited++;
      throw new HttpError(forced.status, forced.status === 429 ? "too_many_requests" : "service_unavailable", "Simulated failure", forced.retryAfter ? { "Retry-After": forced.retryAfter } : {});
    }
    if (!opts.rateLimit) return;
    const now = Date.now();
    if (now - windowStart >= opts.rateLimit.windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > opts.rateLimit.requests) {
      control.rateLimited++;
      const retryAfter = Math.ceil((opts.rateLimit.windowMs - (now - windowStart)) / 1000);
      throw new HttpError(429, "too_many_requests", "Rate limit exceeded.", { "Retry-After": String(retryAfter) });
    }
  }

  function api(req: IncomingMessage, url: URL, res: ServerResponse): unknown {
    control.apiRequests++;
    throttle();
    authenticate(req, url);
    if (req.method !== "GET") throw new HttpError(405, "rest_no_route", "This mock only serves read endpoints.");
    const path = url.pathname.replace("/wp-json/wc/v3", "");
    let m: RegExpMatchArray | null;

    if (path === "/orders") return paginate(filterOrders(url), url, res);
    if ((m = path.match(/^\/orders\/(\d+)$/))) {
      const order = orders.find((o) => o.id === Number(m![1]));
      if (!order) throw new HttpError(404, "woocommerce_rest_shop_order_invalid_id", "Invalid ID.");
      return order;
    }
    if ((m = path.match(/^\/orders\/(\d+)\/notes$/))) {
      if (!notes.has(Number(m[1]))) throw new HttpError(404, "woocommerce_rest_order_invalid_id", "Invalid order ID.");
      return notes.get(Number(m[1]));
    }
    if (path === "/products") return paginate(filterProducts(url), url, res);
    if ((m = path.match(/^\/products\/(\d+)$/))) {
      const product = products.find((p) => p.id === Number(m![1]));
      if (!product) throw new HttpError(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
      return product;
    }
    if ((m = path.match(/^\/products\/(\d+)\/variations$/))) return paginate(variations.get(Number(m[1])) ?? [], url, res);
    if ((m = path.match(/^\/settings\/products\/(\w+)$/))) {
      const value = settings[m[1] as keyof typeof settings];
      if (value === undefined) throw new HttpError(404, "rest_setting_setting_invalid", "Invalid setting.");
      return { id: m[1], value };
    }
    throw new HttpError(404, "rest_no_route", "No route was found matching the URL and request method.");
  }

  async function authorize(req: IncomingMessage, url: URL, res: ServerResponse) {
    if (req.method === "GET") {
      const p = url.searchParams;
      for (const field of ["app_name", "scope", "user_id", "return_url", "callback_url"]) {
        if (!p.get(field)) throw new HttpError(400, "woocommerce_rest_missing_param", `Missing parameter ${field}`);
      }
      if (!["read", "write", "read_write"].includes(p.get("scope")!)) throw new HttpError(400, "invalid_scope", "Invalid scope");
      const cb = new URL(p.get("callback_url")!);
      if (cb.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(cb.hostname)) {
        throw new HttpError(400, "invalid_callback", "The callback_url needs to be over SSL");
      }
      const hidden = [...p].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}">`).join("");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        page("Authorize", `<h2>${p.get("app_name")} would like to connect to your store</h2><p>Access requested: <b>${p.get("scope")}</b> (orders, products, settings)</p><p>Logged in as <b>store admin</b> (mock).</p><form method="post" action="/wc-auth/v1/access_granted">${hidden}<button>Approve</button></form>`),
      );
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    const consumerKey = `ck_${randomBytes(20).toString("hex")}`;
    const consumerSecret = `cs_${randomBytes(20).toString("hex")}`;
    const scope = form.get("scope") as "read" | "write" | "read_write";
    keys.set(consumerKey, { secret: consumerSecret, permissions: scope });
    const cbRes = await fetch(form.get("callback_url")!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key_id: keys.size, user_id: form.get("user_id"), consumer_key: consumerKey, consumer_secret: consumerSecret, key_permissions: scope }),
    });
    if (!cbRes.ok) {
      keys.delete(consumerKey);
      throw new HttpError(400, "woocommerce_rest_callback_failed", `Callback returned ${cbRes.status}`);
    }
    const ret = new URL(form.get("return_url")!);
    ret.searchParams.set("success", "1");
    ret.searchParams.set("user_id", form.get("user_id")!);
    res.writeHead(302, { Location: ret.toString() }).end();
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const started = Date.now();
    try {
      if (url.pathname.startsWith("/wp-json/wc/v3/")) {
        const body = JSON.stringify(api(req, url, res));
        res.writeHead(200, { "Content-Type": "application/json" }).end(body);
      } else if (url.pathname.startsWith("/wc-auth/v1/")) {
        await authorize(req, url, res);
      } else if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("Mock store", "<h2>Kettle &amp; Husk (mock WooCommerce store)</h2>"));
      } else {
        throw new HttpError(404, "rest_no_route", "Not found");
      }
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, "internal_error", (err as Error).message);
      res.writeHead(e.status, { "Content-Type": "application/json", ...e.headers }).end(
        JSON.stringify({ code: e.code, message: e.message, data: { status: e.status } }),
      );
    } finally {
      if (opts.log) console.log(`${req.method} ${url.pathname}${url.search ? "?" + [...url.searchParams.keys()].filter((k) => !k.startsWith("oauth_")).map((k) => `${k}=${url.searchParams.get(k)}`).join("&") : ""} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  return new Promise<{ url: string; close: () => Promise<void>; control: typeof control; keys: typeof keys }>((resolve) => {
    server.listen(opts.port ?? 0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://localhost:${port}`,
        control,
        keys,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  startMockStore({ port, log: true, rateLimit: { requests: 30, windowMs: 10_000 } }).then(({ url }) => {
    console.log(`Mock WooCommerce store "Kettle & Husk" running at ${url}`);
    console.log(`Read-only API key: ${DEFAULT_KEY}\nSecret:            ${DEFAULT_SECRET}`);
    console.log("Rate limit: 30 requests / 10s (returns 429 with Retry-After)");
  });
}
