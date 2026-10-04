import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rfc3986, resolveAuthMode } from "../src/auth.js";
import { parseRetryAfter } from "../src/http.js";
import { maskEmail, maskPhone } from "../src/normalize.js";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  test("allows a burst, then spaces requests at the configured rate", async () => {
    const limiter = new RateLimiter(10, 3, 10);
    const times: number[] = [];
    const start = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => times.push(Date.now() - start))));
    times.sort((a, b) => a - b);
    assert.ok(times[2] < 50, "first three go immediately");
    assert.ok(times[5] >= 250, `remaining three are paced at ~100ms, last at ${times[5]}ms`);
  });

  test("caps concurrency", async () => {
    const limiter = new RateLimiter(1000, 1000, 2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );
    assert.equal(peak, 2);
  });

  test("pause() holds every caller", async () => {
    const limiter = new RateLimiter(1000, 1000, 10);
    limiter.pause(200);
    const start = Date.now();
    await limiter.run(async () => undefined);
    assert.ok(Date.now() - start >= 190);
  });
});

describe("helpers", () => {
  test("parseRetryAfter handles seconds, HTTP dates and junk", () => {
    assert.equal(parseRetryAfter("5"), 5);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
    const inTen = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(inTen)!;
    assert.ok(parsed > 8 && parsed <= 10);
  });

  test("masking keeps just enough to confirm identity", () => {
    assert.equal(maskEmail("meera.iyer@example.com"), "me***@example.com");
    assert.equal(maskPhone("+91 98123 45678"), "******5678");
    assert.equal(maskEmail(undefined), undefined);
  });

  test("RFC 3986 encoding covers characters encodeURIComponent leaves alone", () => {
    assert.equal(rfc3986("a b!*'()"), "a%20b%21%2A%27%28%29");
  });

  test("auto auth mode picks Basic for HTTPS and OAuth 1.0a for HTTP", () => {
    assert.equal(resolveAuthMode("auto", new URL("https://shop.test")), "basic");
    assert.equal(resolveAuthMode("auto", new URL("http://shop.test")), "oauth1");
  });
});
