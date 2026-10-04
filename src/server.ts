#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { WooService } from "./woo.js";

export function createServer() {
  const config = loadConfig();
  const server = new McpServer(
    { name: "woocommerce-connector", version: "1.0.0" },
    {
      instructions:
        "Read-only access to one merchant's WooCommerce store: orders, order notes and products/inventory. " +
        "It cannot create, update, refund or cancel anything. Customer emails and phones are masked. " +
        "Prefer narrow filters and small pages; the store is rate limited.",
    },
  );
  registerTools(server, new WooService(config));
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("woocommerce-connector MCP server running on stdio");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
