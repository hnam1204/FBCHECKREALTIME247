-- 0003_alert_audit_log.sql: Alert History & Audit Trail for Prompt 05
ALTER TABLE alerts ADD COLUMN evidence_status TEXT DEFAULT 'VERIFIED';
ALTER TABLE alerts ADD COLUMN source_type TEXT DEFAULT 'mbasic/comet';
ALTER TABLE alerts ADD COLUMN rule_version TEXT DEFAULT 'v1.0';
ALTER TABLE alerts ADD COLUMN detection_version TEXT DEFAULT 'v2.1';
ALTER TABLE alerts ADD COLUMN resolution_notes TEXT;
ALTER TABLE alerts ADD COLUMN resolved_by TEXT;

CREATE TABLE IF NOT EXISTS alert_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'Admin / Operator',
  previous_status TEXT,
  new_status TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_alert_id ON alert_audit_logs(alert_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_alerts_status_detected ON alerts(status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_detected ON alerts(severity, detected_at DESC);
