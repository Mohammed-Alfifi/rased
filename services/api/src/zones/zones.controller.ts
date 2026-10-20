import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

const KINDS = ['general', 'restricted', 'perimeter', 'visit', 'count'] as const;

class ZoneDto {
  @IsString() cameraId: string;
  @IsString() @MinLength(1) name: string;
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(64) polygon: [number, number][];
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(23, { each: true }) restrictedHours?: number[];
}

class UpdateZoneDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsIn(KINDS) kind?: (typeof KINDS)[number];
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(64) polygon?: [number, number][];
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsInt({ each: true }) restrictedHours?: number[];
}

function checkPolygon(p?: [number, number][]) {
  if (!p) return;
  const ok = p.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((v) => typeof v === 'number' && v >= 0 && v <= 1));
  if (!ok) throw new BadRequestException('polygon points must be [x, y] pairs between 0 and 1');
}

const COLUMNS = `id, camera_id AS "cameraId", name, kind, polygon, params, restricted_hours AS "restrictedHours"`;

@Controller('zones')
export class ZonesController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  list(@Query('cameraId') cameraId?: string) {
    return cameraId
      ? this.db.query(`SELECT ${COLUMNS} FROM zones WHERE camera_id = $1 ORDER BY name`, [cameraId])
      : this.db.query(`SELECT ${COLUMNS} FROM zones ORDER BY camera_id, name`);
  }

  @Post()
  @MinRole('admin')
  async create(@Body() b: ZoneDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    checkPolygon(b.polygon);
    const row = await this.db.one(
      `INSERT INTO zones (camera_id, name, kind, polygon, params, restricted_hours)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [b.cameraId, b.name, b.kind, JSON.stringify(b.polygon), JSON.stringify(b.params ?? {}), b.restrictedHours ?? []],
    );
    await this.audit.log(me, { action: 'zone.created', targetType: 'zone', targetId: row!.id, details: { cameraId: b.cameraId, name: b.name, kind: b.kind } }, clientIp(req));
    return row;
  }

  @Patch(':id')
  @MinRole('admin')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateZoneDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    checkPolygon(b.polygon);
    const map: Record<string, string> = { name: 'name', kind: 'kind', polygon: 'polygon', params: 'params', restrictedHours: 'restricted_hours' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      const v = (b as any)[k];
      if (v === undefined) continue;
      params.push(k === 'polygon' || k === 'params' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to change');
    const row = await this.db.one(`UPDATE zones SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params);
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'zone.updated', targetType: 'zone', targetId: id, details: b as any }, clientIp(req));
    return row;
  }

  @Delete(':id')
  @MinRole('admin')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one('DELETE FROM zones WHERE id = $1 RETURNING id', [id]);
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'zone.deleted', targetType: 'zone', targetId: id }, clientIp(req));
  }
}
