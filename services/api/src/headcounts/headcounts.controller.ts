import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';
import { EventsBus } from '../events/events.bus';
import { EVENT_COLUMNS, EVENT_FROM } from '../events/events.sql';

class HeadcountDto {
  @IsUUID() areaId: string;
  @IsOptional() @IsInt() @Min(0) expected?: number;
  @IsOptional() @IsInt() @Min(0) manual?: number; // the officers' own count, to measure accuracy
}

/**
 * Automatic count at an official count time: sums the people seen in the area's
 * "count" zones (or, if it has none, its cameras) over the last 3 minutes and
 * compares with the expected number.
 */
@Controller('headcounts')
export class HeadcountsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly bus: EventsBus) {}

  @Get()
  list(@Query('areaId') areaId?: string) {
    return this.db.query(
      `SELECT h.id, h.area_id AS "areaId", a.name AS "areaName", h.expected, h.counted, h.manual, h.matched, h.at,
              u.full_name AS "by", h.event_id AS "eventId"
       FROM headcounts h JOIN areas a ON a.id = h.area_id LEFT JOIN users u ON u.id = h.user_id
       ${areaId ? 'WHERE h.area_id = $1' : ''} ORDER BY h.at DESC LIMIT 100`,
      areaId ? [areaId] : [],
    );
  }

  @Post()
  async run(@Body() b: HeadcountDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const area = await this.db.one('SELECT id, name, expected_count FROM areas WHERE id = $1', [b.areaId]);
    if (!area) throw new BadRequestException('unknown area');
    const expected = b.expected ?? area.expected_count;
    if (expected == null) throw new BadRequestException('expected count is not set for this area');

    // Latest row per zone (or per camera) within 3 minutes; the max over the period
    // is used because people briefly hidden behind others lower the average.
    const zoneCount = await this.db.one<{ n: number | null; zones: number }>(
      `SELECT sum(occupancy_max)::int AS n, count(*)::int AS zones FROM (
         SELECT DISTINCT ON (m.zone_id) m.occupancy_max
         FROM zone_metrics m JOIN zones z ON z.id = m.zone_id JOIN cameras c ON c.id = z.camera_id
         WHERE c.area_id = $1 AND z.kind = 'count' AND m.period_end > now() - interval '3 minutes'
         ORDER BY m.zone_id, m.period_end DESC) t`,
      [b.areaId],
    );
    let counted = zoneCount?.n;
    if (!zoneCount?.zones) {
      const camCount = await this.db.one<{ n: number | null }>(
        `SELECT sum(occupancy_max)::int AS n FROM (
           SELECT DISTINCT ON (m.camera_id) m.occupancy_max FROM zone_metrics m
           WHERE m.area_id = $1 AND m.zone_id IS NULL AND m.period_end > now() - interval '3 minutes'
           ORDER BY m.camera_id, m.period_end DESC) t`,
        [b.areaId],
      );
      counted = camCount?.n;
    }
    if (counted == null) throw new BadRequestException('no recent data from this area: are its cameras online?');
    const matched = counted === expected;

    let eventId: string | null = null;
    if (!matched) {
      const cam = await this.db.one('SELECT id FROM cameras WHERE area_id = $1 ORDER BY id LIMIT 1', [b.areaId]);
      const shadow = await this.db.setting<boolean>('shadow_mode', true);
      const ev = await this.db.one(
        `INSERT INTO events (camera_id, area_id, type, severity, confidence, shadow, started_at, detected_at, details)
         VALUES ($1, $2, 'count_mismatch', 'medium', 1, $3, now(), now(), $4) RETURNING id`,
        [cam!.id, b.areaId, shadow, JSON.stringify({ expected, counted, by: user.username })],
      );
      eventId = ev!.id;
      const full = await this.db.one(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = $1`, [eventId]);
      this.bus.publish({ kind: 'event.created', data: full! });
    }
    const row = await this.db.one(
      `INSERT INTO headcounts (area_id, expected, counted, manual, matched, user_id, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, expected, counted, manual, matched, at, event_id AS "eventId"`,
      [b.areaId, expected, counted, b.manual ?? null, matched, user.id, eventId],
    );
    await this.audit.log(user, { action: 'headcount.run', targetType: 'area', targetId: b.areaId, details: { expected, counted, manual: b.manual, matched } }, clientIp(req));
    return { ...row, areaName: area.name };
  }
}
