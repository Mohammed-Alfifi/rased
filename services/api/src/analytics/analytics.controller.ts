import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { MinRole } from '../auth/decorators';
import { DbService } from '../db/db.service';

/**
 * Tension and forecasts are per AREA and per TIME. Nothing here scores or ranks
 * individuals; the inputs are aggregate counts with no identity.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly db: DbService) {}

  @Get('areas')
  areas() {
    return this.db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (area_id) area_id, bucket, tension, anomaly, components
         FROM area_scores WHERE bucket > now() - interval '3 hours' ORDER BY area_id, bucket DESC),
       hour_ago AS (
         SELECT DISTINCT ON (area_id) area_id, tension
         FROM area_scores WHERE bucket <= now() - interval '1 hour' AND bucket > now() - interval '4 hours'
         ORDER BY area_id, bucket DESC),
       peak AS (
         SELECT DISTINCT ON (f.area_id) f.area_id, f.pred, f.hour
         FROM area_forecasts f
         JOIN (SELECT area_id, max(generated_at) g FROM area_forecasts GROUP BY area_id) m
           ON m.area_id = f.area_id AND m.g = f.generated_at
         WHERE f.hour < now() + interval '12 hours'
         ORDER BY f.area_id, f.pred DESC)
       SELECT a.id, a.name, a.map_polygon AS "mapPolygon", a.expected_count AS "expectedCount",
              l.tension, l.anomaly, l.components, l.bucket AS "scoredAt",
              (l.tension - h.tension) AS "change1h",
              p.pred AS "peak12h", p.hour AS "peakAt",
              (SELECT count(*)::int FROM events e WHERE e.area_id = a.id AND e.status = 'new' AND NOT e.shadow) AS "openAlerts",
              (SELECT count(*)::int FROM cameras c JOIN camera_status s ON s.camera_id = c.id
                 WHERE c.area_id = a.id AND s.status = 'online' AND s.last_seen_at > now() - interval '30 seconds') AS "camerasOnline",
              (SELECT count(*)::int FROM cameras c WHERE c.area_id = a.id) AS "camerasTotal"
       FROM areas a
       LEFT JOIN latest l ON l.area_id = a.id
       LEFT JOIN hour_ago h ON h.area_id = a.id
       LEFT JOIN peak p ON p.area_id = a.id
       ORDER BY l.tension DESC NULLS LAST, a.name`,
    );
  }

  @Get('areas/:id/history')
  async history(@Param('id', ParseUUIDPipe) id: string, @Query('hours') hours = '48') {
    const h = Math.min(Math.max(Number(hours) || 48, 1), 24 * 60);
    return this.db.query(
      `SELECT bucket, tension, anomaly, components FROM area_scores
       WHERE area_id = $1 AND bucket > now() - make_interval(hours => $2) ORDER BY bucket`,
      [id, h],
    );
  }

  @Get('areas/:id/forecast')
  async forecast(@Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.query(
      `SELECT hour, pred, lower_bound AS lower, upper_bound AS upper, method, generated_at AS "generatedAt"
       FROM area_forecasts
       WHERE area_id = $1 AND generated_at = (SELECT max(generated_at) FROM area_forecasts WHERE area_id = $1)
       ORDER BY hour`,
      [id],
    );
    return rows;
  }

  /** Areas expected to reach `threshold` in the next `hours` hours (default 60 within 12 h). */
  @Get('hotspots')
  hotspots(@Query('threshold') threshold = '60', @Query('hours') hours = '12') {
    return this.db.query(
      `WITH latest AS (
         SELECT f.* FROM area_forecasts f
         JOIN (SELECT area_id, max(generated_at) g FROM area_forecasts GROUP BY area_id) m
           ON m.area_id = f.area_id AND m.g = f.generated_at
         WHERE f.hour > now() AND f.hour <= now() + make_interval(hours => $2)),
       peak AS (SELECT DISTINCT ON (area_id) area_id, pred, hour, upper_bound FROM latest ORDER BY area_id, pred DESC),
       cur AS (SELECT DISTINCT ON (area_id) area_id, tension FROM area_scores ORDER BY area_id, bucket DESC)
       SELECT a.id AS "areaId", a.name AS "areaName", p.pred AS peak, p.hour AS "peakAt", p.upper_bound AS "peakUpper",
              c.tension AS current, (p.pred > coalesce(c.tension, 0) + 10) AS rising
       FROM peak p JOIN areas a ON a.id = p.area_id LEFT JOIN cur c ON c.area_id = p.area_id
       WHERE p.pred >= $1
       ORDER BY p.pred DESC`,
      [Number(threshold) || 60, Math.min(Math.max(Number(hours) || 12, 1), 24)],
    );
  }

  /** What the signals looked like before confirmed serious incidents (evidence for the forecast gate). */
  @Get('precursors')
  @MinRole('supervisor')
  async precursors() {
    const row = await this.db.one(
      `SELECT generated_at AS "generatedAt", data FROM analytics_reports WHERE kind = 'precursors' ORDER BY id DESC LIMIT 1`,
    );
    if (!row) throw new NotFoundException('no report yet');
    return row;
  }
}
