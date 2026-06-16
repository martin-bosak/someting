import { config } from "./config.js";

export type AlertLevel = "info" | "warning" | "error";

export type AlertPayload = {
  level: AlertLevel;
  title: string;
  message: string;
  target?: string;
  detail?: string;
};

const lastAlerts = new Map<string, number>();
const DEDUPE_MS = 60 * 60 * 1000;

/** Best-effort outbound alert; never throws. */
export async function sendAlert(payload: AlertPayload, dedupeKey?: string): Promise<void> {
  if (!config.ALERT_WEBHOOK_URL) {
    return;
  }

  if (dedupeKey) {
    const last = lastAlerts.get(dedupeKey) ?? 0;
    if (Date.now() - last < DEDUPE_MS) {
      return;
    }
    lastAlerts.set(dedupeKey, Date.now());
  }

  try {
    const res = await fetch(config.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "someting",
        at: new Date().toISOString(),
        ...payload,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[alert] webhook returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[alert] failed to send:", err instanceof Error ? err.message : err);
  }
}
