import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { ServiceOnly } from '../auth/decorators';
import { EVENT_TYPES, SEVERITIES } from '../common/roles';
import { DbService } from '../db/db.service';
import { EventsBus } from '../events/events.bus';
import { EVENT_COLUMNS, EVENT_FROM } from '../events/events.sql';

class EventIn {
  @IsString() cameraId: string;
  @IsOptional() @IsString() zoneId?: string | null;
  @IsIn(EVENT_TYPES) type: string;
  @IsIn(SEVERITIES) severity: string;
  @IsNumber() @Min(0) @Max(1) confidence: number;
  @IsNumber() startedAt: number; // unix seconds
  @IsNumber() detectedAt: number;
  @IsOptional() @IsArray() @IsInt({ each: true }) trackIds?: number[];
  @IsOptional() @IsArray() bbox?: number[] | null;
  @IsOptional() @IsObject() details?: Record<string, unknown>;
  @IsOptional() @IsString() clipPath?: string | null;
  @IsOptional() @IsString() snapshotPath?: string | null;
}

class MetricRow {
  @IsString() cameraId: string;
  @IsOptional() @IsString() zoneId?: string | null;
  @IsNumber() periodStart: number;
  @IsNumber() periodEnd: number;
  @IsInt() samples: number;
  @IsNumber() occupancyAvg: number;
  @IsInt() occupancyMax: number;
  @IsNumber() motionAvg: number;
  @IsInt() clusterMax: number;
  @IsInt() runnersMax: number;
  @IsOptional() @IsInt() events?: number;
}

class MetricsIn {
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => MetricRow) rows: MetricRow[];
}

class HeartbeatIn {
  @IsString() cameraId: string;
  @IsIn(['online', 'offline', 'starting']) status: string;
  @IsOptional() @IsNumber() fps?: number;
  @IsOptional() @IsNumber() latencyMs?: number;
  @IsOptional() @IsInt() tracks?: number;
  @IsOptional() @IsString() fightMode?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

/** Endpoints for the vision service, authenticated with the shared service key. */
@Controller('ingest')
@ServiceOnly()
export class IngestController {
  constructor(private readonly db: DbService, private readonly bus: EventsBus) {}

  @Get('config')
  async config() {
    const cameras = await this.db.query(`SELECT id, name, url, enabled, params FROM cameras ORDER BY id`);
    const zones = await this.db.query(
      `SELECT id, camera_id, name, kind, polygon, params, restricted_hours AS "restrictedHours" FROM zones`,
    );
    const fightModel = await this.db.setting<string | null>('fight_model', null);
    const fightThreshold = await this.db.setting<number>('fight_threshold', 0.6);
    return {
      fightModel,
      fightThreshold,
      cameras: cameras.map((c) => ({ ...c, zones: zones.filter((z) => z.camera_id === c.id) })),
    };
  }

  @Post('events')
  @HttpCode(201)
  async event(@Body() e: EventIn) {
    for (const p of [e.clipPath, e.snapshotPath]) {
      if (p && (!SAFE_PATH.test(p) || p.includes('..'))) throw new BadRequestException('bad media path');
    }
    const cam = await this.db.one<{ area_id: string | null }>('SELECT area_id FROM cameras WHERE id = $1', [e.cameraId]);
    if (!cam) throw new BadRequestException('unknown camera');
    const zoneId = e.zoneId && UUID.test(e.zoneId) ? e.zoneId : null;
    const shadow = await this.db.setting<boolean>('shadow_mode', true);
    const row = await this.db.one(
      `INSERT INTO events (camera_id, zone_id, area_id, type, severity, confidence, shadow, started_at, detected_at,
                           track_ids, bbox, details, clip_path, snapshot_path)
       VALUES ($1, (SELECT id FROM zones WHERE id = $2::uuid), $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9),
               $10, $11, $12, $13, $14)
       RETURNING id`,
      [e.cameraId, zoneId, cam.area_id, e.type, e.severity, e.confidence, shadow, e.startedAt, e.detectedAt,
       e.trackIds ?? [], e.bbox ? JSON.stringify(e.bbox) : null, JSON.stringify(e.details ?? {}), e.clipPath ?? null, e.snapshotPath ?? null],
    );
    const full = await this.db.one(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = $1`, [row!.id]);
    this.bus.publish({ kind: 'event.created', data: full! });
    return { id: row!.id, shadow };
  }

  @Post('metrics')
  @HttpCode(202)
  async metrics(@Body() body: MetricsIn) {
    if (!body.rows.length) return { inserted: 0 };
    const areas = new Map((await this.db.query('SELECT id, area_id FROM cameras')).map((c) => [c.id, c.area_id]));
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const r of body.rows) {
      if (!areas.has(r.cameraId)) continue;
      const zoneId = r.zoneId && UUID.test(r.zoneId) ? r.zoneId : null;
      const base = values.length;
      values.push(r.cameraId, zoneId, areas.get(r.cameraId), r.periodStart, r.periodEnd, r.samples, r.occupancyAvg,
        r.occupancyMax, r.motionAvg, r.clusterMax, r.runnersMax, r.events ?? 0);
      tuples.push(`($${base + 1}, (SELECT id FROM zones WHERE id = $${base + 2}::uuid), $${base + 3}, to_timestamp($${base + 4}),
        to_timestamp($${base + 5}), $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`);
    }
    if (tuples.length) {
      await this.db.query(
        `INSERT INTO zone_metrics (camera_id, zone_id, area_id, period_start, period_end, samples, occupancy_avg,
           occupancy_max, motion_avg, cluster_max, runners_max, events) VALUES ${tuples.join(',')}`,
        values,
      );
    }
    return { inserted: tuples.length };
  }

  @Post('heartbeat')
  @HttpCode(204)
  async heartbeat(@Body() h: HeartbeatIn) {
    const exists = await this.db.one('SELECT 1 FROM cameras WHERE id = $1', [h.cameraId]);
    if (!exists) throw new BadRequestException('unknown camera');
    await this.db.query(
      `INSERT INTO camera_status (camera_id, status, fps, latency_ms, tracks, fight_mode, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (camera_id) DO UPDATE SET status = EXCLUDED.status, fps = EXCLUDED.fps, latency_ms = EXCLUDED.latency_ms,
         tracks = EXCLUDED.tracks, fight_mode = EXCLUDED.fight_mode, last_seen_at = now()`,
      [h.cameraId, h.status, h.fps ?? null, h.latencyMs != null ? Math.round(h.latencyMs) : null, h.tracks ?? null, h.fightMode ?? null],
    );
    await this.db.query(
      'INSERT INTO camera_heartbeats (camera_id, status, fps, latency_ms) VALUES ($1, $2, $3, $4)',
      [h.cameraId, h.status, h.fps ?? null, h.latencyMs != null ? Math.round(h.latencyMs) : null],
    );
    this.bus.publish({ kind: 'camera.status', data: { ...h } });
  }
}
