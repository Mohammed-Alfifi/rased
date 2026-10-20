import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import express from 'express';
import { existsSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { config } from './config';
import { DbService } from './db/db.service';
import { migrate } from './db/migrate';

/** Builds the app (also used by the tests). */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  if (config.corsOrigin) app.enableCors({ origin: config.corsOrigin.split(','), credentials: false });

  const db = app.get(DbService);
  const applied = await migrate(db.pool);
  if (applied.length) new Logger('Migrate').log(`applied ${applied.join(', ')}`);
  await ensureAdmin(db);

  // Serve the built command centre (single-page app) from the same origin when configured.
  if (config.webDir && existsSync(config.webDir)) {
    const server = app.getHttpAdapter().getInstance();
    server.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    server.get(/^\/(?!api\/).*/, (_req: any, res: any) => res.sendFile(join(config.webDir!, 'index.html')));
  }
  return app;
}

/** On first start, create the admin account from RASED_ADMIN_PASSWORD. */
async function ensureAdmin(db: DbService) {
  const any = await db.one('SELECT 1 FROM users LIMIT 1');
  if (any) return;
  if (!config.adminPassword || config.adminPassword.length < 10) {
    throw new Error('No users yet: set RASED_ADMIN_PASSWORD (at least 10 characters) to create the first admin');
  }
  await db.query(
    `INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, 'System administrator', 'admin', $2)`,
    [config.adminUsername, await bcrypt.hash(config.adminPassword, 12)],
  );
  new Logger('Bootstrap').log(`created admin user "${config.adminUsername}"`);
}
