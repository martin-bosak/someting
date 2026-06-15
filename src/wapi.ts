import { createHash } from "node:crypto";
import { config } from "./config.js";
import { assertDomainAssignedTo } from "./dnsConfig.js";

const WAPI_URL = "https://api.wedos.com/wapi/json/";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function wapiHour(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    hour12: false,
  }).format(new Date()).padStart(2, "0");
}

function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function buildAuth(user: string, password: string): string {
  return sha1(user + sha1(password) + wapiHour());
}

async function wapiCall(command: string, data: Record<string, unknown>) {
  if (!config.WEDOS_WAPI_USER || !config.WEDOS_WAPI_PASSWORD) {
    throw new Error("WEDOS WAPI credentials are not configured (set WEDOS_WAPI_USER and WEDOS_WAPI_PASSWORD).");
  }

  const payload = {
    request: {
      user: config.WEDOS_WAPI_USER,
      auth: buildAuth(config.WEDOS_WAPI_USER, config.WEDOS_WAPI_PASSWORD),
      command,
      data,
      clTRID: `someting-${Date.now()}`,
    },
  };

  console.log(`[wapi] -> ${command} user=${config.WEDOS_WAPI_USER} data=${JSON.stringify(data)}`);

  const res = await fetch(WAPI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: JSON.stringify(payload) }),
  });
  const raw = await res.text();
  console.log(`[wapi] <- ${command} HTTP ${res.status} body=${raw.slice(0, 2000)}`);

  if (!res.ok) {
    throw new Error(`WAPI ${command} HTTP ${res.status}: ${raw.slice(0, 2000)}`);
  }

  let parsed: { response?: { code?: number; result?: string; data?: unknown } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`WAPI ${command} returned non-JSON: ${raw.slice(0, 2000)}`);
  }

  const resp = parsed.response;
  const code = Number(resp?.code);
  if (!resp || !Number.isFinite(code) || code < 1000 || code >= 2000) {
    const detail = JSON.stringify(resp ?? parsed).slice(0, 2000);
    throw new Error(`WAPI ${command} failed (${resp?.code ?? "?"} ${resp?.result ?? "no result"}): ${detail}`);
  }
  return resp;
}

export async function createWedosARecord(opts: {
  domain: string;
  subdomain: string;
  ip?: string;
  ttl?: number;
}) {
  const domain = String(opts.domain || "").toLowerCase();
  await assertDomainAssignedTo(domain, "wedos");

  const subdomain = String(opts.subdomain || "").trim().toLowerCase();
  if (!subdomain || !SUBDOMAIN_RE.test(subdomain) || subdomain.length > 63) {
    throw new Error("Subdomain must be a DNS label like 'app' or 'foo.bar'.");
  }

  const ip = (opts.ip ?? config.WEDOS_A_RECORD_IP ?? "").trim();
  if (!IPV4_RE.test(ip)) {
    throw new Error("Target IPv4 is required (set WEDOS_A_RECORD_IP or pass ip).");
  }

  const ttl = opts.ttl && Number.isFinite(opts.ttl) ? Math.max(300, Math.floor(opts.ttl)) : 1800;

  const add = await wapiCall("dns-row-add", {
    domain,
    row: { name: subdomain, ttl, rdtype: "A", rdata: ip },
  });

  const commit = await wapiCall("dns-domain-commit", { name: domain });

  return {
    domain,
    subdomain,
    hostname: `${subdomain}.${domain}`,
    ip,
    ttl,
    add_code: Number(add?.code),
    commit_code: Number(commit?.code),
  };
}
