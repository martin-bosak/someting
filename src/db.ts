import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
});

export async function migrate() {
  await pool.query(`
    do $$
    begin
      if exists (
        select 1
        from information_schema.table_constraints
        where constraint_name = 'sites_runtime_check'
          and table_name = 'sites'
      ) then
        alter table sites drop constraint sites_runtime_check;
      end if;
    end $$;

    create table if not exists sites (
      id bigserial primary key,
      slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
      name text not null,
      runtime text not null,
      repo_url text not null,
      branch text not null default 'main',
      build_command text,
      start_command text,
      healthcheck_path text default '/',
      status text not null default 'created',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table sites
      add constraint sites_runtime_check
      check (runtime in ('php', 'node', 'python', 'static', 'html'));

    create table if not exists domains (
      id bigserial primary key,
      site_id bigint not null references sites(id) on delete cascade,
      hostname text not null unique,
      is_primary boolean not null default false,
      created_at timestamptz not null default now()
    );

    create table if not exists deployments (
      id bigserial primary key,
      site_id bigint not null references sites(id) on delete cascade,
      status text not null default 'queued',
      commit_sha text,
      output text not null default '',
      started_at timestamptz not null default now(),
      finished_at timestamptz
    );

    create table if not exists mail_notes (
      id bigserial primary key,
      domain text not null,
      mode text not null check (mode in ('external', 'forwarding', 'smtp-relay', 'self-hosted')),
      provider text,
      notes text,
      created_at timestamptz not null default now()
    );

    create table if not exists admin_users (
      id bigserial primary key,
      email text not null unique,
      password_hash text not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}
