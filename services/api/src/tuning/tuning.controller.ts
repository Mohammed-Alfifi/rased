import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

/**
 * Rule tuning from operator decisions, no data scientist needed.
 * If most alerts of one type on one camera were dismissed as false or normal activity,
 * suggest a less sensitive value for the setting that controls that rule.
 */
interface Knob {
  param: string;
  base: number;              // default used by the vision service
  next: (v: number) => number;
  max: number;
  why: string;               // shown to the admin
  mode?: 'rules' | 'classifier';
}

const KNOBS: Record<string, Knob[]> = {
  gathering: [{ param: 'gathering_min', base: 5, next: (v) => v + 2, max: 15, why: 'رفع أقل عدد يُعد تجمّعاً' }],
  running: [{ param: 'running_speed', base: 1.6, next: (v) => +(v + 0.4).toFixed(2), max: 3.2, why: 'رفع السرعة التي تُعد ركضاً' }],
  fight: [
    { param: 'fight_energy', base: 3, next: (v) => v + 1, max: 8, why: 'رفع سرعة حركة الذراعين المطلوبة (وضع القواعد)', mode: 'rules' },
    { param: 'fight_threshold', base: 0.6, next: (v) => +Math.min(0.95, v + 0.1).toFixed(2), max: 0.95, why: 'رفع حد احتمال النموذج', mode: 'classifier' },
  ],
  person_down: [{ param: 'down_s', base: 3, next: (v) => v + 3, max: 15, why: 'إطالة المدة المطلوبة على الأرض' }],
  restricted_zone: [{ param: 'dwell_s', base: 2, next: (v) => v + 3, max: 20, why: 'إطالة مدة البقاء قبل التنبيه' }],
  perimeter_breach: [{ param: 'dwell_s', base: 1, next: (v) => v + 2, max: 10, why: 'إطالة مدة البقاء قرب السور قبل التنبيه' }],
  abandoned_object: [{ param: 'abandon_s', base: 60, next: (v) => Math.min(600, v * 2), max: 600, why: 'إطالة مدة بقاء الغرض بلا صاحب' }],
  prolonged_inactivity: [{ param: 'inactivity_s', base: 900, next: (v) => Math.round(v * 1.5), max: 7200, why: 'إطالة مدة الخمول' }],
  camera_tamper: [{ param: 'tamper_s', base: 5, next: (v) => v + 5, max: 60, why: 'إطالة مدة التغير قبل اعتباره عبثاً' }],
};

class ApplyDto {
  @IsString() cameraId: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsString() @Matches(/^[a-z_]{2,40}$/) param: string;
  @IsNumber() value: number;
  @IsOptional() @IsString() type?: string;
}

@Controller('tuning')
@MinRole('admin')
export class TuningController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get('suggestions')
  async suggestions(@Query('days') daysQ = '14', @Query('minReviews') minQ = '5') {
    const days = Math.min(Math.max(Number(daysQ) || 14, 1), 90);
    const minReviews = Math.max(Number(minQ) || 5, 3);
    const rows = await this.db.query(
      `SELECT e.camera_id, c.name AS camera_name, c.params, s.fight_mode, e.type,
              count(*) FILTER (WHERE e.status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE e.status = 'dismissed')::int AS dismissed,
              count(*) FILTER (WHERE e.review_reason IN ('false_detection', 'normal_activity'))::int AS avoidable,
              mode() WITHIN GROUP (ORDER BY e.review_reason) FILTER (WHERE e.status = 'dismissed') AS top_reason,
              mode() WITHIN GROUP (ORDER BY e.zone_id) FILTER (WHERE e.status = 'dismissed') AS top_zone
       FROM events e JOIN cameras c ON c.id = e.camera_id LEFT JOIN camera_status s ON s.camera_id = c.id
       WHERE e.started_at > now() - make_interval(days => $1) AND e.status IN ('confirmed', 'dismissed')
       GROUP BY e.camera_id, c.name, c.params, s.fight_mode, e.type`,
      [days],
    );
    const out = [];
    for (const r of rows) {
      const reviewed = r.confirmed + r.dismissed;
      if (reviewed < minReviews || r.avoidable / reviewed < 0.6) continue;
      // Falls dismissed mostly in one zone: that zone is probably beds or benches.
      if (r.type === 'person_down' && r.top_zone) {
        const zone = await this.db.one('SELECT id, name, params FROM zones WHERE id = $1', [r.top_zone]);
        if (zone && !zone.params?.allow_lying) {
          out.push({ cameraId: r.camera_id, cameraName: r.camera_name, zoneId: zone.id, zoneName: zone.name, type: r.type,
            confirmed: r.confirmed, dismissed: r.dismissed, falseShare: +(r.avoidable / reviewed).toFixed(2), topReason: r.top_reason,
            param: 'allow_lying', current: false, suggested: true, why: 'السماح بالاستلقاء في هذه المنطقة (أسرّة أو مقاعد)' });
          continue;
        }
      }
      for (const k of KNOBS[r.type] ?? []) {
        if (k.mode && (r.fight_mode ?? 'rules') !== k.mode) continue;
        const current = Number(r.params?.[k.param] ?? k.base);
        const suggested = Math.min(k.max, k.next(current));
        if (suggested <= current) continue;
        out.push({ cameraId: r.camera_id, cameraName: r.camera_name, zoneId: null, zoneName: null, type: r.type,
          confirmed: r.confirmed, dismissed: r.dismissed, falseShare: +(r.avoidable / reviewed).toFixed(2), topReason: r.top_reason,
          param: k.param, current, suggested, why: k.why });
      }
    }
    return out.sort((a, b) => b.dismissed - a.dismissed);
  }

  @Post('apply')
  async apply(@Body() b: ApplyDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const known = new Set(Object.values(KNOBS).flat().map((k) => k.param).concat('allow_lying'));
    if (!known.has(b.param)) throw new BadRequestException('unknown setting');
    const value = b.param === 'allow_lying' ? Boolean(b.value) : b.value;
    let before: unknown;
    if (b.zoneId) {
      const z = await this.db.one('SELECT params FROM zones WHERE id = $1 AND camera_id = $2', [b.zoneId, b.cameraId]);
      if (!z) throw new NotFoundException();
      before = z.params?.[b.param];
      await this.db.query(`UPDATE zones SET params = params || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [b.zoneId, b.param, JSON.stringify(value)]);
    } else {
      const c = await this.db.one('SELECT params FROM cameras WHERE id = $1', [b.cameraId]);
      if (!c) throw new NotFoundException();
      before = c.params?.[b.param];
      await this.db.query(`UPDATE cameras SET params = params || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [b.cameraId, b.param, JSON.stringify(value)]);
    }
    await this.audit.log(me, {
      action: 'tuning.applied', targetType: b.zoneId ? 'zone' : 'camera', targetId: b.zoneId ?? b.cameraId,
      details: { cameraId: b.cameraId, type: b.type, param: b.param, from: before ?? null, to: value },
    }, clientIp(req));
    return { ok: true };
  }
}
