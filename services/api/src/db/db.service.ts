import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

  async query<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params as any[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async setting<T = unknown>(key: string, fallback: T): Promise<T> {
    const row = await this.one<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
    return row ? row.value : fallback;
  }

  async onModuleDestroy() {
    await this.pool.end();
    this.log.log('pool closed');
  }
}
