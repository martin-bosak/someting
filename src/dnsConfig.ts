import { pool } from "./db.js";

export type DnsProvider = "wedos" | "active24";

export type DnsProviderMeta = {
  id: DnsProvider;
  label: string;
  endpoint: string;
  tone: "mint" | "peach" | "lavender" | "sky" | "rose";
  hint: string;
};

// Providers are code-defined (each needs an API client + credentials); the
// domains assigned to them are data, managed from the Config page.
export const DNS_PROVIDERS: DnsProviderMeta[] = [
  {
    id: "wedos",
    label: "WEDOS (WAPI)",
    endpoint: "/admin/dns/wedos/a-record",
    tone: "mint",
    hint: "Adds a 3rd-level <code>A</code> record via WEDOS WAPI, then commits the zone.",
  },
  {
    id: "active24",
    label: "Active24",
    endpoint: "/admin/dns/active24/a-record",
    tone: "peach",
    hint: "Adds a 3rd-level <code>A</code> record via the Active24 REST API.",
  },
];

export function isDnsProvider(value: unknown): value is DnsProvider {
  return value === "wedos" || value === "active24";
}

export function providerMeta(provider: DnsProvider): DnsProviderMeta {
  const meta = DNS_PROVIDERS.find((p) => p.id === provider);
  if (!meta) {
    throw new Error(`Unknown DNS provider: ${provider}`);
  }
  return meta;
}

export type DnsDomainRow = {
  id: string;
  domain: string;
  provider: DnsProvider;
  created_at: Date;
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export async function listDnsDomains(): Promise<DnsDomainRow[]> {
  const result = await pool.query<DnsDomainRow>(
    "select id, domain, provider, created_at from dns_domains order by provider, domain",
  );
  return result.rows;
}

export async function listDomainsForProvider(provider: DnsProvider): Promise<string[]> {
  const result = await pool.query<{ domain: string }>(
    "select domain from dns_domains where provider = $1 order by domain",
    [provider],
  );
  return result.rows.map((row) => row.domain);
}

export async function getProviderForDomain(domain: string): Promise<DnsProvider | null> {
  const result = await pool.query<{ provider: DnsProvider }>(
    "select provider from dns_domains where domain = $1",
    [domain.toLowerCase()],
  );
  return result.rowCount === 1 ? result.rows[0].provider : null;
}

// Throws unless `domain` is configured AND assigned to `provider`. Used by the
// per-provider record-create endpoints so a domain can only be driven through
// the registrar it actually lives on.
export async function assertDomainAssignedTo(domain: string, provider: DnsProvider): Promise<void> {
  const assigned = await getProviderForDomain(domain);
  if (assigned === null) {
    throw new Error(`Domain ${domain} is not configured. Add it on the Config page first.`);
  }
  if (assigned !== provider) {
    throw new Error(`Domain ${domain} is assigned to ${assigned}, not ${provider}.`);
  }
}

export async function addDnsDomain(domainRaw: string, provider: string): Promise<DnsDomainRow> {
  const domain = String(domainRaw || "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain) || domain.length > 253) {
    throw new Error("Enter a valid domain like example.com.");
  }
  if (!isDnsProvider(provider)) {
    throw new Error(`Unknown DNS provider: ${provider}`);
  }

  const result = await pool.query<DnsDomainRow>(
    `insert into dns_domains (domain, provider)
     values ($1, $2)
     on conflict (domain) do update set provider = excluded.provider
     returning id, domain, provider, created_at`,
    [domain, provider],
  );
  return result.rows[0];
}

export async function removeDnsDomain(id: number): Promise<void> {
  await pool.query("delete from dns_domains where id = $1", [id]);
}
