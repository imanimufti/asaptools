// Applies supabase/migrations/*.sql in order to DATABASE_URL, once each.
// Works against local Postgres or a Supabase project's connection string.
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set (see .env.example)'); process.exit(1); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
await client.query('create table if not exists _asap_migrations (name text primary key, applied_at timestamptz not null default now())');
const done = new Set((await client.query('select name from _asap_migrations')).rows.map((r) => r.name));
const dir = new URL('../supabase/migrations/', import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  if (done.has(f)) continue;
  const sql = await readFile(new URL(f, dir), 'utf8');
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into _asap_migrations (name) values ($1)', [f]);
    await client.query('commit');
    console.log(`applied ${f}`);
  } catch (e) {
    await client.query('rollback');
    console.error(`failed ${f}: ${e.message}`);
    process.exit(1);
  }
}
await client.query('alter table _asap_migrations enable row level security');
console.log('database is up to date');
await client.end();
