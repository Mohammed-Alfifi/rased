import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser, Role, ROLES } from '../common/roles';
import { DbService } from '../db/db.service';

class CreateUserDto {
  @IsString() @Matches(/^[a-z0-9._-]{3,32}$/) username: string;
  @IsString() @MinLength(2) fullName: string;
  @IsIn(ROLES) role: Role;
  @IsString() @MinLength(10) password: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MinLength(10) password?: string;
}

const PUBLIC_COLUMNS = 'id, username, full_name AS "fullName", role, active, created_at AS "createdAt", last_login_at AS "lastLoginAt"';

@Controller('users')
@MinRole('admin')
export class UsersController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.db.query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role DESC, username`);
  }

  @Post()
  async create(@Body() b: CreateUserDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    const exists = await this.db.one('SELECT 1 FROM users WHERE username = $1', [b.username]);
    if (exists) throw new BadRequestException('username already exists');
    const user = await this.db.one(
      `INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLUMNS}`,
      [b.username, b.fullName, b.role, await bcrypt.hash(b.password, 12)],
    );
    await this.audit.log(me, { action: 'user.created', targetType: 'user', targetId: user!.id, details: { username: b.username, role: b.role } }, clientIp(req));
    return user;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateUserDto, @CurrentUser() me: AuthUser, @Req() req: any) {
    if (id === me.id && (b.active === false || (b.role && b.role !== 'admin'))) {
      throw new BadRequestException('you cannot disable or demote your own account');
    }
    const current = await this.db.one('SELECT id FROM users WHERE id = $1', [id]);
    if (!current) throw new NotFoundException();
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.fullName !== undefined) add('full_name', b.fullName);
    if (b.role !== undefined) add('role', b.role);
    if (b.active !== undefined) add('active', b.active);
    if (b.password !== undefined) add('password_hash', await bcrypt.hash(b.password, 12));
    if (!sets.length) throw new BadRequestException('nothing to change');
    const user = await this.db.one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`, params);
    const changed = { ...b, password: b.password ? '(changed)' : undefined };
    await this.audit.log(me, { action: 'user.updated', targetType: 'user', targetId: id, details: changed }, clientIp(req));
    return user;
  }
}
