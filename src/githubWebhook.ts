import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import type { SiteRow } from "./platform.js";

export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = config.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return false;
  }
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function normalizeRepoUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  if (normalized.startsWith("git@github.com:")) {
    normalized = `https://github.com/${normalized.slice("git@github.com:".length)}`;
  }
  normalized = normalized.replace(/\.git$/, "").replace(/\/$/, "");
  return normalized;
}

export function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export async function findSitesForGithubPush(repo: { clone_url?: string; ssh_url?: string }, ref: string) {
  const branch = branchFromRef(ref);
  const candidates = new Set<string>();
  if (repo.clone_url) {
    candidates.add(normalizeRepoUrl(repo.clone_url));
  }
  if (repo.ssh_url) {
    candidates.add(normalizeRepoUrl(repo.ssh_url));
  }

  const result = await pool.query<SiteRow>("select * from sites where repo_url not like 'upload://%'");
  return result.rows.filter((site) => {
    if (site.branch !== branch) {
      return false;
    }
    return candidates.has(normalizeRepoUrl(site.repo_url));
  });
}

export type GithubPushEvent = {
  ref: string;
  repository: {
    clone_url?: string;
    ssh_url?: string;
    full_name?: string;
  };
  head_commit?: {
    id?: string;
    message?: string;
  } | null;
};
