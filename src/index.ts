import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { Readable } from "node:stream";
import { ensureConfiguredAdminUser } from "./adminUsers.js";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { registerMcpHttpRoutes } from "./mcpHttp.js";
import { registerRoutes } from "./routes.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const app = Fastify({
  logger: true,
});

await app.register(formbody);

app.addHook("preParsing", async (request, _reply, payload) => {
  const pathOnly = request.url.split("?")[0] ?? "";
  if (pathOnly !== "/webhooks/github" || request.method !== "POST") {
    return payload;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of payload as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  request.rawBody = raw;
  return Readable.from(raw);
});

app.addHook("preHandler", async (request, reply) => {
  const pathOnly = request.url.split("?")[0] ?? "";
  if (request.url.startsWith("/healthz") || request.url.startsWith("/login")) {
    return;
  }
  if (pathOnly === "/favicon.svg" || pathOnly === "/favicon.ico") {
    return;
  }
  if (pathOnly === "/webhooks/github") {
    return;
  }

  return requireAdmin(request, reply);
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send(error instanceof Error ? error.message : "Unexpected error");
});

await migrate();
await ensureConfiguredAdminUser();
await registerMcpHttpRoutes(app);
await registerRoutes(app);

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });
