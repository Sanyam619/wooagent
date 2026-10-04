import type { WooOrder, WooOrderNote, WooProduct, WooVariation } from "../src/woo-types.js";

// All people, emails, phones and payment IDs here are fictional and generated.

function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const rand = prng(42);
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const id14 = () => Array.from({ length: 14 }, () => pick([..."ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789"])).join("");
const iso = (d: Date) => d.toISOString().slice(0, 19);

const FIRST = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Ananya", "Vikram", "Isha", "Arjun", "Sneha", "Kunal", "Priya", "Neel", "Tara", "Dev"];
const LAST = ["Sharma", "Iyer", "Nair", "Mehta", "Reddy", "Gupta", "Kapoor", "Das", "Joshi", "Bose", "Menon", "Rao"];
const CITIES: Array<[string, string, string]> = [
  ["Bengaluru", "KA", "560001"], ["Mumbai", "MH", "400001"], ["Pune", "MH", "411001"], ["Noida", "UP", "201301"],
  ["Hyderabad", "TS", "500001"], ["Chennai", "TN", "600001"], ["Kolkata", "WB", "700001"], ["Jaipur", "RJ", "302001"],
];
const CATEGORIES = [
  { id: 11, name: "Tea" },
  { id: 12, name: "Coffee" },
  { id: 13, name: "Brewing Gear" },
  { id: 14, name: "Gift Boxes" },
];

const PRODUCT_DEFS: Array<[string, number, number]> = [
  ["Darjeeling First Flush 100g", 11, 650], ["Assam Breakfast Blend 250g", 11, 420], ["Masala Chai Mix 200g", 11, 380],
  ["Nilgiri Frost Oolong 50g", 11, 720], ["Kashmiri Kahwa 100g", 11, 540], ["Chamomile Calm 50g", 11, 360],
  ["Chikmagalur Estate Beans 250g", 12, 590], ["Coorg Dark Roast 500g", 12, 980], ["Filter Coffee Decoction Blend 250g", 12, 450],
  ["Cold Brew Pack (5 bags)", 12, 499], ["Monsooned Malabar 250g", 12, 640], ["Pour-over Dripper", 13, 1250],
  ["Glass Teapot 600ml", 13, 1490], ["South Indian Filter (Steel)", 13, 699], ["Burr Grinder Manual", 13, 2899],
  ["Gooseneck Kettle 1L", 13, 3499], ["Tea Sampler Gift Box", 14, 1599], ["Coffee Lovers Gift Box", 14, 1899],
  ["Festive Hamper", 14, 2999], ["Bamboo Infuser Set", 13, 549], ["Lemongrass Green 100g", 11, 410],
  ["Espresso Roast 250g", 12, 620],
];

export const products: WooProduct[] = [];
export const variations = new Map<number, WooVariation[]>();

PRODUCT_DEFS.forEach(([name, cat, price], i) => {
  const id = 501 + i;
  const manage = i % 7 !== 6;
  const qty = manage ? pick([0, 1, 2, 3, 4, 6, 9, 15, 28, 40, 75]) : null;
  const onSale = i % 5 === 0;
  products.push({
    id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    sku: `KH-${String(cat)}${String(i + 1).padStart(3, "0")}`,
    type: "simple",
    status: i === 21 ? "draft" : "publish",
    permalink: `https://kettle-and-husk.example/product/${id}`,
    price: String(onSale ? Math.round(price * 0.85) : price),
    regular_price: String(price),
    sale_price: onSale ? String(Math.round(price * 0.85)) : "",
    on_sale: onSale,
    manage_stock: manage,
    stock_quantity: qty,
    stock_status: !manage ? "instock" : qty === 0 ? (i === 1 ? "onbackorder" : "outofstock") : "instock",
    low_stock_amount: i % 4 === 0 ? 10 : null,
    backorders: i % 2 ? "notify" : "no",
    short_description: `<p>${name}, sourced from small Indian estates.</p>`,
    categories: CATEGORIES.filter((c) => c.id === cat),
    date_modified: "2026-09-20T10:00:00",
  });
});

const tee: WooProduct = {
  id: 540,
  name: "Kettle & Husk Logo Tee",
  sku: "KH-TEE",
  type: "variable",
  status: "publish",
  permalink: "https://kettle-and-husk.example/product/540",
  price: "799",
  regular_price: "",
  sale_price: "",
  on_sale: false,
  manage_stock: false,
  stock_quantity: null,
  stock_status: "instock",
  low_stock_amount: null,
  backorders: "no",
  short_description: "<p>Organic cotton tee.</p>",
  categories: [],
  variations: [541, 542, 543],
  date_modified: "2026-09-18T09:00:00",
};
products.push(tee);
variations.set(540, [
  { id: 541, sku: "KH-TEE-S", price: "799", manage_stock: true, stock_quantity: 12, stock_status: "instock", attributes: [{ name: "Size", option: "S" }] },
  { id: 542, sku: "KH-TEE-M", price: "799", manage_stock: true, stock_quantity: 2, stock_status: "instock", attributes: [{ name: "Size", option: "M" }] },
  { id: 543, sku: "KH-TEE-L", price: "849", manage_stock: true, stock_quantity: 0, stock_status: "outofstock", attributes: [{ name: "Size", option: "L" }] },
]);

export const orders: WooOrder[] = [];
export const notes = new Map<number, WooOrderNote[]>();

const STATUS_WEIGHTS: Array<[string, number]> = [
  ["completed", 45], ["processing", 20], ["pending", 8], ["on-hold", 6], ["cancelled", 6], ["refunded", 5], ["failed", 10],
];
function weightedStatus() {
  let r = rand() * 100;
  for (const [s, w] of STATUS_WEIGHTS) if ((r -= w) < 0) return s;
  return "completed";
}

const now = new Date();
now.setUTCMinutes(0, 0, 0);
const customers = Array.from({ length: 18 }, (_, i) => {
  const first = FIRST[i % FIRST.length];
  const last = pick(LAST);
  const [city, state, postcode] = pick(CITIES);
  return {
    id: i < 12 ? 101 + i : 0,
    first,
    last,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
    phone: `+91 98${String(int(10000000, 99999999))}`,
    city,
    state,
    postcode,
  };
});

const sellable = products.filter((p) => p.type === "simple" && p.status === "publish");

for (let n = 0; n < 64; n++) {
  const id = 1001 + n;
  const c = pick(customers);
  const created = new Date(now.getTime() - (64 - n) * int(18, 26) * 3_600_000);
  const status = weightedStatus();
  const items = Array.from({ length: int(1, 3) }, (_, k) => {
    const p = pick(sellable);
    const qty = int(1, 3);
    return {
      id: id * 10 + k,
      name: p.name,
      product_id: p.id,
      variation_id: 0,
      quantity: qty,
      sku: p.sku,
      price: Number(p.price),
      subtotal: String(Number(p.price) * qty),
      total: (Number(p.price) * qty).toFixed(2),
    };
  });
  const subtotal = items.reduce((s, li) => s + Number(li.total), 0);
  const shipping = subtotal >= 999 ? 0 : 79;
  const discount = n % 9 === 0 ? Math.round(subtotal * 0.1) : 0;
  const total = subtotal - discount + shipping;
  const razorpay = n % 6 !== 0;
  const paid = ["completed", "processing", "refunded"].includes(status) || (status === "pending" && n % 2 === 0);
  const paymentId = razorpay && (paid || status === "failed") ? `pay_${id14()}` : "";
  const rzpOrderId = razorpay ? `order_${id14()}` : "";
  const created_s = iso(created);
  const modified = iso(new Date(created.getTime() + int(1, 30) * 3_600_000));

  orders.push({
    id,
    number: String(id),
    status,
    currency: "INR",
    date_created: created_s,
    date_modified: modified,
    date_paid: paid && status !== "pending" ? created_s : null,
    date_completed: status === "completed" ? modified : null,
    total: total.toFixed(2),
    total_tax: (total - total / 1.05).toFixed(2),
    shipping_total: shipping.toFixed(2),
    discount_total: discount.toFixed(2),
    payment_method: razorpay ? "razorpay" : "cod",
    payment_method_title: razorpay ? "Credit Card/Debit Card/NetBanking/UPI (Razorpay)" : "Cash on delivery",
    transaction_id: status === "pending" ? "" : paymentId,
    customer_id: c.id,
    customer_note: n % 11 === 0 ? "Please gift wrap, it's a birthday present." : "",
    billing: {
      first_name: c.first, last_name: c.last, address_1: `${int(1, 300)}, ${pick(["MG Road", "Park Street", "Linking Road", "Sector 18", "Anna Salai"])}`,
      city: c.city, state: c.state, postcode: c.postcode, country: "IN", email: c.email, phone: c.phone,
    },
    shipping: {
      first_name: c.first, last_name: c.last, address_1: `${int(1, 300)}, ${pick(["MG Road", "Park Street", "Linking Road", "Sector 18", "Anna Salai"])}`,
      city: c.city, state: c.state, postcode: c.postcode, country: "IN",
    },
    line_items: items,
    shipping_lines: [{ method_title: shipping ? "Standard Shipping" : "Free Shipping", total: shipping.toFixed(2) }],
    coupon_lines: discount ? [{ code: "WELCOME10", discount: discount.toFixed(2) }] : [],
    refunds: status === "refunded" ? [{ id: id * 100, reason: "Damaged in transit", total: `-${total.toFixed(2)}` }] : [],
    meta_data: rzpOrderId ? [{ id: id * 7, key: "_razorpay_order_id", value: rzpOrderId }, ...(status === "pending" && paymentId ? [{ id: id * 7 + 1, key: "_razorpay_payment_id", value: paymentId }] : [])] : [],
  });

  const timeline: WooOrderNote[] = [];
  const addNote = (text: string, minutes: number, customer = false, author = "system") =>
    timeline.push({ id: id * 10 + timeline.length, author, date_created: iso(new Date(created.getTime() + minutes * 60_000)), note: text, customer_note: customer });
  if (razorpay) addNote(`Razorpay order created: ${rzpOrderId}`, 0);
  if (status === "failed") addNote(`Razorpay payment failed${paymentId ? ` (${paymentId})` : ""}: payment authorization timed out. Order status changed from Pending payment to Failed.`, 3);
  if (status === "pending" && paymentId) addNote(`Razorpay webhook: payment ${paymentId} captured, but the order callback was not received.`, 4);
  if (paid && status !== "pending" && razorpay) addNote(`Razorpay payment successful. Razorpay Id: ${paymentId}`, 2);
  if (status === "processing" || status === "completed") addNote("Order status changed from Pending payment to Processing.", 5);
  if (status === "completed") addNote("Order shipped via Delhivery. Order status changed from Processing to Completed.", 60 * 24, true);
  if (status === "on-hold") addNote("Awaiting COD confirmation call. Order status changed from Pending payment to On hold.", 10, false, "Tara (staff)");
  if (status === "refunded") addNote("Refunded ₹" + total.toFixed(2) + " – Damaged in transit", 60 * 48, false, "Dev (staff)");
  if (status === "cancelled") addNote("Customer requested cancellation by phone.", 30, false, "Tara (staff)");
  notes.set(id, timeline.reverse());
}

export const settings = { woocommerce_notify_low_stock_amount: "5" };
