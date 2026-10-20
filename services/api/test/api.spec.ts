/**
 * End-to-end API tests against a real PostgreSQL database.
 *   RASED_TEST_DATABASE_URL=postgresql://rased:rased@localhost:5432/rased_test npm test
 */
process.env.NODE_ENV = 'test';
process.env.RASED_DATABASE_URL = process.env.RASED_TEST_DATABASE_URL ?? 'postgresql://rased:rased@localhost:5432/rased_test';
process.env.RASED_ADMIN_PASSWORD = 'Admin-Password-123';
process.env.RASED_SERVICE_KEY = 'test-service-key';
process.env.RASED_JWT_SECRET = 'test-jwt-secret';

import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';

const clips = join(tmpdir(), `rased-clips-${process.pid}`);
process.env.RASED_CLIPS_DIR = clips;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/bootstrap');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RetentionService } = require('../src/retention/retention.service');

let app: any;
let http: any;
const tokens: Record<string, string> = {};
const SERVICE = { 'x-service-key': 'test-service-key' };
let areaId: string;
let zoneId: string;

async function login(username: string, password: string) {
  const res = await request(http).post('/api/auth/login').send({ username, password }).expect(200);
  return res.body.token as string;
}
const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

async function ingestEvent(extra: Record<string, unknown> = {}) {
  const now = Date.now() / 1000;
  const res = await request(http).post('/api/ingest/events').set(SERVICE).send({
    cameraId: 'cam-a', type: 'fight', severity: 'critical', confidence: 0.91,
    startedAt: now - 3, detectedAt: now, trackIds: [1, 2], details: { mode: 'rules' },
    clipPath: 'cam-a/clip1.mp4', snapshotPath: 'cam-a/clip1.jpg', ...extra,
  }).expect(201);
  return res.body.id as string;
}

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.RASED_DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  mkdirSync(join(clips, 'cam-a'), { recursive: true });
  writeFileSync(join(clips, 'cam-a', 'clip1.mp4'), 'fake-mp4');
  writeFileSync(join(clips, 'cam-a', 'clip1.jpg'), 'fake-jpg');

  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  tokens.admin = await login('admin', 'Admin-Password-123');
  for (const role of ['operator', 'supervisor', 'manager']) {
    await request(http).post('/api/users').set(auth('admin'))
      .send({ username: role, fullName: `Test ${role}`, role, password: `${role}-password-1` }).expect(201);
    tokens[role] = await login(role, `${role}-password-1`);
  }
  areaId = (await request(http).post('/api/areas').set(auth('admin')).send({ name: 'Wing A', expectedCount: 4 }).expect(201)).body.id;
  await request(http).post('/api/cameras').set(auth('admin'))
    .send({ id: 'cam-a', name: 'Wing A corridor', url: 'rtsp://user:secret@10.0.0.5/stream1', areaId }).expect(201);
  zoneId = (await request(http).post('/api/zones').set(auth('admin'))
    .send({ cameraId: 'cam-a', name: 'Door', kind: 'count', polygon: [[0, 0], [1, 0], [1, 1]] }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('authentication and roles', () => {
  it('rejects requests without a token', () => request(http).get('/api/events').expect(401));

  it('rejects a wrong password', () =>
    request(http).post('/api/auth/login').send({ username: 'operator', password: 'nope' }).expect(401));

  it('operators cannot manage cameras or users', async () => {
    await request(http).post('/api/cameras').set(auth('operator'))
      .send({ id: 'cam-x', name: 'X', url: 'rtsp://x/y' }).expect(403);
    await request(http).get('/api/users').set(auth('operator')).expect(403);
  });

  it('hides RTSP credentials from non-admins', async () => {
    const op = await request(http).get('/api/cameras').set(auth('operator')).expect(200);
    expect(op.body[0].url).toBe('rtsp://***@10.0.0.5/stream1');
    const ad = await request(http).get('/api/cameras').set(auth('admin')).expect(200);
    expect(ad.body[0].url).toContain('secret');
  });

  it('a disabled account loses access immediately', async () => {
    await request(http).post('/api/users').set(auth('admin'))
      .send({ username: 'temp', fullName: 'Temp', role: 'operator', password: 'temp-password-1' }).expect(201);
    const t = await login('temp', 'temp-password-1');
    const users = (await request(http).get('/api/users').set(auth('admin'))).body;
    const temp = users.find((u: any) => u.username === 'temp');
    await request(http).patch(`/api/users/${temp.id}`).set(auth('admin')).send({ active: false }).expect(200);
    await request(http).get('/api/events').set({ Authorization: `Bearer ${t}` }).expect(401);
  });
});

describe('ingest from the vision service', () => {
  it('needs the service key', () => request(http).get('/api/ingest/config').expect(401));

  it('serves camera and zone configuration', async () => {
    const res = await request(http).get('/api/ingest/config').set(SERVICE).expect(200);
    expect(res.body.cameras[0].zones[0].id).toBe(zoneId);
  });

  it('rejects path traversal in media paths', () =>
    request(http).post('/api/ingest/events').set(SERVICE).send({
      cameraId: 'cam-a', type: 'fight', severity: 'critical', confidence: 0.9,
      startedAt: 1, detectedAt: 2, clipPath: '../../etc/passwd',
    }).expect(400));
});

describe('shadow mode and review', () => {
  it('starts in shadow mode: operators do not see the alert, supervisors do', async () => {
    const id = await ingestEvent();
    const op = await request(http).get('/api/events').set(auth('operator')).expect(200);
    expect(op.body.find((e: any) => e.id === id)).toBeUndefined();
    await request(http).get(`/api/events/${id}`).set(auth('operator')).expect(404);
    const sup = await request(http).get('/api/events?shadow=true').set(auth('supervisor')).expect(200);
    expect(sup.body.find((e: any) => e.id === id)?.shadow).toBe(true);
  });

  it('live alerts reach operators after shadow mode is switched off', async () => {
    await request(http).patch('/api/settings').set(auth('operator')).send({ shadow_mode: false }).expect(403);
    await request(http).patch('/api/settings').set(auth('admin')).send({ shadow_mode: 'no' }).expect(400);
    await request(http).patch('/api/settings').set(auth('admin')).send({ shadow_mode: false }).expect(200);
    const id = await ingestEvent();
    const op = await request(http).get('/api/events?status=new').set(auth('operator')).expect(200);
    expect(op.body.find((e: any) => e.id === id)).toBeDefined();
  });

  it('dismissing needs a reason; decisions are audited; operators cannot overturn', async () => {
    const id = await ingestEvent();
    await request(http).post(`/api/events/${id}/review`).set(auth('operator')).send({ decision: 'dismissed' }).expect(400);
    const r = await request(http).post(`/api/events/${id}/review`).set(auth('operator'))
      .send({ decision: 'dismissed', reason: 'normal_activity', note: 'Sports in the yard' }).expect(201);
    expect(r.body.status).toBe('dismissed');
    expect(r.body.reviewedBy).toBe('Test operator');
    await request(http).post(`/api/events/${id}/review`).set(auth('operator')).send({ decision: 'confirmed' }).expect(403);
    await request(http).post(`/api/events/${id}/review`).set(auth('supervisor')).send({ decision: 'confirmed' }).expect(201);
    const audit = await request(http).get(`/api/audit?targetId=${id}`).set(auth('manager')).expect(200);
    expect(audit.body.map((a: any) => a.action)).toEqual(expect.arrayContaining(['event.reviewed', 'event.review_changed']));
  });

  it('the audit log is append-only', async () => {
    const c = new Client({ connectionString: process.env.RASED_DATABASE_URL });
    await c.connect();
    await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(c.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await c.end();
  });
});

describe('clips', () => {
  it('gives a short-lived link, logs the view, and blocks export for operators', async () => {
    const id = await ingestEvent();
    await request(http).post(`/api/events/${id}/media-token`).set(auth('operator')).send({ download: true }).expect(403);
    const t = await request(http).post(`/api/events/${id}/media-token`).set(auth('operator')).send({}).expect(201);
    const clip = await request(http).get(t.body.clipUrl).expect(200);
    expect(clip.text ?? clip.body.toString()).toContain('fake-mp4');
    await request(http).get('/api/media/not-a-token/clip').expect(401);
    const audit = await request(http).get(`/api/audit?targetId=${id}&action=clip`).set(auth('manager')).expect(200);
    expect(audit.body[0].action).toBe('clip.viewed');
  });
});

describe('headcount', () => {
  it('flags a mismatch as an alert', async () => {
    const now = Date.now() / 1000;
    await request(http).post('/api/ingest/metrics').set(SERVICE).send({ rows: [
      { cameraId: 'cam-a', zoneId, periodStart: now - 60, periodEnd: now, samples: 600, occupancyAvg: 2.8,
        occupancyMax: 3, motionAvg: 0.2, clusterMax: 2, runnersMax: 0, events: 0 },
    ] }).expect(202);
    const res = await request(http).post('/api/headcounts').set(auth('operator')).send({ areaId, manual: 4 }).expect(201);
    expect(res.body).toMatchObject({ expected: 4, counted: 3, matched: false });
    expect(res.body.eventId).toBeTruthy();
  });
});

describe('reports and analytics', () => {
  it('KPIs are for supervisors and above', async () => {
    await request(http).get('/api/reports/kpis').set(auth('operator')).expect(403);
    const res = await request(http).get('/api/reports/kpis').set(auth('supervisor')).expect(200);
    const keys = res.body.indicators.map((i: any) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['fightRecall', 'falseAlertsPerCameraDay', 'uptime']));
    expect(res.body.reviews.dismissed).toBeGreaterThanOrEqual(0);
  });

  it('refuses a synthetic model report', () =>
    request(http).post('/api/reports/model-eval').set(auth('admin')).send({ synthetic: true }).expect(400));

  it('lists area tension even before any score exists', async () => {
    const res = await request(http).get('/api/analytics/areas').set(auth('operator')).expect(200);
    expect(res.body[0].name).toBe('Wing A');
  });
});

describe('retention', () => {
  it('deletes events and clip files past the retention period, and audits it', async () => {
    const id = await ingestEvent({ startedAt: Date.now() / 1000 - 40 * 86400, detectedAt: Date.now() / 1000 - 40 * 86400 });
    const out = await app.get(RetentionService).run();
    expect(out.events).toBeGreaterThanOrEqual(1);
    await request(http).get(`/api/events/${id}`).set(auth('supervisor')).expect(404);
    const audit = await request(http).get('/api/audit?action=retention').set(auth('manager')).expect(200);
    expect(audit.body.length).toBeGreaterThan(0);
  });
});
