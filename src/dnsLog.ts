export type DnsAttempt = {
  at: string;
  provider: "wedos" | "active24";
  domain: string;
  subdomain: string;
  hostname: string;
  ip?: string;
  ttl?: number;
  ok: boolean;
  error?: string;
  durationMs: number;
};

const MAX_ATTEMPTS = 50;
const buffer: DnsAttempt[] = [];

export function recordDnsAttempt(attempt: DnsAttempt): void {
  buffer.unshift(attempt);
  if (buffer.length > MAX_ATTEMPTS) {
    buffer.length = MAX_ATTEMPTS;
  }

  const tag = attempt.ok ? "OK" : "FAIL";
  const line = `[dns:${attempt.provider}] ${tag} ${attempt.hostname} → ${attempt.ip ?? "?"} (${attempt.durationMs}ms)`;
  if (attempt.ok) {
    console.log(line);
  } else {
    console.error(`${line}\n  error: ${attempt.error ?? "(no message)"}`);
  }
}

export function listDnsAttempts(): DnsAttempt[] {
  return buffer.slice();
}
