import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startHarness } from "../scripts/harness.js";

describe("rate limits and failures", () => {
  test("retries after a 429, honouring Retry-After, and still answers", async () => {
    const h = await startHarness();
    try {
      h.store.control.forcedFailures.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" });
      const started = Date.now();
      const { isError, body } = await h.call("list_orders", { per_page: 3 });
      assert.equal(isError, false);
      assert.equal(body.items.length, 3);
      assert.ok(Date.now() - started >= 1900, "should have waited for Retry-After twice");
      assert.equal(h.store.control.rateLimited, 2);
    } finally {
      await h.close();
    }
  });

  test("retries transient 503s with backoff", async () => {
    const h = await startHarness();
    try {
      h.store.control.forcedFailures.push({ status: 503 });
      const { isError } = await h.call("get_product", { product_id: 501 });
      assert.equal(isError, false);
    } finally {
      await h.close();
    }
  });

  test("gives up with rate_limited and retry_after_seconds when throttling persists", async () => {
    const h = await startHarness({}, { WOO_MAX_RETRIES: "1" });
    try {
      h.store.control.forcedFailures.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "7" });
      const { isError, body } = await h.call("list_orders", {});
      assert.equal(isError, true);
      assert.equal(body.error, "rate_limited");
      assert.equal(body.retry_after_seconds, 7);
    } finally {
      await h.close();
    }
  });

  test("does not sleep for absurd Retry-After values", async () => {
    const h = await startHarness();
    try {
      h.store.control.forcedFailures.push({ status: 429, retryAfter: "3600" });
      const started = Date.now();
      const { body } = await h.call("list_orders", {});
      assert.equal(body.error, "rate_limited");
      assert.equal(body.retry_after_seconds, 3600);
      assert.ok(Date.now() - started < 2000);
    } finally {
      await h.close();
    }
  });

  test("a scan stays under the store's rate limit window", async () => {
    const h = await startHarness({ rateLimit: { requests: 5, windowMs: 1000 } }, { WOO_RATE_LIMIT_RPS: "3", WOO_RATE_LIMIT_BURST: "2" });
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => h.call("get_product", { product_id: 501 + (i % 10) })),
      );
      assert.ok(results.every((r) => !r.isError));
      assert.ok(h.store.control.rateLimited <= 1, `client-side limiter should prevent most 429s, saw ${h.store.control.rateLimited}`);
    } finally {
      await h.close();
    }
  });
});

describe("authentication", () => {
  test("OAuth 1.0a signatures over HTTP are accepted (default for http:// stores)", async () => {
    const h = await startHarness();
    try {
      assert.equal((await h.call("list_products", { per_page: 1 })).isError, false);
    } finally {
      await h.close();
    }
  });

  test("Basic auth mode works", async () => {
    const h = await startHarness({}, { WOO_AUTH_MODE: "basic" });
    try {
      assert.equal((await h.call("list_products", { per_page: 1 })).isError, false);
    } finally {
      await h.close();
    }
  });

  test("a wrong secret yields auth_failed, without retrying", async () => {
    const h = await startHarness({}, { WOO_CONSUMER_SECRET: "cs_wrong" });
    try {
      const { isError, body } = await h.call("list_orders", {});
      assert.equal(isError, true);
      assert.equal(body.error, "auth_failed");
      assert.equal(h.store.control.apiRequests, 1);
    } finally {
      await h.close();
    }
  });

  test("missing credentials yield not_configured", async () => {
    const h = await startHarness({}, { WOO_CONSUMER_KEY: "", WOO_CONSUMER_SECRET: "" });
    try {
      const { body } = await h.call("list_orders", {});
      assert.equal(body.error, "not_configured");
      assert.equal(h.store.control.apiRequests, 0);
    } finally {
      await h.close();
    }
  });
});
