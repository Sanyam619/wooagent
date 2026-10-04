import { writeFileSync } from "node:fs";
import { startHarness } from "./harness.js";

const h = await startHarness();
try {
  const { tools } = await h.client.listTools();
  const info = h.client.getServerVersion();
  const spec = {
    server: info,
    instructions: h.client.getInstructions(),
    transport: "stdio",
    tools,
  };
  writeFileSync("docs/mcp-tools.json", JSON.stringify(spec, null, 2) + "\n");
  console.log(`Wrote docs/mcp-tools.json (${tools.length} tools)`);
} finally {
  await h.close();
}
