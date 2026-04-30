import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { registerMcpHttpRoutes } from "./mcpHttp.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({
  logger: true,
});

await app.register(formbody);

app.addHook("preHandler", async (request, reply) => {
  if (request.url.startsWith("/healthz") || request.url.startsWith("/login")) {
    return;
  }

  return requireAdmin(request, reply);
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send(error instanceof Error ? error.message : "Unexpected error");
});

await migrate();
await registerMcpHttpRoutes(app);
await registerRoutes(app);

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });
