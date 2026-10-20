import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

/** Applies db/migrations/*.sql in name order, each once, inside a transaction. */
export async function migrate(pool: Pool, dir = join(__dirname, '..', '..', 'db', 'migrations')): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // serialize concurrent starts (several API replicas)
    await client.query('SELECT pg_advisory_lock(727372)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727372)').catch(() => undefined);
    client.release();
  }
  return applied;
}
