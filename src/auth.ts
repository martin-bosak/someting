import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const sessionCookieName = "someting_session";
const sessionTtlSeconds = 12 * 60 * 60;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAdminCredentials(username: string, password: string) {
  return safeEqual(username, config.ADMIN_USERNAME) && safeEqual(password, config.ADMIN_PASSWORD);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;

  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (verifyAdminCredentials(username, password)) {
      return;
    }

    return unauthorized(request, reply);
  }

  if (hasValidSession(request)) {
    return;
  }

  if (request.url.startsWith("/mcp")) {
    return unauthorized(request, reply);
  }

  return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
}

export function createSessionCookie(username: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds;
  const payload = Buffer.from(JSON.stringify({ username, expiresAt })).toString("base64url");
  const signature = sign(payload);
  return `${sessionCookieName}=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds}`;
}

export function clearSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function hasValidSession(request: FastifyRequest) {
  const token = parseCookies(request.headers.cookie ?? "")[sessionCookieName];
  if (!token) {
    return false;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) {
    return false;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: string;
      expiresAt?: number;
    };

    return session.username === config.ADMIN_USERNAME && Number(session.expiresAt) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function parseCookies(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function sign(payload: string) {
  return createHmac("sha256", config.SESSION_SECRET ?? config.ADMIN_PASSWORD).update(payload).digest("base64url");
}

function unauthorized(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .header("WWW-Authenticate", 'Basic realm="Someting Admin"')
    .code(401)
    .send("Authentication required");
}
