-- Training studio: labelled clips, data splits, training jobs and model versions.

-- One labelled clip. Clips are copied into the training store so they outlive the
-- normal clip retention period. Faces in them are already pixelated.
CREATE TABLE dataset_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task        text NOT NULL DEFAULT 'fight',
  label       text NOT NULL CHECK (label IN ('positive', 'negative')),
  source      text NOT NULL CHECK (source IN ('review', 'upload')),
  event_id    uuid UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  media_path  text NOT NULL,                -- relative to the training store
  camera_id   text,
  split       text CHECK (split IN ('train', 'val', 'test')),
  excluded    boolean NOT NULL DEFAULT false,
  note        text,
  added_by    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  features_path text,                       -- cached pose windows (written by the trainer)
  windows     integer
);
CREATE INDEX dataset_items_task_idx ON dataset_items (task, split, label) WHERE NOT excluded;

CREATE TABLE model_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task         text NOT NULL DEFAULT 'fight',
  version      integer NOT NULL,
  path         text NOT NULL,               -- path inside the shared models volume
  threshold    real NOT NULL,
  metrics      jsonb NOT NULL,              -- test/val metrics, and the active model on the same test set
  data         jsonb NOT NULL DEFAULT '{}', -- item counts per split and label
  status       text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'archived', 'rejected')),
  job_id       uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  activated_by uuid REFERENCES users(id),
  notes        text,
  UNIQUE (task, version)
);

CREATE TABLE training_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task         text NOT NULL DEFAULT 'fight',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  params       jsonb NOT NULL DEFAULT '{}',
  progress     real NOT NULL DEFAULT 0,
  stage        text,
  log          text NOT NULL DEFAULT '',
  result       jsonb,
  model_version_id uuid REFERENCES model_versions(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  heartbeat_at timestamptz
);
CREATE INDEX training_jobs_status_idx ON training_jobs (status, created_at);

-- Global alert threshold for the active fight model (cameras can still override it).
INSERT INTO settings (key, value) VALUES ('fight_threshold', '0.6') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('fight_model', 'null') ON CONFLICT (key) DO NOTHING;
