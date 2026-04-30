import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate, pool } from "./db.js";
import { createMcpServer } from "./mcpServer.js";

await migrate();
const server = createMcpServer();
await server.connect(new StdioServerTransport());

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
