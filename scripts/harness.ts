import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_KEY, DEFAULT_SECRET, type MockOptions, startMockStore } from "../mock/server.js";

export async function startHarness(mockOptions: MockOptions = {}, env: Record<string, string> = {}) {
  const store = await startMockStore(mockOptions);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      WOO_BASE_URL: store.url,
      WOO_CONSUMER_KEY: DEFAULT_KEY,
      WOO_CONSUMER_SECRET: DEFAULT_SECRET,
      WOO_CREDENTIALS_FILE: "/nonexistent/.credentials.json",
      WOO_RATE_LIMIT_RPS: "50",
      WOO_RATE_LIMIT_BURST: "50",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = res.content[0]?.text ?? "";
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: Boolean(res.isError), body };
  }

  return {
    store,
    client,
    call,
    async close() {
      await client.close();
      await store.close();
    },
  };
}
