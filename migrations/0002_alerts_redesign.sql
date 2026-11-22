-- 0002_alerts_redesign.sql: Upgrade alerts schema and add alert_rules for Prompt 03
ALTER TABLE alerts ADD COLUMN is_read INTEGER DEFAULT 0;
ALTER TABLE alerts ADD COLUMN read_at TEXT;
ALTER TABLE alerts ADD COLUMN status TEXT DEFAULT 'OPEN';
ALTER TABLE alerts ADD COLUMN acknowledged_at TEXT;
ALTER TABLE alerts ADD COLUMN resolved_at TEXT;
ALTER TABLE alerts ADD COLUMN dedup_key TEXT;
ALTER TABLE alerts ADD COLUMN payload TEXT;
ALTER TABLE alerts ADD COLUMN rule_id INTEGER;

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'gt_count',
  threshold REAL NOT NULL,
  time_window TEXT NOT NULL DEFAULT '5M',
  severity TEXT NOT NULL DEFAULT 'WARNING',
  cooldown_sec INTEGER DEFAULT 300,
  is_active INTEGER DEFAULT 1,
  channels TEXT DEFAULT '["in_app"]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES monitored_targets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_read_status ON alerts(is_read, status);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key, status);
CREATE INDEX IF NOT EXISTS idx_alert_rules_target ON alert_rules(target_id, is_active);
