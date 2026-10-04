import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CREDENTIALS_FILE } from "./config.js";

export interface ConnectOptions {
  storeUrl: string;
  port?: number;
  /** Public HTTPS URL that forwards to this machine's /callback. Real stores refuse non-HTTPS callbacks. */
  publicCallbackUrl?: string;
  appName?: string;
  timeoutMs?: number;
  onAuthorizeUrl?: (url: string) => void;
  credentialsFile?: string;
}

export interface StoredCredentials {
  base_url: string;
  consumer_key: string;
  consumer_secret: string;
  key_id: number;
  key_permissions: string;
  connected_at: string;
}

interface WooKeyPayload {
  key_id: number;
  user_id: string;
  consumer_key: string;
  consumer_secret: string;
  key_permissions: string;
}

async function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Payload too large");
  }
  return body;
}

export function buildAuthorizeUrl(storeUrl: string, state: string, callbackUrl: string, returnUrl: string, appName: string) {
  const url = new URL(`${storeUrl.replace(/\/+$/, "")}/wc-auth/v1/authorize`);
  url.searchParams.set("app_name", appName);
  url.searchParams.set("scope", "read");
  url.searchParams.set("user_id", state);
  url.searchParams.set("return_url", returnUrl);
  url.searchParams.set("callback_url", callbackUrl);
  return url.toString();
}

export function runConnectFlow(opts: ConnectOptions): Promise<StoredCredentials> {
  const port = opts.port ?? 8789;
  const state = randomBytes(16).toString("hex");
  const localBase = `http://localhost:${port}`;
  const callbackUrl = opts.publicCallbackUrl ?? `${localBase}/callback`;
  const authorizeUrl = buildAuthorizeUrl(opts.storeUrl, state, callbackUrl, `${localBase}/done`, opts.appName ?? "Agent Studio Connector");
  const file = opts.credentialsFile ?? CREDENTIALS_FILE;

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (err?: Error, creds?: StoredCredentials) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 200);
      err ? reject(err) : resolve(creds!);
    };

    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", localBase).pathname;

      if (req.method === "POST" && path === "/callback") {
        try {
          const payload = JSON.parse(await readBody(req)) as WooKeyPayload;
          if (payload.user_id !== state) {
            res.writeHead(400).end("state mismatch");
            return;
          }
          if (payload.key_permissions !== "read") {
            res.writeHead(400).end("read-only key required");
            finish(new Error(`Store granted '${payload.key_permissions}' access; this connector only accepts read-only keys. Revoke that key in WooCommerce.`));
            return;
          }
          const creds: StoredCredentials = {
            base_url: opts.storeUrl.replace(/\/+$/, ""),
            consumer_key: payload.consumer_key,
            consumer_secret: payload.consumer_secret,
            key_id: payload.key_id,
            key_permissions: payload.key_permissions,
            connected_at: new Date().toISOString(),
          };
          writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
          res.writeHead(200).end("ok");
          finish(undefined, creds);
        } catch (err) {
          res.writeHead(400).end("bad payload");
        }
        return;
      }

      if (req.method === "GET" && path === "/done") {
        res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Store connected.</h2><p>You can close this tab.</p>");
        return;
      }
      res.writeHead(404).end();
    });

    const timer = setTimeout(() => finish(new Error("Timed out waiting for the store to approve access")), opts.timeoutMs ?? 5 * 60_000);
    server.on("error", (err) => finish(err));
    server.listen(port, () => (opts.onAuthorizeUrl ?? console.log)(authorizeUrl));
  });
}

async function cli() {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      port: { type: "string", default: "8789" },
      "callback-url": { type: "string" },
    },
  });
  const storeUrl = values.store ?? process.env.WOO_BASE_URL;
  if (!storeUrl) {
    console.error("Usage: npm run connect -- --store https://shop.example.com [--callback-url https://<tunnel>/callback]");
    process.exit(1);
  }
  if (storeUrl.startsWith("https://") && !values["callback-url"]) {
    console.warn(
      "Note: WooCommerce only posts keys to an HTTPS callback. For a real store, expose port " +
        `${values.port} with a tunnel and pass --callback-url https://<tunnel>/callback\n`,
    );
  }
  const creds = await runConnectFlow({
    storeUrl,
    port: Number(values.port),
    publicCallbackUrl: values["callback-url"],
    onAuthorizeUrl: (url) => console.log(`Open this URL as a store admin and click "Approve":\n\n  ${url}\n\nWaiting for approval...`),
  });
  console.log(`\nConnected to ${creds.base_url} with a read-only key (key_id ${creds.key_id}). Saved to ${CREDENTIALS_FILE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
