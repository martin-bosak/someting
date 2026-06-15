import { pool } from "./db.js";

// Categories group events on the Logs page. "route" covers Caddy route/path
// applies (the closest thing to local DNS plumbing); "dns" covers external
// registrar A-record automation (Wedos / Active24).
export type ActivityCategory =
  | "dns"
  | "route"
  | "domain"
  | "deploy"
  | "site"
  | "database"
  | "mail"
  | "system";

export type ActivityStatus = "ok" | "error" | "info";

export type ActivityInput = {
  category: ActivityCategory;
  action: string;
  target?: string | null;
  status?: ActivityStatus;
  detail?: string | null;
  durationMs?: number | null;
};

export type ActivityRow = {
  id: string;
  at: Date;
  category: ActivityCategory;
  action: string;
  target: string | null;
  status: ActivityStatus;
  detail: string | null;
  duration_ms: number | null;
};

// Best-effort audit write. Logging must never break the operation it records, so
// every failure is swallowed (and echoed to the container log for debugging).
export async function recordActivity(input: ActivityInput): Promise<void> {
  const status: ActivityStatus = input.status ?? "ok";
  const detail = input.detail ? input.detail.slice(0, 8000) : null;
  try {
    await pool.query(
      `insert into activity_log (category, action, target, status, detail, duration_ms)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.category, input.action, input.target ?? null, status, detail, input.durationMs ?? null],
    );
  } catch (err) {
    console.error("[activity] failed to record:", err instanceof Error ? err.message : err);
  }

  const tag = status === "error" ? "ERR" : status === "info" ? "..." : "OK";
  const line = `[activity:${input.category}] ${tag} ${input.action}${input.target ? ` ${input.target}` : ""}`;
  if (status === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Time a promise and record the outcome (ok / error) automatically.
export async function trackActivity<T>(
  meta: { category: ActivityCategory; action: string; target?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordActivity({ ...meta, status: "ok", durationMs: Date.now() - started });
    return result;
  } catch (err) {
    await recordActivity({
      ...meta,
      status: "error",
      detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

export async function listActivity(options: { limit?: number; category?: ActivityCategory } = {}): Promise<ActivityRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  if (options.category) {
    const result = await pool.query<ActivityRow>(
      `select id, at, category, action, target, status, detail, duration_ms
       from activity_log where category = $1 order by at desc, id desc limit $2`,
      [options.category, limit],
    );
    return result.rows;
  }
  const result = await pool.query<ActivityRow>(
    `select id, at, category, action, target, status, detail, duration_ms
     from activity_log order by at desc, id desc limit $1`,
    [limit],
  );
  return result.rows;
}

// Activity scoped to a single site. Most site-specific events store the slug in
// `target` (create/deploy/route/restart/...). We also match rows whose detail
// mentions the slug so domain/DNS events tied to the site surface here too.
export async function listActivityForSite(slug: string, limit = 40): Promise<ActivityRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const result = await pool.query<ActivityRow>(
    `select id, at, category, action, target, status, detail, duration_ms
     from activity_log
     where target = $1 or detail like $2
     order by at desc, id desc
     limit $3`,
    [slug, `%${slug}%`, capped],
  );
  return result.rows;
}
