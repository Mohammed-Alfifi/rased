import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { readdirSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { DbService } from '../db/db.service';

/**
 * Deletes data older than the retention period chosen by the facility.
 * Runs hourly. The audit log itself is never deleted.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.run().catch((e) => this.log.error(e)), config.retentionEveryMs);
    setTimeout(() => this.run().catch((e) => this.log.error(e)), 30_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<Record<string, number>> {
    const days = Number(await this.db.setting('retention_days', 30));
    const clipDays = Number(await this.db.setting('clip_retention_days', days));
    const out: Record<string, number> = {};

    // Clips first: clear the paths on events past the clip period, then delete the files.
    const expired = await this.db.query<{ clip_path: string | null; snapshot_path: string | null }>(
      `WITH old AS (
         SELECT id, clip_path, snapshot_path FROM events
         WHERE started_at < now() - make_interval(days => $1) AND (clip_path IS NOT NULL OR snapshot_path IS NOT NULL)
         FOR UPDATE)
       UPDATE events e SET clip_path = NULL, snapshot_path = NULL FROM old WHERE e.id = old.id
       RETURNING old.clip_path, old.snapshot_path`,
      [clipDays],
    );
    const root = resolve(config.clipsDir);
    let removed = 0;
    for (const r of expired) {
      for (const rel of [r.clip_path, r.snapshot_path]) {
        if (!rel) continue;
        const file = resolve(root, rel);
        if (!file.startsWith(root)) continue;
        try {
          rmSync(file);
          removed++;
        } catch {
          /* already gone */
        }
      }
    }
    out.clipsExpired = expired.length;
    out.filesDeleted = removed + this.sweepFiles(clipDays);

    const del = async (sql: string, d: number) => (await this.db.pool.query(sql, [d])).rowCount ?? 0;
    out.events = await del('DELETE FROM events WHERE started_at < now() - make_interval(days => $1)', days);
    out.metrics = await del('DELETE FROM zone_metrics WHERE period_start < now() - make_interval(days => $1)', Math.max(days, 42));
    out.heartbeats = await del('DELETE FROM camera_heartbeats WHERE at < now() - make_interval(days => $1)', Math.max(days, 30));
    out.scores = await del('DELETE FROM area_scores WHERE bucket < now() - make_interval(days => $1)', Math.max(days, 60));

    if (Object.values(out).some((n) => n > 0)) {
      await this.audit.log(null, { action: 'retention.purged', details: { retentionDays: days, clipRetentionDays: clipDays, ...out } });
      this.log.log(`purged ${JSON.stringify(out)}`);
    }
    return out;
  }

  /** Delete clip and snapshot files older than `days` (also catches files of deleted events). */
  private sweepFiles(days: number): number {
    const root = resolve(config.clipsDir);
    const cutoff = Date.now() - days * 86_400_000;
    let n = 0;
    let cams: string[] = [];
    try {
      cams = readdirSync(root);
    } catch {
      return 0;
    }
    for (const cam of cams) {
      const dir = join(root, cam);
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) {
            rmSync(p);
            n++;
          }
        } catch {
          /* already gone */
        }
      }
    }
    return n;
  }
}
