// Test harness: an in-process Postgres (PGlite) prepared like a Supabase project, with our migrations.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
export const DEVICE_KEY = 'test-device-key-0123456789abcdef';

// What a fresh Supabase project already has — including the dangerous defaults (anon gets
// privileges on every new table/function), so the tests catch any missing `revoke`.
const SUPABASE_SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists extensions;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** New database with the Supabase shim; applies migrations up to (and including) `upTo` (default: all). */
export async function freshDb({ upTo, only } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIM);
  for (const f of migrationFiles()) {
    if (only && !only.includes(f)) continue;
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    if (upTo && f.startsWith(upTo)) break;
  }
  return db;
}

export async function applyMigration(db, prefix) {
  const f = migrationFiles().find((x) => x.startsWith(prefix));
  await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

export async function setKey(db, key = DEVICE_KEY) {
  await db.query('select public.ayyam_set_device_key($1)', [key]);
}

/** Run a statement as the browser (anon) role, like PostgREST does. */
export async function asAnon(db, sql, params = []) {
  await db.exec('set role anon');
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}

// RPC wrappers exactly as the app calls them (as anon).
export const rpc = {
  pull: async (db, key = DEVICE_KEY) =>
    (await asAnon(db, 'select public.ayyam_pull($1) as r', [key])).rows[0].r,
  commit: async (db, { key = DEVICE_KEY, expected, data, opId = randomUUID(), reason = 'sync' }) =>
    (await asAnon(db, 'select public.ayyam_commit($1, $2, $3::jsonb, $4::uuid, $5) as r',
      [key, expected, JSON.stringify(data), opId, reason])).rows[0].r,
  listSnapshots: async (db, key = DEVICE_KEY) =>
    (await asAnon(db, 'select public.ayyam_list_snapshots($1) as r', [key])).rows[0].r,
  restore: async (db, { key = DEVICE_KEY, snapshotId, expected, opId = randomUUID() }) =>
    (await asAnon(db, 'select public.ayyam_restore($1, $2, $3, $4::uuid) as r',
      [key, snapshotId, expected, opId])).rows[0].r,
};

export const bundle = (logs = {}, extra = {}) => ({
  template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
  logs,
  prefs: { theme: 'night' },
  tplArchive: { since: '0000-00-00', versions: [] },
  ...extra,
});
export const activeLog = (id = 'a') => ({ done: { [id]: true }, extra: [], hidden: {}, overrides: {} });
