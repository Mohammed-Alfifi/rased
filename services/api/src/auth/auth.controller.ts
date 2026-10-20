import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { IsString, MinLength } from 'class-validator';
import { AuditService, clientIp } from '../audit/audit.service';
import { config } from '../config';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';
import { CurrentUser, Public } from './decorators';

class LoginDto {
  @IsString() username: string;
  @IsString() password: string;
}

class ChangePasswordDto {
  @IsString() current: string;
  @IsString() @MinLength(10) next: string;
}

/** Simple in-memory throttle: 5 failed attempts per username per 10 minutes. */
const failures = new Map<string, number[]>();
function tooMany(username: string): boolean {
  const now = Date.now();
  const recent = (failures.get(username) ?? []).filter((t) => now - t < 10 * 60_000);
  failures.set(username, recent);
  return recent.length >= 5;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly db: DbService, private readonly jwt: JwtService, private readonly audit: AuditService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: any) {
    const username = body.username.trim().toLowerCase();
    if (tooMany(username)) throw new UnauthorizedException('too many attempts, try again later');
    const user = await this.db.one(
      'SELECT id, username, full_name, role, password_hash, active FROM users WHERE username = $1',
      [username],
    );
    const ok = user && user.active && (await bcrypt.compare(body.password, user.password_hash));
    if (!ok) {
      failures.get(username)!.push(Date.now());
      await this.audit.log(null, { action: 'auth.login_failed', details: { username } }, clientIp(req));
      throw new UnauthorizedException('wrong username or password');
    }
    failures.delete(username);
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const authUser: AuthUser = { id: user.id, username: user.username, role: user.role, fullName: user.full_name };
    await this.audit.log(authUser, { action: 'auth.login' }, clientIp(req));
    const token = await this.jwt.signAsync({ sub: user.id, kind: 'session' }, { secret: config.jwtSecret, expiresIn: config.jwtTtl });
    return { token, user: authUser };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto, @Req() req: any) {
    const row = await this.db.one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!row || !(await bcrypt.compare(body.current, row.password_hash))) throw new BadRequestException('current password is wrong');
    await this.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await bcrypt.hash(body.next, 12)]);
    await this.audit.log(user, { action: 'auth.password_changed', targetType: 'user', targetId: user.id }, clientIp(req));
  }
}
