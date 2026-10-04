import type { WooAddress, WooOrder, WooOrderNote, WooProduct, WooVariation } from "./woo-types.js";

export interface NormalizeOptions {
  exposePii: boolean;
}

export function maskEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

export function maskPhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `******${digits.slice(-4)}`;
}

function stripHtml(html?: string, max = 400): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const fullName = (a: WooAddress) => [a.first_name, a.last_name].filter(Boolean).join(" ") || undefined;

function address(a: WooAddress, opts: NormalizeOptions) {
  const region = { city: a.city || undefined, state: a.state || undefined, postcode: a.postcode || undefined, country: a.country || undefined };
  if (!opts.exposePii) return region;
  return { line1: a.address_1 || undefined, line2: a.address_2 || undefined, ...region };
}

function customer(order: WooOrder, opts: NormalizeOptions) {
  return {
    name: fullName(order.billing),
    email: opts.exposePii ? order.billing.email : maskEmail(order.billing.email),
    phone: opts.exposePii ? order.billing.phone : maskPhone(order.billing.phone),
    customer_id: order.customer_id || null,
  };
}

export function orderSummary(order: WooOrder, opts: NormalizeOptions) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    created_at: order.date_created,
    paid_at: order.date_paid,
    total: order.total,
    currency: order.currency,
    payment_method: order.payment_method_title || order.payment_method,
    transaction_id: order.transaction_id || null,
    customer: customer(order, opts),
    items: order.line_items.slice(0, 5).map((li) => `${li.name} x${li.quantity}`),
    item_count: order.line_items.reduce((n, li) => n + li.quantity, 0),
  };
}

export function orderDetail(order: WooOrder, opts: NormalizeOptions) {
  const refunded = (order.refunds ?? []).reduce((sum, r) => sum + Math.abs(Number(r.total)), 0);
  return {
    ...orderSummary(order, opts),
    items: undefined,
    modified_at: order.date_modified,
    completed_at: order.date_completed,
    line_items: order.line_items.map((li) => ({
      name: li.name,
      sku: li.sku || null,
      product_id: li.product_id,
      variation_id: li.variation_id || null,
      quantity: li.quantity,
      unit_price: String(li.price),
      total: li.total,
    })),
    totals: {
      discount: order.discount_total,
      shipping: order.shipping_total,
      tax: order.total_tax,
      grand_total: order.total,
      refunded: refunded.toFixed(2),
    },
    coupons: (order.coupon_lines ?? []).map((c) => c.code),
    shipping_method: order.shipping_lines?.map((s) => s.method_title).join(", ") || null,
    billing_address: address(order.billing, opts),
    shipping_address: address(order.shipping, opts),
    customer_note: order.customer_note || null,
    refunds: (order.refunds ?? []).map((r) => ({ amount: Math.abs(Number(r.total)).toFixed(2), reason: r.reason || null })),
  };
}

export function noteView(note: WooOrderNote) {
  return {
    id: note.id,
    created_at: note.date_created,
    author: note.author,
    visibility: note.customer_note ? "sent_to_customer" : "private",
    text: stripHtml(note.note, 1000),
  };
}

export function productSummary(p: WooProduct) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    type: p.type,
    status: p.status,
    price: p.price,
    on_sale: p.on_sale ?? (p.sale_price !== "" && p.sale_price !== p.regular_price),
    stock_status: p.stock_status,
    stock_quantity: p.manage_stock ? p.stock_quantity : null,
    tracks_stock: p.manage_stock,
    categories: (p.categories ?? []).map((c) => c.name),
  };
}

export function productDetail(p: WooProduct, variations: WooVariation[] = []) {
  return {
    ...productSummary(p),
    regular_price: p.regular_price,
    sale_price: p.sale_price || null,
    low_stock_threshold: p.low_stock_amount ?? null,
    backorders: p.backorders,
    description: stripHtml(p.short_description),
    url: p.permalink,
    modified_at: p.date_modified,
    variations: variations.map((v) => ({
      id: v.id,
      sku: v.sku || null,
      attributes: Object.fromEntries(v.attributes.map((a) => [a.name, a.option])),
      price: v.price,
      stock_status: v.stock_status,
      stock_quantity: v.manage_stock ? v.stock_quantity : null,
    })),
  };
}
