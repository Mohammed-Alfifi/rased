/** Runtime configuration, read once from the environment. */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('RASED_DATABASE_URL', 'postgresql://rased:rased@localhost:5432/rased'),
  // In production these must be set explicitly; dev defaults exist only for local runs.
  jwtSecret: isProd ? required('RASED_JWT_SECRET') : (process.env.RASED_JWT_SECRET ?? 'dev-jwt-secret-change-me'),
  serviceKey: isProd ? required('RASED_SERVICE_KEY') : (process.env.RASED_SERVICE_KEY ?? 'dev-service-key'),
  jwtTtl: process.env.RASED_JWT_TTL ?? '8h',
  clipsDir: process.env.RASED_CLIPS_DIR ?? './data/clips',
  trainingDir: process.env.RASED_TRAINING_DIR ?? './data/training', // labelled clips for the training studio
  webDir: process.env.RASED_WEB_DIR, // serve the built command centre from the API when set
  adminUsername: process.env.RASED_ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.RASED_ADMIN_PASSWORD, // first start only; required if no users exist
  retentionEveryMs: Number(process.env.RASED_RETENTION_EVERY_MS ?? 3_600_000),
  corsOrigin: process.env.RASED_CORS_ORIGIN, // unset = same origin only
};
