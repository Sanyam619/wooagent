import { orders } from "../mock/data.js";
import { startHarness } from "./harness.js";

const h = await startHarness({ rateLimit: { requests: 30, windowMs: 10_000 } });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function step(question: string, tool: string, args: Record<string, unknown>, show: (body: any) => string) {
  console.log(`\n${bold("Merchant asks:")} ${question}`);
  console.log(dim(`  → ${tool}(${JSON.stringify(args)})`));
  const { isError, body } = await h.call(tool, args);
  console.log(isError ? `  ✗ ${body.error}: ${body.message}\n    hint: ${body.hint}` : show(body));
}

try {
  const stuck = orders.find((o) => o.status === "pending" && o.meta_data?.some((m) => m.key === "_razorpay_payment_id"))!;
  const paymentId = stuck.meta_data!.find((m) => m.key === "_razorpay_payment_id")!.value as string;
  const customerEmail = orders[orders.length - 3].billing.email!;

  await step("How many orders failed payment this week?", "list_orders", {
    status: ["failed"],
    after: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
  }, (b) => `  ${b.total} failed orders:\n` + b.items.map((o: any) => `   #${o.id}  ₹${o.total}  ${o.customer.name}  ${o.created_at}`).join("\n"));

  await step(`A customer says they paid with ${paymentId} but got no confirmation.`, "find_order_by_payment_id", { payment_id: paymentId },
    (b) => b.found ? `  Order #${b.orders[0].id} is '${b.orders[0].status}', total ₹${b.orders[0].totals.grand_total}, scanned ${b.scanned_orders} orders` : `  Not found in last ${b.lookback_days} days (complete=${b.complete})`);

  await step("Why is that order still pending?", "get_order_notes", { order_id: stuck.id },
    (b) => b.notes.map((n: any) => `   [${n.created_at}] ${n.text}`).join("\n"));

  await step(`What has ${customerEmail} ordered?`, "search_orders", { query: customerEmail },
    (b) => b.items.map((o: any) => `   #${o.id} ${o.status.padEnd(10)} ₹${o.total}  ${o.items.join(", ")}`).join("\n"));

  await step("What do we need to restock?", "list_low_stock", {},
    (b) => b.items.map((p: any) => `   ${String(p.stock_quantity).padStart(3)}  ${p.name} (${p.sku}) ${p.stock_status}`).join("\n") + `\n  ${dim(b.note)}`);

  await step("Do we have the logo tee in medium?", "get_product", { product_id: 540 },
    (b) => b.variations.map((v: any) => `   Size ${v.attributes.Size}: ${v.stock_quantity} left (${v.stock_status})`).join("\n"));

  await step("Look up order #99999", "get_order", { order_id: "#99999" }, () => "");

  console.log(`\n${bold("Rate limiting:")} store throttles next 2 calls with 429 Retry-After: 1`);
  h.store.control.forcedFailures.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" });
  const t = Date.now();
  await step("List the 3 latest orders", "list_orders", { per_page: 3 },
    (b) => `  Recovered after ${((Date.now() - t) / 1000).toFixed(1)}s and returned ${b.items.length} orders`);
} finally {
  await h.close();
}
