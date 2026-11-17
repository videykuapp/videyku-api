CREATE TABLE IF NOT EXISTS storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO storage_usage (id, used_bytes)
VALUES (1, 0);

UPDATE storage_usage
SET used_bytes = (
  SELECT COALESCE(SUM(size_bytes), 0)
  FROM videos
  WHERE status IN ('ready', 'pending')
);

CREATE INDEX IF NOT EXISTS idx_videos_expiry
ON videos(expires_at);

CREATE INDEX IF NOT EXISTS idx_videos_status
ON videos(status);
