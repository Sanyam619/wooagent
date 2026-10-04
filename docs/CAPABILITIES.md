# What the agent can and cannot do

This connector gives an Agent Studio agent **read-only** access to one merchant's WooCommerce store.

## The agent can

| Merchant / support question | Tool |
|---|---|
| "Show me today's / this week's failed or pending orders" | `list_orders` (status + date filters) |
| "What has meera@… ordered?" / "Find Rohan Iyer's order" | `search_orders` |
| "What's in order #1042, was a coupon used, was it refunded?" | `get_order` |
| "Why is this order stuck in pending?" | `get_order_notes` (gateway messages, status changes, staff notes) |
| "Customer paid with `pay_…` but got no confirmation" | `find_order_by_payment_id` |
| "Which teas are out of stock?" | `list_products` (stock filter) |
| "Find the SKU KH-12008" / "Do we sell a gooseneck kettle?" | `search_products` |
| "Is the tee available in medium?" | `get_product` (includes variations) |
| "What should we restock?" | `list_low_stock` |

Every tool returns either compact JSON or a structured error the agent can reason about:

```json
{ "error": "rate_limited", "message": "...", "hint": "The store is throttling requests. Wait before retrying...", "retry_after_seconds": 7 }
```

Error codes: `not_configured`, `auth_failed`, `forbidden`, `not_found`, `invalid_request`, `rate_limited`, `upstream_unavailable`, `timeout`, `unexpected_response`.

## The agent cannot

- **Change anything.** No creating, editing, cancelling or refunding orders, no stock updates, no customer changes. The connector only issues `GET` requests, and the connect flow refuses keys with more than `read` permission. If a merchant wants the agent to act (e.g. mark the stuck order as processing), a human does it or a separate, explicitly approved write tool is added later.
- **See full customer contact details by default.** Emails and phones are masked (`me***@example.com`, `******5678`) and street addresses are dropped; city/state/postcode remain so support can confirm identity. `WOO_EXPOSE_PII=true` lifts this for merchants who need it.
- **Read customers, coupons, reports, tax or shipping settings, webhooks, or plugin data** other than what appears on orders and products.
- **Read other stores.** One connector instance = one store = one key.
- **Answer aggregate analytics reliably** ("total revenue this quarter"). It can page through orders, but this is slow and capped. WooCommerce Analytics is the right source for that.

## Known edge cases the agent should be aware of

- **Payment ID lookup is a bounded scan.** WooCommerce search does not index `transaction_id` or order meta, so `find_order_by_payment_id` scans orders modified in the last `lookback_days` (default 30, up to 500 orders). `complete: false` means "not conclusive", not "doesn't exist".
- **Low stock ignores per-variation stock** unless the agent calls `get_product` on a variable product.
- **Order numbers.** `get_order` takes the internal order ID. Stores using a sequential-order-number plugin display a different number; use `search_orders` with the number in that case.
- **Times are store-local** (WooCommerce returns `date_created` in the store timezone).
- **Currency** is per order (`currency` field); the connector does not convert.
