import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

class AreaDto {
  @IsString() @MinLength(1) name: string;
  @IsOptional() @IsArray() mapPolygon?: [number, number][];
  @IsOptional() @IsInt() @Min(0) expectedCount?: number | null;
}

class UpdateAreaDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsArray() mapPolygon?: [number, number][];
  @IsOptional() @IsInt() @Min(0) expectedCount?: number | null;
}

const COLUMNS = `id, name, map_polygon AS "mapPolygon", expected_count AS "expectedCount"`;

@Controller('areas')
export class AreasController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.db.query(
      `SELECT a.id, a.name, a.map_polygon AS "mapPolygon", a.expected_count AS "expectedCount",
              (SELECT count(*)::int FROM cameras c WHERE c.area_id = a.id) AS cameras
       FROM areas a ORDER BY a.name`,
    );
  }

  @Post()
  @MinRole('admin')
  async create(@Body() b: AreaDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one(
      `INSERT INTO areas (name, map_polygon, expected_count) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [b.name, JSON.stringify(b.mapPolygon ?? []), b.expectedCount ?? null],
    );
    await this.audit.log(me, { action: 'area.created', targetType: 'area', targetId: row!.id, details: { name: b.name } }, clientIp(req));
    return row;
  }

  @Patch(':id')
  @MinRole('admin')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateAreaDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one(
      `UPDATE areas SET name = COALESCE($2, name), map_polygon = COALESCE($3, map_polygon),
              expected_count = CASE WHEN $5 THEN $4 ELSE expected_count END
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, b.name ?? null, b.mapPolygon ? JSON.stringify(b.mapPolygon) : null, b.expectedCount ?? null, b.expectedCount !== undefined],
    );
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'area.updated', targetType: 'area', targetId: id, details: b as any }, clientIp(req));
    return row;
  }

  @Delete(':id')
  @MinRole('admin')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: any) {
    const row = await this.db.one('DELETE FROM areas WHERE id = $1 RETURNING id', [id]);
    if (!row) throw new NotFoundException();
    await this.audit.log(me, { action: 'area.deleted', targetType: 'area', targetId: id }, clientIp(req));
  }
}
