import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  UnauthorizedException, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, extname, join, resolve, sep } from 'path';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole, Public } from '../auth/decorators';
import { config } from '../config';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

/** Smallest data set the studio will train on. Real quality needs far more (see docs/training-studio.md). */
export const MINIMUMS = { train: 10, val: 3, test: 3 };
/** Quality gate for switching a new model on without an explicit override. */
export const GATE = { minRecall: 0.85, maxF1Drop: 0.01 };

class FromReviewsDto {
  @IsOptional() @IsBoolean() includeNormalActivity?: boolean; // dismissed "normal activity" clips of any type as negatives
}

class UploadDto {
  @IsIn(['positive', 'negative']) label: 'positive' | 'negative';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class ItemPatchDto {
  @IsOptional() @IsIn(['positive', 'negative']) label?: 'positive' | 'negative';
  @IsOptional() @IsBoolean() excluded?: boolean;
  @IsOptional() @IsIn(['train', 'val', 'test', null]) split?: 'train' | 'val' | 'test' | null;
}

class SplitDto {
  @IsInt() @Min(40) @Max(90) train: number;
  @IsInt() @Min(5) @Max(30) val: number;
  @IsInt() @Min(5) @Max(30) test: number;
  @IsOptional() @IsIn(['random', 'by_camera']) mode?: 'random' | 'by_camera';
  /** Keep items already in the test set where they are, so every version is judged on the same exam. */
  @IsOptional() @IsBoolean() keepTest?: boolean;
  @IsOptional() @IsInt() seed?: number;
}

class JobDto {
  @IsOptional() @IsInt() @Min(5) @Max(200) epochs?: number;
}

class ActivateDto {
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Deterministic shuffle (mulberry32) so a split can be reproduced from its seed. */
function shuffle<T>(arr: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function inside(root: string, rel: string): string {
  const r = resolve(root);
  const f = resolve(r, rel);
  if (!f.startsWith(r + sep)) throw new BadRequestException('bad path');
  return f;
}

@Controller('training')
@MinRole('admin')
export class TrainingController {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly jwt: JwtService) {}

  // ---------------------------------------------------------------- overview

  @Get('summary')
  async summary() {
    const counts = await this.db.query<{ split: string | null; label: string; n: number }>(
      `SELECT split, label, count(*)::int AS n FROM dataset_items WHERE task = 'fight' AND NOT excluded GROUP BY 1, 2`,
    );
    const table: Record<string, Record<string, number>> = {};
    for (const s of ['train', 'val', 'test', 'unassigned']) table[s] = { positive: 0, negative: 0 };
    for (const c of counts) table[c.split ?? 'unassigned'][c.label] = c.n;
    const missing: string[] = [];
    for (const [split, min] of Object.entries(MINIMUMS)) {
      for (const label of ['positive', 'negative']) {
        if (table[split][label] < min) missing.push(`${split}.${label}`);
      }
    }
    const available = await this.db.one(
      `SELECT count(*) FILTER (WHERE e.type = 'fight' AND e.status IN ('confirmed', 'dismissed'))::int AS fight,
              count(*) FILTER (WHERE e.type <> 'fight' AND e.status = 'dismissed' AND e.review_reason = 'normal_activity')::int AS normal
       FROM events e LEFT JOIN dataset_items d ON d.event_id = e.id
       WHERE d.id IS NULL AND e.clip_path IS NOT NULL`,
    );
    const active = await this.db.one(
      `SELECT id, version, threshold, metrics, activated_at AS "activatedAt" FROM model_versions WHERE task = 'fight' AND status = 'active'`,
    );
    const runningJob = await this.db.one(`SELECT id, status, progress, stage FROM training_jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1`);
    return { counts: table, minimums: MINIMUMS, missing, canTrain: missing.length === 0 && !runningJob, availableFromReviews: available, active: active ?? null, runningJob: runningJob ?? null, gate: GATE };
  }

  // ---------------------------------------------------------------- data

  @Get('items')
  items(@Query('split') split?: string, @Query('label') label?: string, @Query('limit') limit = '200') {
    const where = [`d.task = 'fight'`];
    const params: unknown[] = [];
    if (split === 'unassigned') where.push('d.split IS NULL');
    else if (split) { params.push(split); where.push(`d.split = $${params.length}`); }
    if (label) { params.push(label); where.push(`d.label = $${params.length}`); }
    params.push(Math.min(Number(limit) || 200, 1000));
    return this.db.query(
      `SELECT d.id, d.label, d.source, d.split, d.excluded, d.note, d.camera_id AS "cameraId", c.name AS "cameraName",
              d.event_id AS "eventId", e.type AS "eventType", d.windows, d.created_at AS "createdAt", u.full_name AS "addedBy"
       FROM dataset_items d LEFT JOIN cameras c ON c.id = d.camera_id LEFT JOIN events e ON e.id = d.event_id
       LEFT JOIN users u ON u.id = d.added_by
       WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT $${params.length}`,
      params,
    );
  }

  /**
   * Turns operator decisions into labelled data: confirmed fights are positives, dismissed
   * fight alerts are negatives, and (optionally) any clip dismissed as "normal activity".
   */
  @Post('items/from-reviews')
  async fromReviews(@Body() b: FromReviewsDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const rows = await this.db.query<{ id: string; type: string; status: string; review_reason: string | null; clip_path: string; camera_id: string }>(
      `SELECT e.id, e.type, e.status, e.review_reason, e.clip_path, e.camera_id
       FROM events e LEFT JOIN dataset_items d ON d.event_id = e.id
       WHERE d.id IS NULL AND e.clip_path IS NOT NULL
         AND ((e.type = 'fight' AND e.status IN ('confirmed', 'dismissed'))
              OR ($1 AND e.status = 'dismissed' AND e.review_reason = 'normal_activity'))`,
      [!!b.includeNormalActivity],
    );
    let added = 0;
    let missingFiles = 0;
    for (const r of rows) {
      const src = inside(config.clipsDir, r.clip_path);
      if (!existsSync(src)) { missingFiles++; continue; }
      const rel = join('items', `${randomUUID()}${extname(src) || '.mp4'}`);
      const dest = inside(config.trainingDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      const label = r.type === 'fight' && r.status === 'confirmed' ? 'positive' : 'negative';
      await this.db.query(
        `INSERT INTO dataset_items (label, source, event_id, media_path, camera_id, added_by)
         VALUES ($1, 'review', $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING`,
        [label, r.id, rel, r.camera_id, me.id],
      );
      added++;
    }
    await this.audit.log(me, { action: 'training.items_from_reviews', details: { added, missingFiles } }, clientIp(req));
    return { added, missingFiles };
  }

  @Post('items/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 300 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: any, @Body() b: UploadDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    if (!file) throw new BadRequestException('attach a video file');
    const ext = extname(file.originalname || '').toLowerCase();
    if (!['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) throw new BadRequestException('unsupported video type');
    const rel = join('items', `${randomUUID()}${ext}`);
    const dest = inside(config.trainingDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.buffer);
    const row = await this.db.one(
      `INSERT INTO dataset_items (label, source, media_path, note, added_by) VALUES ($1, 'upload', $2, $3, $4) RETURNING id`,
      [b.label, rel, b.note ?? null, me.id],
    );
    await this.audit.log(me, { action: 'training.item_uploaded', targetType: 'dataset_item', targetId: row!.id, details: { label: b.label, name: file.originalname, bytes: file.size } }, clientIp(req));
    return row;
  }

  @Patch('items/:id')
  async patchItem(@Param('id', ParseUUIDPipe) id: string, @Body() b: ItemPatchDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to change');
    // a relabelled clip needs its features re-extracted only if the label changed: features do not depend on label
    const row = await this.db.one(`UPDATE dataset_items SET ${sets.join(', ')} WHERE id = $1 RETURNING id, label, split, excluded`, params);
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'training.item_updated', targetType: 'dataset_item', targetId: id, details: b as any }, clientIp(req));
    return row;
  }

  /** Short-lived link to preview a training clip in the browser. */
  @Post('items/:id/media-token')
  async itemToken(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    const row = await this.db.one('SELECT id FROM dataset_items WHERE id = $1', [id]);
    if (!row) throw new NotFoundException();
    const token = await this.jwt.signAsync({ kind: 'training-media', item: id, sub: me.id }, { secret: config.jwtSecret, expiresIn: '5m' });
    return { url: `/api/training/media/${token}` };
  }

  @Public()
  @Get('media/:token')
  async media(@Param('token') token: string, @Res() res: any) {
    let p: { kind: string; item: string };
    try { p = await this.jwt.verifyAsync(token, { secret: config.jwtSecret }); } catch { throw new UnauthorizedException('link expired'); }
    if (p.kind !== 'training-media') throw new UnauthorizedException();
    const row = await this.db.one('SELECT media_path FROM dataset_items WHERE id = $1', [p.item]);
    if (!row) throw new NotFoundException();
    const file = inside(config.trainingDir, row.media_path);
    if (!existsSync(file)) throw new NotFoundException('file not available');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(file);
  }

  /**
   * Splits labelled clips into train / validation / test, stratified by label.
   * `by_camera` keeps all clips of a camera in one split, so the test measures how the
   * model does on a camera it has never seen. `keepTest` leaves the existing test set alone.
   */
  @Post('split')
  async split(@Body() b: SplitDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    if (b.train + b.val + b.test !== 100) throw new BadRequestException('percentages must add up to 100');
    const keepTest = b.keepTest ?? true;
    const seed = b.seed ?? Math.floor(Math.random() * 1e9);
    const items = await this.db.query<{ id: string; label: string; split: string | null; camera_id: string | null }>(
      `SELECT id, label, split, camera_id FROM dataset_items WHERE task = 'fight' AND NOT excluded`,
    );
    const movable = items.filter((i) => !(keepTest && i.split === 'test'));
    const assign = new Map<string, string>();
    const fractions = { train: b.train / 100, val: b.val / 100, test: b.test / 100 };
    const testShare = keepTest && items.some((i) => i.split === 'test') ? 0 : fractions.test;
    const norm = fractions.train + fractions.val + testShare;

    const place = <T>(group: T[], key: (x: T) => string[]) => {
      const n = group.length;
      // round up so small data sets still get a usable validation and test set
      const nTest = Math.ceil((n * testShare) / norm);
      const nVal = Math.ceil((n * fractions.val) / norm);
      shuffle(group, seed).forEach((g, i) => {
        const s = i < nTest ? 'test' : i < nTest + nVal ? 'val' : 'train';
        for (const id of key(g)) assign.set(id, s);
      });
    };

    if ((b.mode ?? 'random') === 'by_camera') {
      const cams = new Map<string, typeof movable>();
      for (const it of movable) {
        const k = it.camera_id ?? `upload-${it.id}`;
        cams.set(k, [...(cams.get(k) ?? []), it]);
      }
      place([...cams.values()], (g) => g.map((x) => x.id));
    } else {
      for (const label of ['positive', 'negative']) place(movable.filter((i) => i.label === label), (x) => [x.id]);
    }
    for (const [id, s] of assign) await this.db.query('UPDATE dataset_items SET split = $2 WHERE id = $1', [id, s]);
    await this.audit.log(me, { action: 'training.split', details: { ...b, seed, keepTest, moved: assign.size } }, clientIp(req));
    return { moved: assign.size, seed, summary: (await this.summary()).counts };
  }

  // ---------------------------------------------------------------- jobs

  @Get('jobs')
  jobs() {
    return this.db.query(
      `SELECT j.id, j.status, j.progress, j.stage, j.params, j.result, j.created_at AS "createdAt",
              j.started_at AS "startedAt", j.finished_at AS "finishedAt", u.full_name AS "by",
              m.version AS "modelVersion"
       FROM training_jobs j LEFT JOIN users u ON u.id = j.created_by LEFT JOIN model_versions m ON m.id = j.model_version_id
       ORDER BY j.created_at DESC LIMIT 50`,
    );
  }

  @Get('jobs/:id')
  async job(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.one(
      `SELECT id, status, progress, stage, params, result, log, created_at AS "createdAt", started_at AS "startedAt",
              finished_at AS "finishedAt", heartbeat_at AS "heartbeatAt" FROM training_jobs WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post('jobs')
  async startJob(@Body() b: JobDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const s = await this.summary();
    if (s.runningJob) throw new BadRequestException('a training job is already running');
    if (s.missing.length) throw new BadRequestException(`not enough labelled clips: ${s.missing.join(', ')}`);
    const row = await this.db.one(
      `INSERT INTO training_jobs (task, params, created_by) VALUES ('fight', $1, $2) RETURNING id`,
      [JSON.stringify({ epochs: b.epochs ?? 30, counts: s.counts }), me.id],
    );
    await this.audit.log(me, { action: 'training.job_started', targetType: 'training_job', targetId: row!.id, details: { epochs: b.epochs ?? 30 } }, clientIp(req));
    return row;
  }

  @Post('jobs/:id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one(
      `UPDATE training_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
      [id],
    );
    if (!row) throw new BadRequestException('job is not running');
    await this.audit.log(me, { action: 'training.job_cancelled', targetType: 'training_job', targetId: id }, clientIp(req));
    return row;
  }

  // ---------------------------------------------------------------- models

  @Get('models')
  models() {
    return this.db.query(
      `SELECT m.id, m.version, m.threshold, m.metrics, m.data, m.status, m.created_at AS "createdAt",
              m.activated_at AS "activatedAt", u.full_name AS "activatedBy", m.notes
       FROM model_versions m LEFT JOIN users u ON u.id = m.activated_by
       WHERE m.task = 'fight' ORDER BY m.version DESC`,
    );
  }

  /**
   * Switch a model on. The gate: recall on the test set at least 85%, and F1 no worse than the
   * active model on the same test set. Overriding the gate needs a written reason (audited).
   */
  @Post('models/:id/activate')
  async activate(@Param('id', ParseUUIDPipe) id: string, @Body() b: ActivateDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const m = await this.db.one('SELECT id, version, path, threshold, metrics, status FROM model_versions WHERE id = $1', [id]);
    if (!m) throw new NotFoundException();
    if (m.status === 'active') throw new BadRequestException('already active');
    const test = m.metrics?.test?.video ?? {};
    const baseline = m.metrics?.baseline?.video;
    const problems: string[] = [];
    if (!(test.recall >= GATE.minRecall)) problems.push(`recall ${test.recall ?? '?'} is below ${GATE.minRecall}`);
    if (baseline && test.f1 < baseline.f1 - GATE.maxF1Drop) problems.push(`F1 ${test.f1} is below the active model's ${baseline.f1}`);
    if (problems.length && !b.force) {
      throw new BadRequestException({ message: 'quality gate not met', problems });
    }
    if (problems.length && (!b.reason || b.reason.trim().length < 10)) {
      throw new BadRequestException('overriding the quality gate needs a written reason');
    }
    await this.db.tx(async (c) => {
      await c.query(`UPDATE model_versions SET status = 'archived' WHERE task = 'fight' AND status = 'active'`);
      await c.query(`UPDATE model_versions SET status = 'active', activated_at = now(), activated_by = $2 WHERE id = $1`, [id, me.id]);
      await c.query(`UPDATE settings SET value = $1 WHERE key = 'fight_model'`, [JSON.stringify(m.path)]);
      await c.query(`UPDATE settings SET value = $1 WHERE key = 'fight_threshold'`, [JSON.stringify(m.threshold)]);
    });
    await this.audit.log(me, {
      action: problems.length ? 'model.activated_override' : 'model.activated', targetType: 'model_version', targetId: id,
      details: { version: m.version, threshold: m.threshold, problems, reason: b.reason },
    }, clientIp(req));
    return { ok: true, version: m.version, overridden: problems.length > 0 };
  }

  /** Back to rule-based fight detection (no model). */
  @Post('models/deactivate')
  async deactivate(@CurrentUser() me: AuthUser, @Req() req: any) {
    await this.db.tx(async (c) => {
      await c.query(`UPDATE model_versions SET status = 'archived' WHERE task = 'fight' AND status = 'active'`);
      await c.query(`UPDATE settings SET value = 'null' WHERE key = 'fight_model'`);
    });
    await this.audit.log(me, { action: 'model.deactivated' }, clientIp(req));
    return { ok: true };
  }

  @Post('models/:id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one(`UPDATE model_versions SET status = 'rejected' WHERE id = $1 AND status = 'candidate' RETURNING version`, [id]);
    if (!row) throw new BadRequestException('only a candidate can be rejected');
    await this.audit.log(me, { action: 'model.rejected', targetType: 'model_version', targetId: id, details: { version: row.version } }, clientIp(req));
    return { ok: true };
  }
}
