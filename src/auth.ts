import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;

  if (!header?.startsWith("Basic ")) {
    return unauthorized(reply);
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (!safeEqual(username, config.ADMIN_USERNAME) || !safeEqual(password, config.ADMIN_PASSWORD)) {
    return unauthorized(reply);
  }
}

function unauthorized(reply: FastifyReply) {
  return reply
    .header("WWW-Authenticate", 'Basic realm="Someting Admin"')
    .code(401)
    .send("Authentication required");
}
