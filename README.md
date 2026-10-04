# WooCommerce connector for Agent Studio

A private, read-only connector that lets an agent read a merchant's **orders, order notes, products and inventory** from WooCommerce. It is an MCP server (stdio), so it plugs into any MCP-capable agent runtime.

Why WooCommerce: a large share of Razorpay's small and mid-size merchants run WooCommerce with the Razorpay plugin, and their most common support questions ("I paid but my order is pending", "is this in stock?") are answered by exactly this data.

```
Agent ──MCP (stdio)──▶ tools.ts ──▶ woo.ts ──▶ http.ts ──HTTPS/OAuth1──▶ WooCommerce REST API v3
                      9 tools,      domain     auth, token bucket,
                      zod schemas   + PII mask  retries, Retry-After
```

## Quick start (5 minutes, no WooCommerce install needed)

Requires Node.js 20+.

```bash
npm install
npm test          # 40 tests: tools end-to-end over MCP, rate limits, auth, connect flow
npm run demo      # merchant questions answered through the connector against a mock store
```

To run it interactively:

```bash
npm run mock                       # terminal 1: fictional store "Kettle & Husk" on :8787
cp .env.example .env               # terminal 2: already points at the mock store and its fake key
npx @modelcontextprotocol/inspector npx tsx src/server.ts   # browse and call the tools
```

The mock behaves like WooCommerce where it matters for the connector: same routes and JSON shapes, `X-WP-Total` pagination headers, OAuth 1.0a signature verification, WooCommerce error bodies, the `/wc-auth/v1/authorize` approval flow, and a 30 requests / 10 s rate limit that returns `429` with `Retry-After`. All data in it is fictional.

## Authentication

Two ways to give the connector a key. Both produce a **read-only** WooCommerce REST API key.

**1. Approval flow (recommended for merchants)** — WooCommerce's built-in app authorization endpoint, the closest thing WooCommerce has to OAuth:

```bash
npm run connect -- --store http://localhost:8787            # against the mock
npm run connect -- --store https://shop.example.com \
                   --callback-url https://<your-tunnel>/callback   # real store
```

1. The CLI opens a local callback server and prints `https://store/wc-auth/v1/authorize?app_name=…&scope=read&user_id=<random state>&callback_url=…`.
2. The merchant opens it while logged in as an admin and clicks **Approve**.
3. WooCommerce generates a key and POSTs it to the callback. The connector checks that `user_id` matches the random state it sent (rejects forged callbacks) and that `key_permissions` is exactly `read` (rejects over-privileged keys), then saves it to `.credentials.json` with `0600` permissions.

Real WooCommerce only posts keys to an **HTTPS** callback, so for a real store expose the local port with a tunnel (ngrok, cloudflared) and pass its URL. In production this callback would live on Agent Studio's backend.

**2. Paste an API key** — In WooCommerce: *Settings → Advanced → REST API → Add key*, permission **Read**. Put the key and secret in `.env` as `WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET`.

On the wire (`WOO_AUTH_MODE=auto`): HTTP Basic auth for `https://` stores, OAuth 1.0a one-legged HMAC-SHA256 request signing for `http://` stores, as WooCommerce requires.

## Rate-limit handling

WooCommerce core has no API rate limit, but merchant hosts, CDNs and WAFs do, and shared hosting falls over under bursts. So the connector protects the store and handles throttling:

- **Client-side token bucket** (`WOO_RATE_LIMIT_RPS`, `WOO_RATE_LIMIT_BURST`) and a **concurrency cap** (`WOO_MAX_CONCURRENCY`) so an agent that fires many tool calls at once never floods the store.
- **Retries** on `429`, `502`, `503`, `504`, timeouts and network errors, with exponential backoff and jitter (`WOO_MAX_RETRIES`).
- **`Retry-After`** is honoured (seconds or HTTP date). On a `429` the whole limiter pauses, not just the one request.
- If the server asks for more than 30 s, the connector does **not** block the agent; it returns `rate_limited` with `retry_after_seconds` so the agent can tell the user.
- Tools that scan (`find_order_by_payment_id`, `list_low_stock`) have hard page caps, and `per_page` is capped at 50 to keep responses small for the model's context.

## Tools

| Tool | Purpose |
|---|---|
| `list_orders` | Filter by status (multiple), date range, customer, product; paginated |
| `search_orders` | Free-text: customer name, email, phone, address, product name |
| `get_order` | Full order: line items, totals, coupons, shipping, refunds, note |
| `get_order_notes` | Order timeline incl. payment gateway messages |
| `find_order_by_payment_id` | Razorpay `pay_…` / `order_…` ID → order |
| `list_products` | Filter by stock status, category, type |
| `search_products` | By text or exact SKU |
| `get_product` | Full product incl. variations' stock |
| `list_low_stock` | Products at/below their low-stock threshold |

The full MCP tool specification (names, descriptions, JSON Schemas, annotations) is generated from the running server into [`docs/mcp-tools.json`](docs/mcp-tools.json) (`npm run spec`). What the agent can and cannot do is in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md).

## Use it from an MCP client

```bash
npm run build
```

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "node",
      "args": ["/absolute/path/to/woo-agent-connector/dist/src/server.js"],
      "env": { "WOO_BASE_URL": "https://shop.example.com", "WOO_CONSUMER_KEY": "ck_…", "WOO_CONSUMER_SECRET": "cs_…" }
    }
  }
}
```

## Configuration

See [`.env.example`](.env.example). `.env` and `.credentials.json` are git-ignored.

## Project layout

```
src/server.ts        MCP server entry point
src/tools.ts         tool definitions, input schemas, agent-facing errors
src/woo.ts           WooCommerce operations (list/get/search/scan)
src/normalize.ts     response shaping and PII masking
src/http.ts          HTTP client: auth, retries, Retry-After, timeouts
src/rate-limiter.ts  token bucket + concurrency cap
src/auth.ts          Basic / OAuth 1.0a signing
src/connect.ts       /wc-auth approval flow CLI
mock/                fictional WooCommerce store for tests and demos
test/                node:test suites (unit, end-to-end over MCP, connect flow)
scripts/             demo, spec generation, test harness
```

## Assumptions

- WooCommerce 3.5+ with REST API v3 and pretty permalinks enabled (`/wp-json/` reachable).
- One connector process serves one store. Multi-tenant hosting is out of scope (see below).
- Payment gateway IDs are stored in the order's `transaction_id` or in order meta, which is what the Razorpay plugin and most gateways do. The connector matches any meta value, so it does not depend on a specific meta key name. The `_razorpay_*` keys in the mock data are illustrative.
- The mock is a faithful stand-in for the endpoints used, but it is not WooCommerce. I tested against the mock; a real store should be checked with `npm run connect` and a few tool calls before relying on it.

## Limitations

- Read-only by design; no write tools.
- `find_order_by_payment_id` and `list_low_stock` scan with page caps; on very large stores they may be inconclusive (they say so via `complete: false`).
- Per-variation stock is not included in `list_low_stock`.
- No caching; every tool call hits the store.
- Rate-limit state is per process, so several processes against one store don't coordinate.
- Stores with pretty permalinks disabled (`?rest_route=` URLs) are not supported; the connector reports `unexpected_response` with a hint.
- Credentials sit in a local file or environment variables.

## What production would look like

- **Hosted, multi-tenant connector**: callback endpoint on Agent Studio, keys encrypted in a secrets manager per merchant, per-merchant rate-limit buckets in Redis, key revocation handled (`401` → mark connection broken, prompt merchant to reconnect).
- **Webhooks instead of scans**: subscribe to `order.updated` / `product.updated` and keep a small index (payment ID → order, low-stock set), so lookups are instant and don't load the store.
- **Narrow, approved write tools** (e.g. "add a private note", "move paid-but-pending order to processing after verifying the payment with Razorpay's API"), each requiring human confirmation and logged.
- **Cross-check with Razorpay**: for "paid but pending" cases, confirm the payment status via Razorpay's Payments API before suggesting any action.
- **Observability**: per-tool latency, error codes, and 429 rates per merchant.
