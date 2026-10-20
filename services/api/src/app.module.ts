import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AnalyticsController } from './analytics/analytics.controller';
import { AreasController } from './areas/areas.controller';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { CamerasController } from './cameras/cameras.controller';
import { config } from './config';
import { DbService } from './db/db.service';
import { EventsBus } from './events/events.bus';
import { EventsController } from './events/events.controller';
import { HeadcountsController } from './headcounts/headcounts.controller';
import { HealthController } from './health/health.controller';
import { IngestController } from './ingest/ingest.controller';
import { ReportsController } from './reports/reports.controller';
import { RetentionService } from './retention/retention.service';
import { SettingsController } from './settings/settings.controller';
import { UsersController } from './users/users.controller';
import { ZonesController } from './zones/zones.controller';

@Global()
@Module({
  imports: [JwtModule.register({ secret: config.jwtSecret })],
  controllers: [
    AuthController,
    UsersController,
    AreasController,
    CamerasController,
    ZonesController,
    IngestController,
    EventsController,
    AnalyticsController,
    HeadcountsController,
    ReportsController,
    SettingsController,
    AuditController,
    HealthController,
  ],
  providers: [DbService, AuditService, EventsBus, RetentionService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [DbService, AuditService, EventsBus],
})
export class AppModule {}
