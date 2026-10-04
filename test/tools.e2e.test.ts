import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { orders } from "../mock/data.js";
import { startHarness } from "../scripts/harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

describe("tool discovery", () => {
  test("exposes nine read-only tools with input schemas", async () => {
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "find_order_by_payment_id", "get_order", "get_order_notes", "get_product", "list_low_stock",
      "list_orders", "list_products", "search_orders", "search_products",
    ]);
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
      assert.equal(t.inputSchema.type, "object");
      assert.ok((t.description ?? "").length > 40, `${t.name} needs a useful description`);
    }
  });
});

describe("orders", () => {
  test("list_orders returns newest first with pagination metadata", async () => {
    const { isError, body } = await h.call("list_orders", { per_page: 5 });
    assert.equal(isError, false);
    assert.equal(body.items.length, 5);
    assert.equal(body.total, orders.length);
    assert.equal(body.has_more, true);
    const dates = body.items.map((o: any) => o.created_at);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  test("list_orders pages do not overlap", async () => {
    const p1 = await h.call("list_orders", { per_page: 10, page: 1 });
    const p2 = await h.call("list_orders", { per_page: 10, page: 2 });
    const ids1 = new Set(p1.body.items.map((o: any) => o.id));
    assert.ok(p2.body.items.every((o: any) => !ids1.has(o.id)));
    assert.equal(p2.body.page, 2);
  });

  test("list_orders filters by multiple statuses", async () => {
    const { body } = await h.call("list_orders", { status: ["failed", "pending"], per_page: 50 });
    const expected = orders.filter((o) => ["failed", "pending"].includes(o.status)).length;
    assert.equal(body.total, expected);
    assert.ok(body.items.every((o: any) => ["failed", "pending"].includes(o.status)));
  });

  test("list_orders filters by date range", async () => {
    const target = orders[30].date_created.slice(0, 10);
    const { body } = await h.call("list_orders", { after: target, before: target, per_page: 50 });
    assert.ok(body.items.length >= 1);
    assert.ok(body.items.every((o: any) => o.created_at.startsWith(target)));
  });

  test("customer contact details are masked by default", async () => {
    const { body } = await h.call("list_orders", { per_page: 1 });
    const c = body.items[0].customer;
    assert.match(c.email, /^\w{2}\*\*\*@example\.com$/);
    assert.match(c.phone, /^\*{6}\d{4}$/);
  });

  test("search_orders finds a customer's orders by email", async () => {
    const email = orders[10].billing.email!;
    const { body } = await h.call("search_orders", { query: email });
    const expected = orders.filter((o) => o.billing.email === email).length;
    assert.equal(body.total, expected);
    assert.ok(body.items.length > 0);
  });

  test("get_order returns full detail and accepts '#1234' style IDs", async () => {
    const source = orders.find((o) => o.coupon_lines?.length)!;
    const { isError, body } = await h.call("get_order", { order_id: `#${source.id}` });
    assert.equal(isError, false);
    assert.equal(body.id, source.id);
    assert.equal(body.line_items.length, source.line_items.length);
    assert.deepEqual(body.coupons, ["WELCOME10"]);
    assert.equal(body.billing_address.line1, undefined, "street address hidden without WOO_EXPOSE_PII");
    assert.ok(body.billing_address.city);
  });

  test("get_order on a missing order returns a not_found error the agent can act on", async () => {
    const { isError, body } = await h.call("get_order", { order_id: 999999 });
    assert.equal(isError, true);
    assert.equal(body.error, "not_found");
    assert.ok(body.hint);
  });

  test("get_order_notes shows the payment timeline", async () => {
    const failed = orders.find((o) => o.status === "failed" && o.payment_method === "razorpay")!;
    const { body } = await h.call("get_order_notes", { order_id: failed.id });
    assert.ok(body.notes.some((n: any) => /payment failed/i.test(n.text)));
  });

  test("find_order_by_payment_id finds an order stuck in pending after payment", async () => {
    const stuck = orders.find((o) => o.status === "pending" && o.meta_data?.some((m) => m.key === "_razorpay_payment_id"))!;
    assert.ok(stuck, "seed data should contain a paid-but-pending order");
    const paymentId = stuck.meta_data!.find((m) => m.key === "_razorpay_payment_id")!.value as string;
    const { body } = await h.call("find_order_by_payment_id", { payment_id: paymentId });
    assert.equal(body.found, true);
    assert.equal(body.orders[0].id, stuck.id);
    assert.equal(body.orders[0].status, "pending");
  });

  test("find_order_by_payment_id matches transaction_id", async () => {
    const paid = [...orders].reverse().find((o) => o.transaction_id?.startsWith("pay_") && o.status === "completed")!;
    const { body } = await h.call("find_order_by_payment_id", { payment_id: paid.transaction_id! });
    assert.equal(body.found, true);
    assert.equal(body.orders[0].id, paid.id);
  });

  test("find_order_by_payment_id reports a conclusive miss", async () => {
    const { body } = await h.call("find_order_by_payment_id", { payment_id: "pay_DoesNotExist00" });
    assert.equal(body.found, false);
    assert.equal(body.complete, true);
  });

  test("find_order_by_payment_id is honest when the scan is cut short", async () => {
    const { body } = await h.call("find_order_by_payment_id", { payment_id: "pay_DoesNotExist00", lookback_days: 90, max_pages: 1 });
    assert.equal(body.found, false);
    assert.equal(body.complete, true, "64 orders fit in one page of 100");
    const tight = await h.call("find_order_by_payment_id", { payment_id: "pay_OlderThanWindow", lookback_days: 1 });
    assert.equal(tight.body.lookback_days, 1);
    assert.ok(tight.body.scanned_orders < 64);
  });

  test("invalid input is rejected before reaching the store", async () => {
    const before = h.store.control.apiRequests;
    const { isError } = await h.call("list_orders", { per_page: 500 });
    assert.equal(isError, true);
    const bad = await h.call("list_orders", { after: "last tuesday" });
    assert.equal(bad.isError, true);
    assert.equal(h.store.control.apiRequests, before);
  });
});

describe("products and inventory", () => {
  test("list_products excludes drafts and supports stock filter", async () => {
    const { body } = await h.call("list_products", { stock_status: "outofstock", per_page: 50 });
    assert.ok(body.items.length > 0);
    assert.ok(body.items.every((p: any) => p.stock_status === "outofstock" && p.status === "publish"));
  });

  test("search_products by text and by SKU", async () => {
    const byText = await h.call("search_products", { query: "chai" });
    assert.ok(byText.body.items.some((p: any) => p.name.includes("Chai")));
    const bySku = await h.call("search_products", { sku: "KH-TEE" });
    assert.equal(bySku.body.items.length, 1);
    const neither = await h.call("search_products", {});
    assert.equal(neither.isError, true);
    assert.equal(neither.body.error, "invalid_request");
  });

  test("get_product includes variations for variable products", async () => {
    const { body } = await h.call("get_product", { product_id: 540 });
    assert.equal(body.type, "variable");
    assert.equal(body.variations.length, 3);
    assert.deepEqual(body.variations.map((v: any) => v.attributes.Size), ["S", "M", "L"]);
  });

  test("list_low_stock respects per-product and store thresholds", async () => {
    const { body } = await h.call("list_low_stock", {});
    assert.equal(body.complete, true);
    assert.ok(body.items.length > 0);
    const qtys = body.items.map((p: any) => p.stock_quantity);
    assert.deepEqual(qtys, [...qtys].sort((a: number, b: number) => a - b));
    assert.ok(body.items.every((p: any) => p.stock_quantity <= 10));
  });

  test("list_low_stock with explicit threshold and no out-of-stock items", async () => {
    const { body } = await h.call("list_low_stock", { threshold: 3, include_out_of_stock: false });
    assert.ok(body.items.every((p: any) => p.stock_quantity > 0 && p.stock_quantity <= 3));
  });
});
