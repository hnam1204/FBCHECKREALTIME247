process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/db/database');
const alertEngine = require('../src/analytics/alertEngine');

test('Alert Audit Log: Automatic audit trail creation & state transitions', () => {
  const db = getDb();
  const testUrl = `https://fb.com/test_audit_${Date.now()}`;
  const info = db.prepare(`
    INSERT INTO monitored_targets (
      original_url, normalized_url, target_type, content_id,
      author_name, status, check_interval_sec, priority, created_at
    ) VALUES (
      ?, ?, 'post', 'audit_target_1',
      'Audit Author', 'ACTIVE', 300, 1, ?
    )
  `).run(testUrl, testUrl, new Date().toISOString());

  const targetId = Number(info.lastInsertRowid);

  // 1. Trigger alert
  const alert = alertEngine.recordAlert({
    targetId,
    alertType: 'REACTION_SPIKE',
    severity: 'CRITICAL',
    message: 'Tăng đột biến +150 tương tác',
    metricName: 'reactions',
    payload: { oldVal: 100, newVal: 250, delta: 150, threshold: 50 },
    evidenceStatus: 'VERIFIED',
    sourceType: 'mbasic/comet',
    detectionVersion: 'NHN Detection Engine v2.1'
  });

  assert.ok(alert && alert.id, 'Alert should be created');

  // Verify initial audit entry in alert_audit_logs
  const initialLogs = db.prepare(`
    SELECT * FROM alert_audit_logs WHERE alert_id = ? ORDER BY id ASC
  `).all(alert.id);

  assert.equal(initialLogs.length, 1);
  assert.equal(initialLogs[0].action_type, 'TRIGGERED');
  assert.equal(initialLogs[0].new_status, 'OPEN');
  assert.equal(initialLogs[0].actor, 'System / AlertEngine');

  // 2. Transition: Acknowledge (OPEN -> ACKNOWLEDGED)
  const nowStr1 = new Date().toISOString();
  db.prepare(`
    UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged = 1, acknowledged_at = ? WHERE id = ?
  `).run(nowStr1, alert.id);

  db.prepare(`
    INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
    VALUES (?, 'ACKNOWLEDGE', 'Operator-HaiNam', 'OPEN', 'ACKNOWLEDGED', 'Tiếp nhận cảnh báo', ?)
  `).run(alert.id, nowStr1);

  // 3. Transition: Resolve (ACKNOWLEDGED -> RESOLVED)
  const nowStr2 = new Date().toISOString();
  db.prepare(`
    UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, resolved_by = 'Operator-HaiNam', resolution_notes = 'Xác minh tương tác thực' WHERE id = ?
  `).run(nowStr2, alert.id);

  db.prepare(`
    INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
    VALUES (?, 'RESOLVE', 'Operator-HaiNam', 'ACKNOWLEDGED', 'RESOLVED', 'Xác minh tương tác thực', ?)
  `).run(alert.id, nowStr2);

  // 4. Operator Note
  const nowStr3 = new Date().toISOString();
  db.prepare(`
    INSERT INTO alert_audit_logs (alert_id, action_type, actor, notes, created_at)
    VALUES (?, 'NOTE', 'Analyst', 'Báo cáo kiểm toán lưu trữ', ?)
  `).run(alert.id, nowStr3);

  // Verify complete audit trail history
  const allLogs = db.prepare(`
    SELECT * FROM alert_audit_logs WHERE alert_id = ? ORDER BY id ASC
  `).all(alert.id);

  assert.equal(allLogs.length, 4);
  assert.equal(allLogs[0].action_type, 'TRIGGERED');
  assert.equal(allLogs[1].action_type, 'ACKNOWLEDGE');
  assert.equal(allLogs[1].previous_status, 'OPEN');
  assert.equal(allLogs[1].new_status, 'ACKNOWLEDGED');
  assert.equal(allLogs[2].action_type, 'RESOLVE');
  assert.equal(allLogs[2].previous_status, 'ACKNOWLEDGED');
  assert.equal(allLogs[2].new_status, 'RESOLVED');
  assert.equal(allLogs[3].action_type, 'NOTE');
  assert.equal(allLogs[3].actor, 'Analyst');
});
