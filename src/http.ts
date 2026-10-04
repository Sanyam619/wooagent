import { applyAuth } from "./auth.js";
import type { Config } from "./config.js";
import { ConnectorError, errorFromStatus } from "./errors.js";
import { RateLimiter } from "./rate-limiter.js";

export type Query = Record<string, string | number | boolean | undefined>;

export interface Page<T> {
  data: T;
  total?: number;
  totalPages?: number;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_WAIT_MS = 30_000;
const API_PREFIX = "/wp-json/wc/v3";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function backoffMs(attempt: number) {
  const base = Math.min(MAX_WAIT_MS, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class WooHttpClient {
  private limiter: RateLimiter;
  public stats = { requests: 0, retries: 0 };

  constructor(private config: Config) {
    this.limiter = new RateLimiter(config.rateLimitRps, config.rateLimitBurst, config.maxConcurrency);
  }

  async get<T>(path: string, query: Query = {}): Promise<Page<T>> {
    const creds = this.config.credentials;
    if (!creds) throw new ConnectorError("not_configured", "No WooCommerce API credentials are configured.");

    for (let attempt = 0; ; attempt++) {
      const url = new URL(`${this.config.baseUrl}${API_PREFIX}${path}`);
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      const headers = { Accept: "application/json", ...applyAuth("GET", url, creds, this.config.authMode) };

      let response: Response;
      try {
        this.stats.requests++;
        response = await this.limiter.run(() =>
          fetch(url, { headers, signal: AbortSignal.timeout(this.config.timeoutMs) }),
        );
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (attempt < this.config.maxRetries) {
          this.stats.retries++;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw isTimeout
          ? new ConnectorError("timeout", `Store did not respond within ${this.config.timeoutMs}ms`)
          : new ConnectorError("upstream_unavailable", `Could not reach the store: ${(err as Error).message}`);
      }

      if (response.ok) return this.parse<T>(response);

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const body = await response.json().catch(() => undefined);

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
        if (waitMs <= MAX_WAIT_MS) {
          this.stats.retries++;
          if (response.status === 429) this.limiter.pause(waitMs);
          await sleep(waitMs);
          continue;
        }
      }
      throw errorFromStatus(response.status, body, retryAfter !== undefined ? Math.ceil(retryAfter) : undefined);
    }
  }

  private async parse<T>(response: Response): Promise<Page<T>> {
    const text = await response.text();
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ConnectorError(
        "unexpected_response",
        "The store returned non-JSON content. The REST API may be blocked by a firewall or pretty permalinks may be disabled.",
        { status: response.status },
      );
    }
    const total = response.headers.get("x-wp-total");
    const totalPages = response.headers.get("x-wp-totalpages");
    return {
      data,
      total: total !== null ? Number(total) : undefined,
      totalPages: totalPages !== null ? Number(totalPages) : undefined,
    };
  }
}
