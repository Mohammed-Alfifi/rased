/** Columns returned for an event, joined with camera, zone, area and reviewer (alias e, c, z, a, u). */
export const EVENT_COLUMNS = `
  e.id, e.type, e.severity, e.confidence, e.status, e.shadow,
  e.started_at AS "startedAt", e.detected_at AS "detectedAt", e.received_at AS "receivedAt",
  e.camera_id AS "cameraId", c.name AS "cameraName",
  e.zone_id AS "zoneId", z.name AS "zoneName",
  e.area_id AS "areaId", a.name AS "areaName",
  e.track_ids AS "trackIds", e.bbox, e.details,
  (e.clip_path IS NOT NULL) AS "hasClip", (e.snapshot_path IS NOT NULL) AS "hasSnapshot",
  e.reviewed_at AS "reviewedAt", u.full_name AS "reviewedBy", e.review_reason AS "reviewReason", e.review_note AS "reviewNote"`;

export const EVENT_FROM = `
  FROM events e
  LEFT JOIN cameras c ON c.id = e.camera_id
  LEFT JOIN zones z ON z.id = e.zone_id
  LEFT JOIN areas a ON a.id = e.area_id
  LEFT JOIN users u ON u.id = e.reviewed_by`;
