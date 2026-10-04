import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startMockStore } from "../mock/server.js";
import { runConnectFlow } from "../src/connect.js";
import { WooService } from "../src/woo.js";

let store: Awaited<ReturnType<typeof startMockStore>>;
const dir = mkdtempSync(join(tmpdir(), "woo-connect-"));

async function approveAs(authorizeUrl: string, tamper: (form: URLSearchParams) => void = () => {}) {
  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /would like to connect/);
  const form = new URL(authorizeUrl).searchParams;
  tamper(form);
  return fetch(`${store.url}/wc-auth/v1/access_granted`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
}

describe("store connection flow (/wc-auth/v1/authorize)", () => {
  before(async () => {
    store = await startMockStore();
  });
  after(async () => store.close());

  test("merchant approval delivers a read-only key that works against the API", async () => {
    const file = join(dir, "ok.json");
    let approval: Promise<Response> | undefined;
    const creds = await runConnectFlow({
      storeUrl: store.url,
      port: 18789,
      credentialsFile: file,
      timeoutMs: 10_000,
      onAuthorizeUrl: (url) => {
        const u = new URL(url);
        assert.equal(u.searchParams.get("scope"), "read");
        assert.match(u.searchParams.get("user_id")!, /^[0-9a-f]{32}$/);
        approval = approveAs(url);
      },
    });
    const redirect = await approval!;
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location")!, /\/done\?success=1/);

    assert.equal(creds.key_permissions, "read");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.consumer_key, creds.consumer_key);
    assert.equal(statSync(file).mode & 0o777, 0o600, "credentials file must not be world-readable");

    const woo = new WooService({
      baseUrl: store.url,
      credentials: { consumerKey: creds.consumer_key, consumerSecret: creds.consumer_secret },
      authMode: "auto",
      rateLimitRps: 10, rateLimitBurst: 10, maxConcurrency: 2, maxRetries: 0, timeoutMs: 5000, exposePii: false,
    });
    const orders = await woo.listOrders({ per_page: 1 });
    assert.equal(orders.items.length, 1);
  });

  test("a key with more than read access is refused", async () => {
    await assert.rejects(
      runConnectFlow({
        storeUrl: store.url,
        port: 18790,
        credentialsFile: join(dir, "rw.json"),
        timeoutMs: 10_000,
        onAuthorizeUrl: (url) => void approveAs(url, (f) => f.set("scope", "read_write")),
      }),
      /only accepts read-only keys/,
    );
  });

  test("a callback with the wrong state is ignored", async () => {
    const flow = runConnectFlow({
      storeUrl: store.url,
      port: 18791,
      credentialsFile: join(dir, "state.json"),
      timeoutMs: 1500,
      onAuthorizeUrl: async () => {
        const res = await fetch("http://localhost:18791/callback", {
          method: "POST",
          body: JSON.stringify({ user_id: "attacker", consumer_key: "ck_x", consumer_secret: "cs_x", key_permissions: "read", key_id: 1 }),
        });
        assert.equal(res.status, 400);
      },
    });
    await assert.rejects(flow, /Timed out/);
  });

  test("the store refuses non-HTTPS callbacks to remote hosts, like real WooCommerce", async () => {
    const res = await fetch(
      `${store.url}/wc-auth/v1/authorize?app_name=x&scope=read&user_id=1&return_url=http://a.test/&callback_url=http://evil.test/cb`,
    );
    assert.equal(res.status, 400);
  });
});