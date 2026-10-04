export type ErrorCode =
  | "not_configured"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "upstream_unavailable"
  | "timeout"
  | "unexpected_response";

const HINTS: Record<ErrorCode, string> = {
  not_configured: "The store is not connected yet. Ask the merchant to run `npm run connect` or provide a read-only API key.",
  auth_failed: "The API key was rejected. It may have been revoked; ask the merchant to reconnect the store.",
  forbidden: "The API key lacks permission for this resource. A key with 'read' permission is required.",
  not_found: "Nothing exists with that identifier. Double-check the ID, or use a search tool instead.",
  invalid_request: "The store rejected the parameters. Adjust the filters and try again.",
  rate_limited: "The store is throttling requests. Wait before retrying and avoid broad scans.",
  upstream_unavailable: "The store is temporarily unavailable. Tell the user and try again later.",
  timeout: "The store took too long to respond. Narrow the query (smaller per_page, tighter dates) and retry.",
  unexpected_response: "The store returned something unexpected. Do not guess; report that the data could not be read.",
};

export class ConnectorError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: { status?: number; retryAfterSeconds?: number; upstreamCode?: string } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
  }

  toAgentPayload() {
    return {
      error: this.code,
      message: this.message,
      hint: HINTS[this.code],
      ...(this.details.retryAfterSeconds !== undefined && { retry_after_seconds: this.details.retryAfterSeconds }),
    };
  }
}

export function errorFromStatus(status: number, body: unknown, retryAfterSeconds?: number): ConnectorError {
  const upstream = (body && typeof body === "object" ? body : {}) as { code?: string; message?: string };
  const message = upstream.message ? stripHtml(upstream.message) : `HTTP ${status}`;
  const details = { status, upstreamCode: upstream.code, retryAfterSeconds };
  if (status === 401) return new ConnectorError("auth_failed", message, details);
  if (status === 403) return new ConnectorError("forbidden", message, details);
  if (status === 404) return new ConnectorError("not_found", message, details);
  if (status === 429) return new ConnectorError("rate_limited", message, details);
  if (status === 400) return new ConnectorError("invalid_request", message, details);
  if (status >= 500) return new ConnectorError("upstream_unavailable", message, details);
  return new ConnectorError("unexpected_response", message, details);
}

function stripHtml(text: string) {
  return text.replace(/<[^>]+>/g, "").trim();
}
