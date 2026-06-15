import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { assertDomainAssignedTo } from "./dnsConfig.js";

const ACTIVE24_BASE = "https://api.active24.com";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function rfc1123(date: Date = new Date()): string {
  return date.toUTCString();
}

function sign(secret: string, method: string, canonicalPath: string, date: string): string {
  return createHmac("sha256", secret).update(`${method} ${canonicalPath} ${date}`, "utf8").digest("base64");
}

async function active24Call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  if (!config.ACTIVE24_API_ID || !config.ACTIVE24_API_SECRET) {
    throw new Error("Active24 API credentials are not configured (set ACTIVE24_API_ID and ACTIVE24_API_SECRET).");
  }

  const date = rfc1123();
  const signature = sign(config.ACTIVE24_API_SECRET, method, path, date);
  const headers: Record<string, string> = {
    Date: date,
    Authorization: `${config.ACTIVE24_API_ID} ${signature}`,
    Accept: "application/json",
  };

  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  console.log(`[active24] -> ${method} ${path} body=${payload ?? ""}`);

  const res = await fetch(`${ACTIVE24_BASE}${path}`, { method, headers, body: payload });
  const raw = await res.text();
  console.log(`[active24] <- ${method} ${path} HTTP ${res.status} body=${raw.slice(0, 2000)}`);

  if (!res.ok) {
    let message: string = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? raw;
    } catch {
      // keep raw
    }
    throw new Error(`Active24 ${method} ${path} HTTP ${res.status}: ${String(message).slice(0, 2000)}`);
  }

  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function createActive24ARecord(opts: {
  domain: string;
  subdomain: string;
  ip?: string;
  ttl?: number;
}) {
  const domain = String(opts.domain || "").toLowerCase();
  await assertDomainAssignedTo(domain, "active24");

  const subdomain = String(opts.subdomain || "").trim().toLowerCase();
  if (!subdomain || !SUBDOMAIN_RE.test(subdomain) || subdomain.length > 63) {
    throw new Error("Subdomain must be a DNS label like 'app' or 'foo.bar'.");
  }

  const ip = (opts.ip ?? config.ACTIVE24_A_RECORD_IP ?? config.WEDOS_A_RECORD_IP ?? "").trim();
  if (!IPV4_RE.test(ip)) {
    throw new Error("Target IPv4 is required (set ACTIVE24_A_RECORD_IP or pass ip).");
  }

  const ttl = opts.ttl && Number.isFinite(opts.ttl) ? Math.max(300, Math.floor(opts.ttl)) : 1800;
  const hostname = `${subdomain}.${domain}`;

  await active24Call("POST", `/dns/${domain}/a/v1`, {
    name: hostname,
    ip,
    ttl,
  });

  return {
    domain,
    subdomain,
    hostname,
    ip,
    ttl,
    provider: "active24" as const,
  };
}
