import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { IsBoolean, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { atLeast, AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

class CameraDto {
  @IsString() @Matches(/^[a-z0-9-]{2,40}$/) id: string;
  @IsString() @MinLength(2) name: string;
  @IsString() @Matches(/^(rtsp|rtsps|http|https|file):\/\/.+|^\/.+/) url: string;
  @IsOptional() @IsUUID() areaId?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(0) @Max(1) mapX?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1) mapY?: number | null;
}

class UpdateCameraDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() @Matches(/^(rtsp|rtsps|http|https|file):\/\/.+|^\/.+/) url?: string;
  @IsOptional() @IsUUID() areaId?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(0) @Max(1) mapX?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1) mapY?: number | null;
}

/** RTSP URLs often carry passwords: shown to admins only, otherwise masked. */
function maskUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, '//***@');
}

@Controller('cameras')
export class CamerasController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.db.query(
      `SELECT c.id, c.name, c.url, c.area_id AS "areaId", a.name AS "areaName", c.enabled, c.params,
              c.map_x AS "mapX", c.map_y AS "mapY",
              s.status, s.fps, s.latency_ms AS "latencyMs", s.tracks, s.fight_mode AS "fightMode",
              s.last_seen_at AS "lastSeenAt",
              (s.last_seen_at IS NOT NULL AND s.last_seen_at > now() - interval '30 seconds' AND s.status = 'online') AS "isOnline"
       FROM cameras c LEFT JOIN areas a ON a.id = c.area_id LEFT JOIN camera_status s ON s.camera_id = c.id
       ORDER BY c.name`,
    );
    const admin = atLeast(user.role, 'admin');
    return rows.map((r) => ({ ...r, url: admin ? r.url : maskUrl(r.url) }));
  }

  @Post()
  @MinRole('admin')
  async create(@Body() b: CameraDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one(
      `INSERT INTO cameras (id, name, url, area_id, enabled, params, map_x, map_y)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [b.id, b.name, b.url, b.areaId ?? null, b.enabled ?? true, JSON.stringify(b.params ?? {}), b.mapX ?? null, b.mapY ?? null],
    );
    await this.audit.log(me, { action: 'camera.created', targetType: 'camera', targetId: b.id, details: { name: b.name } }, clientIp(req));
    return row;
  }

  @Patch(':id')
  @MinRole('admin')
  async update(@Param('id') id: string, @Body() b: UpdateCameraDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const map: Record<string, string> = { name: 'name', url: 'url', areaId: 'area_id', enabled: 'enabled', params: 'params', mapX: 'map_x', mapY: 'map_y' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      const v = (b as any)[k];
      if (v === undefined) continue;
      params.push(k === 'params' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return this.db.one('SELECT id FROM cameras WHERE id = $1', [id]);
    const row = await this.db.one(`UPDATE cameras SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
    if (!row) throw new NotFoundException();
    const details = { ...b, url: b.url ? maskUrl(b.url) : undefined };
    await this.audit.log(me, { action: 'camera.updated', targetType: 'camera', targetId: id, details }, clientIp(req));
    return row;
  }

  @Delete(':id')
  @MinRole('admin')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one('DELETE FROM cameras WHERE id = $1 RETURNING id', [id]);
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'camera.deleted', targetType: 'camera', targetId: id }, clientIp(req));
  }
}
