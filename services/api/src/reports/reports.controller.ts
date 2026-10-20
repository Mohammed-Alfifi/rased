import { BadRequestException, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { AuditService, clientIp } from '../audit/audit.service';
import { CurrentUser, MinRole } from '../auth/decorators';
import { AuthUser } from '../common/roles';
import { DbService } from '../db/db.service';

/** Pilot success targets, from the project plan. */
export const TARGETS = {
  fightRecall: { label: 'Fight detection recall', target: 0.85, op: '>=' },
  fallRecall: { label: 'Fall detection recall', target: 0.9, op: '>=' },
  falseAlertsPerCameraDay: { label: 'False alerts per camera per day', target: 3, op: '<' },
  alertLatencySecondsP50: { label: 'Time from event start to alert (median, s)', target: 5, op: '<' },
  processingFps: { label: 'Processing rate per camera (fps)', target: 15, op: '>=' },
  uptime: { label: 'Uptime', target: 0.99, op: '>=' },
  headcountAccuracy: { label: 'Automatic headcount accuracy', target: 0.95, op: '>=' },
} as const;

type Op = '>=' | '<';
function verdict(value: number | null, target: number, op: Op): 'met' | 'not_met' | 'no_data' {
  if (value === null || value === undefined || Number.isNaN(value)) return 'no_data';
  return (op === '>=' ? value >= target : value < target) ? 'met' : 'not_met';
}

@Controller('reports')
@MinRole('supervisor')
export class ReportsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** The plan's success indicators, measured from operational data over the last `days` days. */
  @Get('kpis')
  async kpis(@Query('days') daysQ = '14') {
    const days = Math.min(Math.max(Number(daysQ) || 14, 1), 365);
    const p = [days];
    const reviews = await this.db.one(
      `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
              count(*) FILTER (WHERE status = 'new')::int AS pending,
              count(*)::int AS total
       FROM events WHERE started_at > now() - make_interval(days => $1)
         AND type NOT IN ('camera_offline', 'count_mismatch')`, p);
    const cameraDays = await this.db.one(
      `SELECT count(DISTINCT camera_id || date_trunc('day', at)::text)::int AS n
       FROM camera_heartbeats WHERE at > now() - make_interval(days => $1)`, p);
    const latency = await this.db.one(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM received_at - started_at)) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM received_at - started_at)) AS p95,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (details->>'detectionDelayMs')::numeric / 1000) AS processing_p50
       FROM events WHERE started_at > now() - make_interval(days => $1)
         AND type NOT IN ('camera_offline', 'prolonged_inactivity', 'abandoned_object', 'count_mismatch', 'gathering')`, p);
    const review = await this.db.one(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reviewed_at - received_at)) AS p50
       FROM events WHERE reviewed_at IS NOT NULL AND NOT shadow AND started_at > now() - make_interval(days => $1)`, p);
    const cams = await this.db.query(
      `SELECT c.id, c.name,
              avg(h.fps) FILTER (WHERE h.status = 'online') AS fps,
              count(*) FILTER (WHERE h.status = 'online')::float
                / greatest(extract(epoch FROM now() - min(h.at)) / 10, 1) AS uptime,
              (SELECT count(*)::int FROM events e WHERE e.camera_id = c.id AND e.status = 'dismissed'
                 AND e.started_at > now() - make_interval(days => $1)) AS dismissed
       FROM cameras c LEFT JOIN camera_heartbeats h ON h.camera_id = c.id AND h.at > now() - make_interval(days => $1)
       GROUP BY c.id, c.name ORDER BY c.name`, p);
    const head = await this.db.one(
      `SELECT avg(1 - abs(counted - manual)::float / greatest(manual, 1)) AS accuracy, count(*)::int AS n
       FROM headcounts WHERE manual IS NOT NULL AND at > now() - make_interval(days => $1)`, p);
    const model = await this.db.one(
      `SELECT data, generated_at AS "generatedAt" FROM analytics_reports WHERE kind = 'model_eval' ORDER BY id DESC LIMIT 1`);
    const reasons = await this.db.query(
      `SELECT review_reason AS reason, count(*)::int AS n FROM events
       WHERE status = 'dismissed' AND started_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 2 DESC`, p);

    const online = cams.filter((c) => c.fps !== null);
    const values: Record<keyof typeof TARGETS, number | null> = {
      fightRecall: model?.data?.fight?.video?.recall ?? null,
      fallRecall: model?.data?.fall?.recall ?? null,
      falseAlertsPerCameraDay: cameraDays?.n ? reviews!.dismissed / cameraDays.n : null,
      alertLatencySecondsP50: latency?.p50 !== null ? Number(latency!.p50) : null,
      processingFps: online.length ? Math.min(...online.map((c) => Number(c.fps))) : null,
      uptime: online.length ? Math.min(...online.map((c) => Math.min(1, Number(c.uptime)))) : null,
      headcountAccuracy: head?.n ? Number(head.accuracy) : null,
    };
    return {
      days,
      indicators: Object.entries(TARGETS).map(([key, t]) => {
        const value = values[key as keyof typeof TARGETS];
        return { key, ...t, value: value === null ? null : Math.round(value * 1000) / 1000, status: verdict(value, t.target, t.op as Op) };
      }),
      reviews: { ...reviews, precision: reviews!.confirmed + reviews!.dismissed ? reviews!.confirmed / (reviews!.confirmed + reviews!.dismissed) : null },
      dismissReasons: reasons,
      latency: { p50: latency?.p50 ?? null, p95: latency?.p95 ?? null, processingP50: latency?.processing_p50 ?? null },
      reviewTimeSecondsP50: review?.p50 ?? null,
      cameras: cams,
      headcounts: head,
      modelEvaluation: model ?? null,
    };
  }

  /** Daily operational summary: alerts by type, by area and by hour. */
  @Get('daily')
  async daily(@Query('date') date?: string) {
    const day = date ? new Date(date) : new Date();
    if (Number.isNaN(day.getTime())) throw new BadRequestException('bad date');
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const p = [start];
    const byType = await this.db.query(
      `SELECT type, severity, count(*)::int AS n, count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
       FROM events WHERE NOT shadow AND started_at >= $1 AND started_at < $1 + interval '1 day'
       GROUP BY 1, 2 ORDER BY n DESC`, p);
    const byArea = await this.db.query(
      `SELECT a.name AS area, count(e.id)::int AS n, max(s.tension) AS "peakTension"
       FROM areas a
       LEFT JOIN events e ON e.area_id = a.id AND NOT e.shadow AND e.started_at >= $1 AND e.started_at < $1 + interval '1 day'
       LEFT JOIN area_scores s ON s.area_id = a.id AND s.bucket >= $1 AND s.bucket < $1 + interval '1 day'
       GROUP BY a.name ORDER BY n DESC`, p);
    const byHour = await this.db.query(
      `SELECT extract(hour FROM started_at)::int AS hour, count(*)::int AS n
       FROM events WHERE NOT shadow AND started_at >= $1 AND started_at < $1 + interval '1 day'
       GROUP BY 1 ORDER BY 1`, p);
    return { date: start.toISOString().slice(0, 10), byType, byArea, byHour };
  }

  /** Store the evaluation report produced by training (report.json), so KPIs can show recall. */
  @Post('model-eval')
  @MinRole('admin')
  async modelEval(@Body() body: Record<string, unknown>, @CurrentUser() me: AuthUser, @Req() req: any) {
    if (!body || typeof body !== 'object') throw new BadRequestException('expected JSON report');
    if ((body as any).synthetic) throw new BadRequestException('refusing a synthetic smoke-test report');
    await this.db.query(`INSERT INTO analytics_reports (kind, data) VALUES ('model_eval', $1)`, [JSON.stringify(body)]);
    await this.audit.log(me, { action: 'model_eval.uploaded', targetType: 'report' }, clientIp(req));
    return { ok: true };
  }
}
