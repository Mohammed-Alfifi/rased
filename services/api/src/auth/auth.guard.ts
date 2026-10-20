import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';
import { atLeast, AuthUser, Role } from '../common/roles';
import { DbService } from '../db/db.service';
import { MIN_ROLE, PUBLIC, QUERY_TOKEN, SERVICE } from './decorators';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Global guard. Every route needs a valid user token unless marked @Public or
 * @ServiceOnly; @MinRole adds a role check. Users are re-read from the database on
 * every request so a disabled account or a role change takes effect at once.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>(SERVICE, targets)) {
      const key = req.headers['x-service-key'];
      if (typeof key === 'string' && sameSecret(key, config.serviceKey)) return true;
      throw new UnauthorizedException('invalid service key');
    }

    let token: string | undefined;
    const header = req.headers.authorization as string | undefined;
    if (header?.startsWith('Bearer ')) token = header.slice(7);
    else if (this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN, targets) && typeof req.query.token === 'string') {
      token = req.query.token;
    }
    if (!token) throw new UnauthorizedException();

    let payload: { sub: string; kind?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: config.jwtSecret });
    } catch {
      throw new UnauthorizedException('session expired');
    }
    if (payload.kind && payload.kind !== 'session') throw new UnauthorizedException();
    const user = await this.db.one<{ id: string; username: string; role: Role; full_name: string; active: boolean }>(
      'SELECT id, username, role, full_name, active FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!user || !user.active) throw new UnauthorizedException('account disabled');
    const authUser: AuthUser = { id: user.id, username: user.username, role: user.role, fullName: user.full_name };
    req.user = authUser;

    const min = this.reflector.getAllAndOverride<Role>(MIN_ROLE, targets);
    if (min && !atLeast(authUser.role, min)) throw new ForbiddenException('insufficient role');
    return true;
  }
}
