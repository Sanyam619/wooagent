import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectorError } from "./errors.js";
import type { WooService } from "./woo.js";

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "checkout-draft"] as const;

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS");

const paging = {
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
  per_page: z.number().int().min(1).max(50).default(10).describe("Results per page (max 50). Keep small unless you need more."),
};

const orderFilters = {
  status: z.array(z.enum(ORDER_STATUSES)).optional().describe("Only orders in these statuses. Omit for all statuses."),
  after: dateInput.optional().describe("Only orders created on or after this date (store timezone)."),
  before: dateInput.optional().describe("Only orders created on or before this date (store timezone)."),
  customer_id: z.number().int().positive().optional().describe("Only orders from this registered customer ID."),
  product_id: z.number().int().positive().optional().describe("Only orders that contain this product ID."),
  order: z.enum(["asc", "desc"]).default("desc").describe("Sort by creation date. desc = newest first."),
  ...paging,
};

const orderId = z
  .union([z.number().int().positive(), z.string().regex(/^#?\d+$/)])
  .describe("Order ID, e.g. 1042 or \"#1042\".");

const productFilters = {
  stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional().describe("Only products with this stock status."),
  category_id: z.number().int().positive().optional().describe("Only products in this category ID."),
  type: z.enum(["simple", "variable", "grouped", "external"]).optional(),
  orderby: z.enum(["date", "title", "price", "popularity"]).default("date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  ...paging,
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const parseOrderId = (id: number | string) => (typeof id === "number" ? id : Number(id.replace("#", "")));

async function respond(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const error =
      err instanceof ConnectorError
        ? err
        : new ConnectorError("unexpected_response", err instanceof Error ? err.message : "Unknown error");
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(error.toAgentPayload(), null, 2) }] };
  }
}

export function registerTools(server: McpServer, woo: WooService) {
  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List the store's orders, newest first, with optional filters for status, date range, customer or product. " +
        "Returns compact summaries (status, totals, payment method, transaction ID, masked customer contact). " +
        "Use get_order for full line items, addresses and refunds.",
      inputSchema: orderFilters,
      annotations: readOnly,
    },
    (args) => respond(() => woo.listOrders(args)),
  );

  server.registerTool(
    "search_orders",
    {
      title: "Search orders",
      description:
        "Full-text search across orders by customer name, email, phone, address or product name. " +
        "Use this when a customer contacts support and you only know who they are. " +
        "Does NOT match payment gateway IDs (pay_...); use find_order_by_payment_id for those.",
      inputSchema: { query: z.string().min(2).describe("Text to search for, e.g. a customer email or surname."), ...orderFilters },
      annotations: readOnly,
    },
    ({ query, ...filters }) => respond(() => woo.searchOrders(query, filters)),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description:
        "Get one order in full: line items with SKUs, totals breakdown, coupons, shipping method, refunds, customer note and timestamps.",
      inputSchema: { order_id: orderId },
      annotations: readOnly,
    },
    ({ order_id }) => respond(() => woo.getOrder(parseOrderId(order_id))),
  );

  server.registerTool(
    "get_order_notes",
    {
      title: "Get order notes",
      description:
        "Get the timeline notes on an order: status changes, payment gateway messages (e.g. payment captured or failed), " +
        "and staff notes. Useful for explaining why an order is stuck in pending or on-hold.",
      inputSchema: { order_id: orderId },
      annotations: readOnly,
    },
    ({ order_id }) => respond(() => woo.getOrderNotes(parseOrderId(order_id))),
  );

  server.registerTool(
    "find_order_by_payment_id",
    {
      title: "Find order by payment ID",
      description:
        "Find the order linked to a payment gateway ID, such as a Razorpay payment ID (pay_...) or Razorpay order ID (order_...). " +
        "Use this when a customer says they paid but the order is not confirmed. Scans orders modified within lookback_days, so it can be slow. " +
        "found=false with complete=true means no order in that window has this ID; complete=false means the scan hit max_pages and is not conclusive.",
      inputSchema: {
        payment_id: z.string().min(4).max(64).regex(/^[A-Za-z0-9_\-]+$/).describe("The gateway payment or order ID."),
        lookback_days: z.number().int().min(1).max(90).default(30).describe("How far back to scan by last-modified date."),
        max_pages: z.number().int().min(1).max(10).default(5).describe("Upper bound on pages of 100 orders to scan."),
      },
      annotations: readOnly,
    },
    ({ payment_id, lookback_days, max_pages }) => respond(() => woo.findOrderByPaymentId(payment_id, lookback_days, max_pages)),
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List published products with price, stock status and stock quantity. Filter by stock status, category or type.",
      inputSchema: productFilters,
      annotations: readOnly,
    },
    (args) => respond(() => woo.listProducts(args)),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Find products by name/description text, or by exact SKU. Provide at least one of query or sku.",
      inputSchema: {
        query: z.string().min(2).optional().describe("Words from the product name or description."),
        sku: z.string().min(1).optional().describe("Exact SKU. Comma-separate to look up several."),
        ...productFilters,
      },
      annotations: readOnly,
    },
    ({ query, sku, ...filters }) => respond(() => woo.searchProducts(query, sku, filters)),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description:
        "Get one product in full, including regular/sale price, low-stock threshold, backorder policy and, for variable products, " +
        "each variation's attributes, price and stock.",
      inputSchema: { product_id: z.number().int().positive() },
      annotations: readOnly,
    },
    ({ product_id }) => respond(() => woo.getProduct(product_id)),
  );

  server.registerTool(
    "list_low_stock",
    {
      title: "List low-stock products",
      description:
        "List products that are at or below their low-stock threshold (or out of stock), lowest stock first. " +
        "Uses each product's own threshold, then the store default, unless you pass a threshold.",
      inputSchema: {
        threshold: z.number().int().min(0).optional().describe("Override: treat stock at or below this number as low."),
        include_out_of_stock: z.boolean().default(true),
        max_pages: z.number().int().min(1).max(20).default(10).describe("Upper bound on pages of 100 products to scan."),
      },
      annotations: readOnly,
    },
    ({ threshold, include_out_of_stock, max_pages }) =>
      respond(() => woo.listLowStock(threshold, include_out_of_stock, max_pages)),
  );
}
