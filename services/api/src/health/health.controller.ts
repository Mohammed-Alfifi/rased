import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DbService } from '../db/db.service';

@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get('health')
  async health() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'db_unavailable' });
    }
  }

  /** Public facts the login page needs. Demo accounts are listed only on the hosted demo. */
  @Public()
  @Get('system/info')
  info() {
    return {
      name: 'Rased',
      demoLogins: process.env.RASED_DEMO_LOGINS === '1'
        ? { users: ['demo.operator', 'demo.supervisor', 'demo.manager'], password: 'Demo-Password-2026' }
        : null,
    };
  }

  /** System status for the command centre header. */
  @Get('system/status')
  async status() {
    return this.db.one(
      `SELECT (SELECT count(*)::int FROM cameras WHERE enabled) AS "camerasEnabled",
              (SELECT count(*)::int FROM camera_status s JOIN cameras c ON c.id = s.camera_id
                 WHERE c.enabled AND s.status = 'online' AND s.last_seen_at > now() - interval '30 seconds') AS "camerasOnline",
              (SELECT value FROM settings WHERE key = 'shadow_mode') AS "shadowMode",
              (SELECT value FROM settings WHERE key = 'demo_data') AS "demoData",
              (SELECT max(generated_at) FROM area_forecasts) AS "lastForecastAt"`,
    );
  }
}
