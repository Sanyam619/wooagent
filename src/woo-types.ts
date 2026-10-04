export interface WooAddress {
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  email?: string;
  phone?: string;
}

export interface WooMeta {
  id?: number;
  key: string;
  value: unknown;
}

export interface WooLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  sku?: string;
  price: number | string;
  subtotal?: string;
  total: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_created: string;
  date_modified?: string;
  date_paid: string | null;
  date_completed: string | null;
  total: string;
  total_tax?: string;
  shipping_total?: string;
  discount_total?: string;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  customer_id?: number;
  customer_note?: string;
  billing: WooAddress;
  shipping: WooAddress;
  line_items: WooLineItem[];
  shipping_lines?: Array<{ method_title: string; total: string }>;
  coupon_lines?: Array<{ code: string; discount: string }>;
  refunds?: Array<{ id: number; reason: string; total: string }>;
  meta_data?: WooMeta[];
}

export interface WooOrderNote {
  id: number;
  author: string;
  date_created: string;
  note: string;
  customer_note: boolean;
}

export interface WooProduct {
  id: number;
  name: string;
  slug?: string;
  sku: string;
  type: string;
  status: string;
  permalink?: string;
  price: string;
  regular_price: string;
  sale_price: string;
  on_sale?: boolean;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  low_stock_amount?: number | null;
  backorders?: string;
  short_description?: string;
  categories?: Array<{ id: number; name: string }>;
  variations?: number[];
  date_modified?: string;
}

export interface WooVariation {
  id: number;
  sku: string;
  price: string;
  manage_stock: boolean | "parent";
  stock_quantity: number | null;
  stock_status: string;
  attributes: Array<{ name: string; option: string }>;
}

export interface WooSetting {
  id: string;
  value: string;
}
