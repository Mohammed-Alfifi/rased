import { Controller, Get, Query } from '@nestjs/common';
import { MinRole } from '../auth/decorators';
import { DbService } from '../db/db.service';

@Controller('audit')
@MinRole('manager')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(
    @Query('action') action?: string,
    @Query('username') username?: string,
    @Query('targetId') targetId?: string,
    @Query('before') before?: string,
    @Query('limit') limit = '100',
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (action) add('action LIKE ?', `${action}%`);
    if (username) add('username = ?', username);
    if (targetId) add('target_id = ?', targetId);
    if (before) add('id < ?', Number(before));
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.query(
      `SELECT id, at, username, role, action, target_type AS "targetType", target_id AS "targetId", details, ip
       FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
  }
}
