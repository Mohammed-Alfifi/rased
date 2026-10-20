/**
 * Demo data for the command centre: five areas, eight cameras and four weeks of
 * SYNTHETIC history (metrics, reviewed alerts, heartbeats), so the dashboards and
 * forecasts have something to show before real cameras are connected.
 *
 * It also sets the `demo_data` setting, which makes the UI show a "demo data" banner.
 * Never run it on a production database.
 *
 *   RASED_DATABASE_URL=... node dist/scripts/seed-demo.js [--rtsp-base rtsp://mediamtx:8554]
 */
import * as bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';

const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const AREAS = [
  { key: 'a', name: 'العنبر أ', poly: [[0.05, 0.08], [0.33, 0.08], [0.33, 0.45], [0.05, 0.45]], expected: 24, base: 18, busy: 1.0 },
  { key: 'b', name: 'العنبر ب', poly: [[0.36, 0.08], [0.64, 0.08], [0.64, 0.45], [0.36, 0.45]], expected: 22, base: 16, busy: 1.25 },
  { key: 'yard', name: 'الساحة الخارجية', poly: [[0.05, 0.52], [0.5, 0.52], [0.5, 0.92], [0.05, 0.92]], expected: null, base: 12, busy: 1.4 },
  { key: 'dining', name: 'قاعة الطعام', poly: [[0.67, 0.08], [0.95, 0.08], [0.95, 0.45], [0.67, 0.45]], expected: null, base: 10, busy: 1.1 },
  { key: 'visit', name: 'قاعة الزيارات', poly: [[0.53, 0.52], [0.95, 0.52], [0.95, 0.92], [0.53, 0.92]], expected: null, base: 6, busy: 0.8 },
];

const CAMERAS = [
  { id: 'wing-a-1', name: 'العنبر أ · الممر', area: 'a', x: 0.12, y: 0.2 },
  { id: 'wing-a-2', name: 'العنبر أ · المدخل', area: 'a', x: 0.27, y: 0.38 },
  { id: 'wing-b-1', name: 'العنبر ب · الممر', area: 'b', x: 0.45, y: 0.2 },
  { id: 'wing-b-2', name: 'العنبر ب · المدخل', area: 'b', x: 0.58, y: 0.38 },
  { id: 'yard-1', name: 'الساحة · الجهة الشمالية', area: 'yard', x: 0.15, y: 0.6 },
  { id: 'yard-2', name: 'الساحة · السور', area: 'yard', x: 0.4, y: 0.85 },
  { id: 'dining-1', name: 'قاعة الطعام', area: 'dining', x: 0.8, y: 0.25 },
  { id: 'visit-1', name: 'قاعة الزيارات', area: 'visit', x: 0.75, y: 0.7 },
];

// Activity profile over the day (0-23): meals, yard time, lights out.
function activity(area: string, hour: number): number {
  const night = hour < 6 || hour >= 23 ? 0.15 : 1;
  if (area === 'yard') return hour >= 9 && hour < 12 ? 1.4 : hour >= 15 && hour < 17 ? 1.2 : 0.1;
  if (area === 'dining') return [7, 13, 19].includes(hour) ? 1.6 : 0.15;
  if (area === 'visit') return hour >= 10 && hour < 14 ? 1.2 : 0.05;
  return night * (hour >= 17 && hour < 21 ? 1.2 : 0.9);
}

const TYPES = [
  { type: 'gathering', severity: 'high', w: 4 },
  { type: 'running', severity: 'medium', w: 4 },
  { type: 'fight', severity: 'critical', w: 1.2 },
  { type: 'person_down', severity: 'critical', w: 0.5 },
  { type: 'restricted_zone', severity: 'high', w: 1.5 },
  { type: 'abandoned_object', severity: 'medium', w: 0.8 },
];

async function main() {
  const rtspBase = process.argv.includes('--rtsp-base') ? process.argv[process.argv.indexOf('--rtsp-base') + 1] : 'rtsp://mediamtx:8554';
  const pool = new Pool({ connectionString: process.env.RASED_DATABASE_URL ?? 'postgresql://rased:rased@localhost:5432/rased' });
  await migrate(pool);
  const r = rng(42);
  const q = (t: string, p: unknown[] = []) => pool.query(t, p as any[]);

  await q(`TRUNCATE areas, cameras, zones, events, zone_metrics, camera_status, camera_heartbeats, area_scores,
           area_forecasts, analytics_reports, headcounts CASCADE`);

  const pwd = await bcrypt.hash('Demo-Password-2026', 10);
  for (const [u, n, role] of [['demo.operator', 'مشغّل تجريبي', 'operator'], ['demo.supervisor', 'مشرف تجريبي', 'supervisor'], ['demo.manager', 'مدير تجريبي', 'manager']]) {
    await q(`INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING`, [u, n, role, pwd]);
  }
  const reviewer = (await q(`SELECT id FROM users WHERE username = 'demo.operator'`)).rows[0].id;

  const areaIds: Record<string, string> = {};
  for (const a of AREAS) {
    const row = await q(`INSERT INTO areas (name, map_polygon, expected_count) VALUES ($1, $2, $3) RETURNING id`, [a.name, JSON.stringify(a.poly), a.expected]);
    areaIds[a.key] = row.rows[0].id;
  }
  for (const c of CAMERAS) {
    await q(`INSERT INTO cameras (id, name, url, area_id, map_x, map_y, params) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.id, c.name, `${rtspBase}/${c.id}`, areaIds[c.area], c.x, c.y, JSON.stringify({})]);
  }
  await q(`INSERT INTO zones (camera_id, name, kind, polygon) VALUES
     ('yard-2', 'منطقة السور', 'perimeter', '[[0.0,0.0],[1.0,0.0],[1.0,0.25],[0.0,0.25]]'),
     ('wing-a-2', 'باب العنبر أ', 'count', '[[0.0,0.0],[1.0,0.0],[1.0,1.0],[0.0,1.0]]'),
     ('wing-b-2', 'باب العنبر ب', 'count', '[[0.0,0.0],[1.0,0.0],[1.0,1.0],[0.0,1.0]]'),
     ('visit-1', 'منطقة التسليم', 'restricted', '[[0.4,0.6],[0.6,0.6],[0.6,1.0],[0.4,1.0]]')`);

  // 4 weeks of 15-minute camera-level metrics, with a few tense evenings in Wing B that precede incidents.
  const end = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
  const start = end - 28 * DAY;
  const tense = new Set<number>();
  for (let d = 2; d < 28; d += 4 + Math.floor(r() * 3)) tense.add(start + d * DAY + 19 * 3_600_000);

  let metrics: unknown[][] = [];
  const flush = async () => {
    if (!metrics.length) return;
    const vals: unknown[] = [];
    const tuples = metrics.map((m, i) => `(${m.map((_, j) => `$${i * m.length + j + 1}`).join(',')})`);
    metrics.forEach((m) => vals.push(...m));
    await q(`INSERT INTO zone_metrics (camera_id, area_id, period_start, period_end, samples, occupancy_avg, occupancy_max,
               motion_avg, cluster_max, runners_max, events) VALUES ${tuples.join(',')}`, vals);
    metrics = [];
  };
  const events: unknown[][] = [];
  for (let t = start; t < end; t += 15 * 60_000) {
    const hour = new Date(t + 3 * 3_600_000).getUTCHours(); // Riyadh local time
    for (const c of CAMERAS) {
      const a = AREAS.find((x) => x.key === c.area)!;
      let act = activity(a.key, hour) * a.busy;
      let cluster = Math.round(2 + 3 * act * r());
      let motion = 0.15 + 0.25 * act + 0.05 * r();
      let runners = r() < 0.04 * act ? 1 : 0;
      const nearTense = [...tense].some((x) => a.key === 'b' && t >= x - 2 * 3_600_000 && t < x);
      if (nearTense) {
        act *= 1.3;
        cluster += 6;
        motion += 0.35;
        runners += 2;
      }
      const occ = Math.max(0, (a.base / 2) * act + r() * 2);
      metrics.push([c.id, areaIds[a.key], new Date(t), new Date(t + 15 * 60_000), 9000, occ, Math.round(occ * 1.3 + 1), motion, cluster, runners, 0]);
      // occasional alerts, more where it is busy
      if (r() < 0.004 * act) {
        const pick = TYPES[Math.floor(r() * TYPES.length)];
        events.push([c.id, areaIds[a.key], pick.type, pick.severity, t + r() * 900_000]);
      }
      if (nearTense && r() < 0.05) events.push([c.id, areaIds[a.key], 'gathering', 'high', t + r() * 900_000]);
    }
    if (metrics.length >= 400) await flush();
  }
  await flush();
  // the incidents at the end of the tense evenings
  for (const x of tense) events.push(['wing-b-1', areaIds.b, 'fight', 'critical', x + 5 * 60_000]);

  for (const [cam, area, type, severity, at] of events as [string, string, string, string, number][]) {
    const old = at < Date.now() - DAY;
    const roll = r();
    const status = !old && roll < 0.5 ? 'new' : roll < (type === 'fight' ? 0.85 : 0.6) ? 'confirmed' : 'dismissed';
    const reason = status === 'dismissed' ? ['normal_activity', 'false_detection', 'duplicate'][Math.floor(r() * 3)] : null;
    const started = new Date(at);
    const received = new Date(at + 2_000 + r() * 2_500);
    await q(
      `INSERT INTO events (camera_id, area_id, type, severity, confidence, status, shadow, started_at, detected_at, received_at,
                           details, reviewed_by, reviewed_at, review_reason)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $8, $9, $10, $11, $12)`,
      [cam, area, type, severity, 0.6 + 0.35 * r(), status, started, received,
       JSON.stringify({ demo: true, detectionDelayMs: Math.round(150 + r() * 250) }),
       status === 'new' ? null : reviewer, status === 'new' ? null : new Date(received.getTime() + 20_000 + r() * 60_000), reason],
    );
  }

  // a day of heartbeats and current status
  for (const c of CAMERAS) {
    const vals: unknown[] = [];
    const tuples: string[] = [];
    for (let t = Date.now() - DAY; t < Date.now(); t += 60_000) {
      const off = c.id === 'yard-2' && t > Date.now() - 3 * 3_600_000 && t < Date.now() - 2.9 * 3_600_000;
      vals.push(c.id, new Date(t), off ? 'offline' : 'online', off ? null : 15 + r() * 3, off ? null : Math.round(120 + r() * 80));
      const k = vals.length;
      tuples.push(`($${k - 4},$${k - 3},$${k - 2},$${k - 1},$${k})`);
    }
    // heartbeats arrive every 10 s in production: six rows per minute keep the uptime maths right
    for (let i = 0; i < 6; i++) {
      await q(`INSERT INTO camera_heartbeats (camera_id, at, status, fps, latency_ms) VALUES ${tuples.join(',')}`, vals);
    }
    await q(`INSERT INTO camera_status (camera_id, status, fps, latency_ms, tracks, fight_mode, last_seen_at)
             VALUES ($1, 'online', $2, $3, $4, 'rules', now())`, [c.id, 15 + r() * 3, Math.round(120 + r() * 80), Math.round(r() * 12)]);
  }
  await q(`INSERT INTO headcounts (area_id, expected, counted, manual, matched, user_id, at)
           SELECT $1::uuid, 24, 24, 24, true, $2::uuid, now() - interval '20 hours' UNION ALL
           SELECT $3::uuid, 22, 21, 22, false, $2::uuid, now() - interval '20 hours' UNION ALL
           SELECT $1::uuid, 24, 24, 24, true, $2::uuid, now() - interval '8 hours'`, [areaIds.a, reviewer, areaIds.b]);

  await q(`UPDATE settings SET value = 'true' WHERE key = 'demo_data'`);
  await q(`UPDATE settings SET value = 'false' WHERE key = 'shadow_mode'`);
  await q(`INSERT INTO audit_log (username, role, action, details) VALUES ('system', 'system', 'demo.seeded', $1)`,
    [JSON.stringify({ areas: AREAS.length, cameras: CAMERAS.length, events: events.length })]);
  // eslint-disable-next-line no-console
  console.log(`demo data: ${AREAS.length} areas, ${CAMERAS.length} cameras, ${events.length} events, 28 days of metrics`);
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
