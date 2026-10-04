import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";
import { type Page, WooHttpClient } from "./http.js";
import { noteView, orderDetail, orderSummary, productDetail, productSummary } from "./normalize.js";
import type { WooOrder, WooOrderNote, WooProduct, WooSetting, WooVariation } from "./woo-types.js";

export interface Paging {
  page?: number;
  per_page?: number;
}

export interface OrderFilters extends Paging {
  status?: string[];
  after?: string;
  before?: string;
  customer_id?: number;
  product_id?: number;
  order?: "asc" | "desc";
}

export interface ProductFilters extends Paging {
  status?: string;
  stock_status?: string;
  category_id?: number;
  type?: string;
  orderby?: "date" | "title" | "price" | "popularity";
  order?: "asc" | "desc";
}

const SCAN_PAGE_SIZE = 100;

function listResult<T>(page: Page<unknown[]>, items: T[], paging: Paging) {
  const current = paging.page ?? 1;
  const totalPages = page.totalPages ?? current;
  return {
    items,
    page: current,
    per_page: paging.per_page,
    total: page.total ?? items.length,
    total_pages: totalPages,
    has_more: current < totalPages,
  };
}

function toIsoBoundary(value: string | undefined, endOfDay: boolean) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
  return value;
}

export class WooService {
  readonly http: WooHttpClient;

  constructor(private config: Config) {
    this.http = new WooHttpClient(config);
  }

  private get opts() {
    return { exposePii: this.config.exposePii };
  }

  private orderQuery(f: OrderFilters) {
    return {
      page: f.page ?? 1,
      per_page: f.per_page ?? 10,
      status: f.status?.length ? f.status.join(",") : undefined,
      after: toIsoBoundary(f.after, false),
      before: toIsoBoundary(f.before, true),
      customer: f.customer_id,
      product: f.product_id,
      orderby: "date",
      order: f.order ?? "desc",
    };
  }

  async listOrders(f: OrderFilters) {
    const q = this.orderQuery(f);
    const page = await this.http.get<WooOrder[]>("/orders", q);
    return listResult(page, page.data.map((o) => orderSummary(o, this.opts)), q);
  }

  async searchOrders(query: string, f: OrderFilters) {
    const q = { ...this.orderQuery(f), search: query };
    const page = await this.http.get<WooOrder[]>("/orders", q);
    return listResult(page, page.data.map((o) => orderSummary(o, this.opts)), q);
  }

  async getOrder(orderId: number) {
    const { data } = await this.http.get<WooOrder>(`/orders/${orderId}`);
    return orderDetail(data, this.opts);
  }

  async getOrderNotes(orderId: number) {
    const { data } = await this.http.get<WooOrderNote[]>(`/orders/${orderId}/notes`);
    return { order_id: orderId, notes: data.map(noteView) };
  }

  /**
   * Payment gateways (including Razorpay's WooCommerce plugin) store the gateway's payment ID in
   * transaction_id or order meta, and core search does not index either. We try search first, then
   * fall back to a bounded scan of recently modified orders.
   */
  async findOrderByPaymentId(paymentId: string, lookbackDays: number, maxPages: number) {
    const matches = (o: WooOrder) =>
      o.transaction_id === paymentId || (o.meta_data ?? []).some((m) => m.value === paymentId);

    const result = (found: WooOrder[], scanned: number, complete: boolean) => ({
      found: found.length > 0,
      orders: found.map((o) => orderDetail(o, this.opts)),
      scanned_orders: scanned,
      lookback_days: lookbackDays,
      complete,
    });

    const searched = await this.http.get<WooOrder[]>("/orders", { search: paymentId, per_page: 20 });
    const direct = searched.data.filter(matches);
    if (direct.length) return result(direct, searched.data.length, true);

    const after = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 19);
    let scanned = 0;
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.http.get<WooOrder[]>("/orders", {
        modified_after: after,
        per_page: SCAN_PAGE_SIZE,
        page,
        orderby: "date",
        order: "desc",
      });
      scanned += res.data.length;
      const hit = res.data.filter(matches);
      if (hit.length) return result(hit, scanned, true);
      if (page >= (res.totalPages ?? page)) return result([], scanned, true);
    }
    return result([], scanned, false);
  }

  private productQuery(f: ProductFilters) {
    return {
      page: f.page ?? 1,
      per_page: f.per_page ?? 10,
      status: f.status ?? "publish",
      stock_status: f.stock_status,
      category: f.category_id,
      type: f.type,
      orderby: f.orderby ?? "date",
      order: f.order ?? "desc",
    };
  }

  async listProducts(f: ProductFilters) {
    const q = this.productQuery(f);
    const page = await this.http.get<WooProduct[]>("/products", q);
    return listResult(page, page.data.map(productSummary), q);
  }

  async searchProducts(query: string | undefined, sku: string | undefined, f: ProductFilters) {
    if (!query && !sku) throw new ConnectorError("invalid_request", "Provide a search query or a SKU.");
    const q = { ...this.productQuery(f), search: query, sku };
    const page = await this.http.get<WooProduct[]>("/products", q);
    return listResult(page, page.data.map(productSummary), q);
  }

  async getProduct(productId: number) {
    const { data } = await this.http.get<WooProduct>(`/products/${productId}`);
    let variations: WooVariation[] = [];
    if (data.type === "variable") {
      variations = (await this.http.get<WooVariation[]>(`/products/${productId}/variations`, { per_page: 100 })).data;
    }
    return productDetail(data, variations);
  }

  private async storeLowStockThreshold(): Promise<number | undefined> {
    try {
      const { data } = await this.http.get<WooSetting>("/settings/products/woocommerce_notify_low_stock_amount");
      const value = Number(data.value);
      return Number.isFinite(value) ? value : undefined;
    } catch (err) {
      if (err instanceof ConnectorError && (err.code === "forbidden" || err.code === "not_found")) return undefined;
      throw err;
    }
  }

  async listLowStock(threshold: number | undefined, includeOutOfStock: boolean, maxPages: number) {
    const storeDefault = threshold === undefined ? await this.storeLowStockThreshold() : undefined;
    const globalThreshold = threshold ?? storeDefault ?? 2;

    const low: ReturnType<typeof productSummary>[] = [];
    let scanned = 0;
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.http.get<WooProduct[]>("/products", { status: "publish", per_page: SCAN_PAGE_SIZE, page, orderby: "id", order: "asc" });
      scanned += res.data.length;
      for (const p of res.data) {
        if (!p.manage_stock || p.stock_quantity === null) continue;
        const limit = threshold ?? p.low_stock_amount ?? globalThreshold;
        const isOut = p.stock_quantity <= 0;
        if ((isOut && includeOutOfStock) || (!isOut && p.stock_quantity <= limit)) low.push(productSummary(p));
      }
      if (page >= (res.totalPages ?? page)) {
        complete = true;
        break;
      }
    }
    low.sort((a, b) => (a.stock_quantity ?? 0) - (b.stock_quantity ?? 0));
    return {
      threshold_used: threshold !== undefined ? threshold : `per-product, else ${globalThreshold}`,
      items: low,
      scanned_products: scanned,
      complete,
      note: "Only products that track stock at product level are checked; per-variation stock is not scanned.",
    };
  }
}
