-- Rased schema. Applied in order by the API at start-up (see src/db/migrate.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('operator', 'supervisor', 'manager', 'admin')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- A facility area (a wing, a yard, the visit hall). Tension and forecasts are per area.
CREATE TABLE areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- polygon on the facility map image, normalized 0..1
  map_polygon jsonb NOT NULL DEFAULT '[]',
  expected_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cameras (
  id         text PRIMARY KEY,               -- short slug, e.g. "wing-a-1"
  name       text NOT NULL,
  url        text NOT NULL,                  -- RTSP URL; only admins can read it
  area_id    uuid REFERENCES areas(id) ON DELETE SET NULL,
  enabled    boolean NOT NULL DEFAULT true,
  params     jsonb NOT NULL DEFAULT '{}',    -- rule thresholds, see docs/rules.md
  map_x      real,                           -- position on the facility map, 0..1
  map_y      real,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id  text NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('general', 'restricted', 'perimeter', 'visit', 'count')),
  polygon    jsonb NOT NULL,                 -- [[x, y], ...] normalized to the camera frame
  params     jsonb NOT NULL DEFAULT '{}',
  restricted_hours integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id     text NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES zones(id) ON DELETE SET NULL,
  area_id       uuid REFERENCES areas(id) ON DELETE SET NULL,
  type          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  confidence    real NOT NULL,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'dismissed')),
  shadow        boolean NOT NULL DEFAULT false,   -- recorded during shadow mode: never shown as a live alert
  started_at    timestamptz NOT NULL,
  detected_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  track_ids     integer[] NOT NULL DEFAULT '{}',
  bbox          jsonb,
  details       jsonb NOT NULL DEFAULT '{}',
  clip_path     text,
  snapshot_path text,
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  review_reason text,                              -- why it was dismissed (false alarm category)
  review_note   text
);
CREATE INDEX events_started_idx ON events (started_at DESC);
CREATE INDEX events_status_idx ON events (status, shadow, started_at DESC);
CREATE INDEX events_area_idx ON events (area_id, started_at DESC);

-- One row per camera (zone_id NULL) or zone per metrics period (default 1 minute).
CREATE TABLE zone_metrics (
  id            bigserial PRIMARY KEY,
  camera_id     text NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES zones(id) ON DELETE CASCADE,
  area_id       uuid REFERENCES areas(id) ON DELETE SET NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  samples       integer NOT NULL,
  occupancy_avg real NOT NULL,
  occupancy_max integer NOT NULL,
  motion_avg    real NOT NULL,
  cluster_max   integer NOT NULL,
  runners_max   integer NOT NULL,
  events        integer NOT NULL DEFAULT 0
);
CREATE INDEX zone_metrics_area_idx ON zone_metrics (area_id, period_start);
CREATE INDEX zone_metrics_zone_idx ON zone_metrics (zone_id, period_start);

CREATE TABLE camera_status (
  camera_id    text PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  status       text NOT NULL,
  fps          real,
  latency_ms   integer,
  tracks       integer,
  fight_mode   text,
  last_seen_at timestamptz NOT NULL
);

-- Heartbeat history, for the uptime KPI.
CREATE TABLE camera_heartbeats (
  id         bigserial PRIMARY KEY,
  camera_id  text NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  status     text NOT NULL,
  fps        real,
  latency_ms integer
);
CREATE INDEX camera_heartbeats_idx ON camera_heartbeats (camera_id, at);

CREATE TABLE area_scores (
  id         bigserial PRIMARY KEY,
  area_id    uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  bucket     timestamptz NOT NULL,
  tension    real NOT NULL,
  anomaly    real NOT NULL DEFAULT 0,
  components jsonb NOT NULL DEFAULT '{}',
  UNIQUE (area_id, bucket)
);

CREATE TABLE area_forecasts (
  id           bigserial PRIMARY KEY,
  area_id      uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  generated_at timestamptz NOT NULL,
  hour         timestamptz NOT NULL,
  pred         real NOT NULL,
  lower_bound  real NOT NULL,
  upper_bound  real NOT NULL,
  method       text NOT NULL
);
CREATE INDEX area_forecasts_idx ON area_forecasts (area_id, generated_at DESC);

CREATE TABLE analytics_reports (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  data         jsonb NOT NULL
);

CREATE TABLE headcounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id    uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  expected   integer NOT NULL,
  counted    integer NOT NULL,
  manual     integer,                         -- the officers' count, to measure accuracy
  matched    boolean NOT NULL,
  user_id    uuid REFERENCES users(id),
  event_id   uuid REFERENCES events(id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('shadow_mode', 'true'),           -- start in shadow mode: no live alerts until switched off
  ('retention_days', '30'),
  ('clip_retention_days', '30'),
  ('timezone', '"Asia/Riyadh"'),
  ('demo_data', 'false');

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  username    text,
  role        text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  ip          text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- The audit log is append-only: no application path can change or erase history.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
