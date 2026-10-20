import { BadRequestException, Body, Controller, ForbiddenException, Get, MessageEvent, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, Sse, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import { interval, map, merge, Observable, filter } from 'rxjs';
import { AuditService, clientIp } from '../audit/audit.service';
import { AllowQueryToken, CurrentUser, Public } from '../auth/decorators';
import { config } from '../config';
import { atLeast, AuthUser, DISMISS_REASONS } from '../common/roles';
import { DbService } from '../db/db.service';
import { EventsBus } from './events.bus';
import { EVENT_COLUMNS, EVENT_FROM } from './events.sql';

class ReviewDto {
  @IsIn(['confirmed', 'dismissed']) decision: 'confirmed' | 'dismissed';
  @IsOptional() @IsIn(DISMISS_REASONS) reason?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class MediaTokenDto {
  @IsOptional() @IsBoolean() download?: boolean;
}

@Controller()
export class EventsController {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventsBus,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {}

  @Get('events')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('areaId') areaId?: string,
    @Query('cameraId') cameraId?: string,
    @Query('shadow') shadow = 'false',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('before') before?: string,
    @Query('limit') limit = '50',
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    // Operators only ever see live alerts; shadow-mode records are for supervisors and above.
    if (!atLeast(user.role, 'supervisor') || shadow === 'false') add('e.shadow = ?', false);
    else if (shadow === 'true') add('e.shadow = ?', true);
    if (status) add('e.status = ANY(?)', status.split(','));
    if (type) add('e.type = ANY(?)', type.split(','));
    if (severity) add('e.severity = ANY(?)', severity.split(','));
    if (areaId) add('e.area_id = ?', areaId);
    if (cameraId) add('e.camera_id = ?', cameraId);
    if (from) add('e.started_at >= ?', new Date(from));
    if (to) add('e.started_at < ?', new Date(to));
    if (before) add('e.started_at < ?', new Date(before));
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
    return this.db.query(
      `SELECT ${EVENT_COLUMNS} ${EVENT_FROM}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE WHEN e.status = 'new' THEN 0 ELSE 1 END,
                CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                e.started_at DESC
       LIMIT $${params.length}`,
      params,
    );
  }

  @Get('events/summary')
  async summary(@CurrentUser() user: AuthUser) {
    const shadowClause = atLeast(user.role, 'supervisor') ? '' : 'AND NOT shadow';
    return this.db.one(
      `SELECT count(*) FILTER (WHERE status = 'new' AND NOT shadow)::int AS "openAlerts",
              count(*) FILTER (WHERE status = 'new' AND NOT shadow AND severity = 'critical')::int AS "openCritical",
              count(*) FILTER (WHERE started_at > now() - interval '24 hours' ${shadowClause})::int AS "last24h",
              count(*) FILTER (WHERE status = 'confirmed' AND started_at > now() - interval '24 hours' ${shadowClause})::int AS "confirmed24h"
       FROM events`,
    );
  }

  @Sse('events/stream')
  @AllowQueryToken()
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    const seesShadow = atLeast(user.role, 'supervisor');
    const live = this.bus.stream.pipe(
      filter((m) => m.kind !== 'event.created' || !m.data.shadow || seesShadow),
      map((m) => ({ type: m.kind, data: m.data }) as MessageEvent),
    );
    const ping = interval(25_000).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent));
    return merge(live, ping);
  }

  @Get('events/:id')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const row = await this.db.one(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = $1`, [id]);
    if (!row || (row.shadow && !atLeast(user.role, 'supervisor'))) throw new NotFoundException();
    await this.audit.log(user, { action: 'event.viewed', targetType: 'event', targetId: id }, clientIp(req));
    return row;
  }

  @Post('events/:id/review')
  async review(@Param('id', ParseUUIDPipe) id: string, @Body() b: ReviewDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    if (b.decision === 'dismissed' && !b.reason) throw new BadRequestException('a reason is required to dismiss an alert');
    const current = await this.db.one('SELECT status, shadow FROM events WHERE id = $1', [id]);
    if (!current || (current.shadow && !atLeast(user.role, 'supervisor'))) throw new NotFoundException();
    // Changing a decision already taken needs a supervisor, and is audited as such.
    if (current.status !== 'new' && !atLeast(user.role, 'supervisor')) throw new ForbiddenException('already reviewed');
    await this.db.query(
      `UPDATE events SET status = $2, reviewed_by = $3, reviewed_at = now(), review_reason = $4, review_note = $5 WHERE id = $1`,
      [id, b.decision, user.id, b.decision === 'dismissed' ? b.reason : null, b.note ?? null],
    );
    await this.audit.log(
      user,
      { action: current.status === 'new' ? 'event.reviewed' : 'event.review_changed', targetType: 'event', targetId: id,
        details: { from: current.status, decision: b.decision, reason: b.reason, note: b.note } },
      clientIp(req),
    );
    const row = await this.db.one(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = $1`, [id]);
    this.bus.publish({ kind: 'event.reviewed', data: row! });
    return row;
  }

  /** Short-lived link for the clip and snapshot (a <video> tag cannot send an auth header). */
  @Post('events/:id/media-token')
  async mediaToken(@Param('id', ParseUUIDPipe) id: string, @Body() b: MediaTokenDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const row = await this.db.one('SELECT shadow, clip_path, snapshot_path FROM events WHERE id = $1', [id]);
    if (!row || (row.shadow && !atLeast(user.role, 'supervisor'))) throw new NotFoundException();
    const download = !!b.download;
    if (download && !atLeast(user.role, 'supervisor')) throw new ForbiddenException('exporting clips needs a supervisor');
    const token = await this.jwt.signAsync({ kind: 'media', ev: id, dl: download, sub: user.id }, { secret: config.jwtSecret, expiresIn: '5m' });
    await this.audit.log(user, { action: download ? 'clip.exported' : 'clip.viewed', targetType: 'event', targetId: id }, clientIp(req));
    return {
      clipUrl: row.clip_path ? `/api/media/${token}/clip` : null,
      snapshotUrl: row.snapshot_path ? `/api/media/${token}/snapshot` : null,
      expiresInSeconds: 300,
    };
  }

  @Public()
  @Get('media/:token/:kind')
  async media(@Param('token') token: string, @Param('kind') kind: string, @Res() res: any) {
    let p: { kind: string; ev: string; dl: boolean };
    try {
      p = await this.jwt.verifyAsync(token, { secret: config.jwtSecret });
    } catch {
      throw new UnauthorizedException('link expired');
    }
    if (p.kind !== 'media' || !['clip', 'snapshot'].includes(kind)) throw new UnauthorizedException();
    const row = await this.db.one('SELECT clip_path, snapshot_path FROM events WHERE id = $1', [p.ev]);
    const rel = kind === 'clip' ? row?.clip_path : row?.snapshot_path;
    if (!rel) throw new NotFoundException();
    const root = resolve(config.clipsDir);
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep) || !existsSync(file)) throw new NotFoundException('file not available');
    res.setHeader('Cache-Control', 'private, no-store');
    if (p.dl) res.setHeader('Content-Disposition', `attachment; filename="rased-${p.ev}.${kind === 'clip' ? 'mp4' : 'jpg'}"`);
    res.sendFile(file);
  }
}
