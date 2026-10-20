import { BadRequestException, Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

/**
 * Which settings can be changed here and how each is validated. The fight model and its
 * threshold are NOT here: they change only through model activation (/training), which
 * enforces the quality gate.
 */
const SCHEMA: Record<string, (v: unknown) => boolean> = {
  shadow_mode: (v) => typeof v === 'boolean',
  retention_days: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  clip_retention_days: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  timezone: (v) => typeof v === 'string' && (v as string).length < 64,
  demo_data: (v) => typeof v === 'boolean',
};

@Controller('settings')
export class SettingsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Every signed-in user can read settings (the UI shows shadow mode and demo-data banners). */
  @Get()
  async get() {
    const rows = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  @Patch()
  @MinRole('admin')
  async update(@Body() body: Record<string, unknown>, @CurrentUser() me: AuthUser, @Req() req: any) {
    const entries = Object.entries(body ?? {});
    if (!entries.length) throw new BadRequestException('nothing to change');
    for (const [k, v] of entries) {
      if (!SCHEMA[k]) throw new BadRequestException(`unknown setting ${k}`);
      if (!SCHEMA[k](v)) throw new BadRequestException(`invalid value for ${k}`);
    }
    const before = await this.get();
    for (const [k, v] of entries) {
      await this.db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [k, JSON.stringify(v)],
      );
    }
    await this.audit.log(
      me,
      { action: 'settings.updated', targetType: 'settings', details: Object.fromEntries(entries.map(([k, v]) => [k, { from: (before as any)[k], to: v }])) },
      clientIp(req),
    );
    return this.get();
  }
}
