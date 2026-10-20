import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/** Writes to the append-only audit log: who saw what, when, and what they decided. */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async log(user: AuthUser | null, entry: AuditEntry, ip?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (user_id, username, role, action, target_type, target_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user?.id ?? null,
        user?.username ?? 'system',
        user?.role ?? 'system',
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        JSON.stringify(entry.details ?? {}),
        ip ?? null,
      ],
    );
  }
}

export function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.ip;
}
