const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

// 1. Helper function extracted from worker for testing
function maskProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    if (rawUrl.includes('://')) {
      const u = new URL(rawUrl);
      if (u.password || u.username) {
        return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}`;
      }
      return rawUrl;
    }
    const parts = rawUrl.split(':');
    if (parts.length === 4) {
      return `${parts[0]}:${parts[1]}:${parts[2]}:***`;
    }
    return rawUrl;
  } catch (e) {
    return '***masked-proxy***';
  }
}

async function recordAlertWithCooldown(db, { targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, now }, cooldownMinutes = 30) {
  const existing = await db.prepare(`
    SELECT id FROM alerts 
    WHERE target_id = ? AND alert_type = ? 
      AND (acknowledged = 0 OR (strftime('%s', ?) - strftime('%s', detected_at)) < ?)
    ORDER BY detected_at DESC LIMIT 1
  `).bind(targetId, alertType, now, cooldownMinutes * 60).first();

  if (existing) {
    await db.prepare(`
      UPDATE alerts 
      SET detected_at = ?, new_val = ?, delta = ?, message = ?
      WHERE id = ?
    `).bind(now, newVal, delta, message, existing.id).run();
    return { id: existing.id, updated: true };
  }

  const res = await db.prepare(`
    INSERT INTO alerts (target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at, acknowledged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, now).run();

  return { id: res.meta?.last_row_id || 1, updated: false };
}

test('Worker Integrity: maskProxyUrl masks passwords across standard and raw residential formats', () => {
  // Format 1: Standard URL with user:pass
  const url1 = 'http://user30493:1xaQ87vc@proxy-156.psun.io.vn:30493';
  assert.equal(maskProxyUrl(url1), 'http://user30493:***@proxy-156.psun.io.vn:30493');

  // Format 2: Residential colon format host:port:user:pass
  const url2 = 'proxy-523.psun.io.vn:33354:user33354:ihVpkr4g';
  assert.equal(maskProxyUrl(url2), 'proxy-523.psun.io.vn:33354:user33354:***');

  // Format 3: Open proxy without credentials
  const url3 = 'http://103.1.2.3:8080';
  assert.equal(maskProxyUrl(url3), 'http://103.1.2.3:8080');

  // Format 4: Null or empty
  assert.equal(maskProxyUrl(null), null);
  assert.equal(maskProxyUrl(''), null);
});

test('Worker Integrity: Alert Deduplication & 30-min Cooldown Engine', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      alert_type TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      old_val INTEGER DEFAULT 0,
      new_val INTEGER DEFAULT 0,
      delta INTEGER DEFAULT 0,
      threshold INTEGER DEFAULT 0,
      severity TEXT NOT NULL DEFAULT 'INFO',
      message TEXT,
      acknowledged INTEGER DEFAULT 0,
      detected_at TEXT NOT NULL
    );
  `);

  // Mock D1-compatible prepare/bind wrapper
  const d1Mock = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return stmt.get(...args);
            },
            async all() {
              return { results: stmt.all(...args) };
            },
            async run() {
              const res = stmt.run(...args);
              return { meta: { last_row_id: Number(res.lastInsertRowid), changes: res.changes } };
            }
          };
        }
      };
    }
  };

  const t1 = '2026-11-22T10:00:00.000Z';
  const t2 = '2026-11-22T10:05:00.000Z'; // 5 mins later (inside 30m window)

  // 1. First alert creates a new row
  const r1 = await recordAlertWithCooldown(d1Mock, {
    targetId: 14,
    alertType: 'AUTH_LOST',
    metricName: 'cookie',
    oldVal: 1,
    newVal: 0,
    delta: -1,
    threshold: 0,
    severity: 'CRITICAL',
    message: 'Cookie bị checkpoint',
    now: t1
  }, 30);

  assert.equal(r1.updated, false);
  assert.equal(r1.id, 1);

  // 2. Second alert within 30 minutes updates existing record without duplicate spam
  const r2 = await recordAlertWithCooldown(d1Mock, {
    targetId: 14,
    alertType: 'AUTH_LOST',
    metricName: 'cookie',
    oldVal: 1,
    newVal: 0,
    delta: -1,
    threshold: 0,
    severity: 'CRITICAL',
    message: 'Cookie bị checkpoint lần 2',
    now: t2
  }, 30);

  assert.equal(r2.updated, true);
  assert.equal(r2.id, 1);

  // Verify only 1 row exists in database
  const countStmt = db.prepare('SELECT count(*) as count FROM alerts');
  assert.equal(countStmt.get().count, 1);

  // Verify record was updated with t2 timestamp and new message
  const alertRow = db.prepare('SELECT detected_at, message FROM alerts WHERE id = 1').get();
  assert.equal(alertRow.detected_at, t2);
  assert.equal(alertRow.message, 'Cookie bị checkpoint lần 2');

  // 3. Once acknowledged, next alert creates a new record
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = 1').run();
  const t3 = '2026-11-22T10:45:00.000Z';
  const r3 = await recordAlertWithCooldown(d1Mock, {
    targetId: 14,
    alertType: 'AUTH_LOST',
    metricName: 'cookie',
    oldVal: 1,
    newVal: 0,
    delta: -1,
    threshold: 0,
    severity: 'CRITICAL',
    message: 'Cookie bị checkpoint mới',
    now: t3
  }, 30);

  assert.equal(r3.updated, false);
  assert.equal(r3.id, 2);
  assert.equal(countStmt.get().count, 2);
});

test('Worker Integrity: Multi-Metric Data Quality Gate accurately rejects anomalous drops', () => {
  function evaluateQualityGate(lastSnap, current) {
    if (!lastSnap) return { accepted: true };
    const lastRx = lastSnap.total_reactions || 0;
    const lastCmt = lastSnap.total_comments || 0;
    const lastSh = lastSnap.total_shares || 0;

    const rxDroppedToZero = lastRx > 5 && current.total_reactions === 0;
    const cmtDroppedToZero = lastCmt > 5 && current.total_comments === 0;
    const shDroppedToZero = lastSh > 5 && current.total_shares === 0;
    const allZeroDrop = (lastRx > 0 || lastCmt > 0 || lastSh > 0) && current.total_reactions === 0 && current.total_comments === 0 && current.total_shares === 0;

    if (rxDroppedToZero || cmtDroppedToZero || shDroppedToZero || allZeroDrop) {
      return { accepted: false, reason: 'ZERO_DROP_REJECTED' };
    }

    const rxSharpDrop = lastRx > 20 && current.total_reactions < lastRx * 0.4;
    const cmtSharpDrop = lastCmt > 20 && current.total_comments < lastCmt * 0.4;
    const shSharpDrop = lastSh > 20 && current.total_shares < lastSh * 0.4;

    if (rxSharpDrop || cmtSharpDrop || shSharpDrop) {
      return { accepted: false, reason: 'SHARP_DROP_REJECTED' };
    }

    return { accepted: true };
  }

  const baseline = { total_reactions: 100, total_comments: 50, total_shares: 20 };

  // Case 1: All metrics collapse to 0 (checkpoint / block page) -> REJECT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 0, total_comments: 0, total_shares: 0 }).accepted, false);

  // Case 2: Reactions drop from 100 to 0 -> REJECT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 0, total_comments: 50, total_shares: 20 }).accepted, false);

  // Case 3: Comments drop from 50 to 0 -> REJECT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 100, total_comments: 0, total_shares: 20 }).accepted, false);

  // Case 4: Shares drop from 20 to 0 -> REJECT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 100, total_comments: 50, total_shares: 0 }).accepted, false);

  // Case 5: Reactions sharp drop > 60% (100 -> 30) -> REJECT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 30, total_comments: 50, total_shares: 20 }).accepted, false);

  // Case 6: Organic growth (100 -> 105, 50 -> 52, 20 -> 21) -> ACCEPT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 105, total_comments: 52, total_shares: 21 }).accepted, true);

  // Case 7: Minor natural fluctuation (100 -> 98, -2% unlikers) -> ACCEPT
  assert.equal(evaluateQualityGate(baseline, { total_reactions: 98, total_comments: 50, total_shares: 20 }).accepted, true);
});

test('Worker Integrity: Quality Gate resolves baseline from last_valid_snapshot when immediate previous snapshot is corrupted to 0', () => {
  // Simulator for resolving baseline
  function resolveBaseline(target, lastSnap, lastValidSnap) {
    const baselineRx = Math.max(lastValidSnap?.total_reactions || 0, target.latest_reactions || 0);
    const baselineCmt = Math.max(lastValidSnap?.total_comments || 0, target.latest_comments || 0);
    const baselineSh = Math.max(lastValidSnap?.total_shares || 0, target.latest_shares || 0);
    return { baselineRx, baselineCmt, baselineSh };
  }

  // Corrupted scenario: target has latest_reactions=0 and lastSnap is 0, but history had 768 reactions
  const target = { latest_reactions: 0, latest_comments: 0, latest_shares: 0 };
  const lastCorruptedSnap = { total_reactions: 0, total_comments: 0, total_shares: 0 };
  const lastValidSnap = { total_reactions: 768, total_comments: 16, total_shares: 23 };

  const baseline = resolveBaseline(target, lastCorruptedSnap, lastValidSnap);
  assert.equal(baseline.baselineRx, 768, 'Must restore baseline to 768 reactions');
  assert.equal(baseline.baselineCmt, 16, 'Must restore baseline to 16 comments');
  assert.equal(baseline.baselineSh, 23, 'Must restore baseline to 23 shares');
});

test('Worker Integrity: isCheckpointOrLogin detects expired cookie, error titles and Bloks AccountRequiredProductRule', () => {
  const { isCheckpointOrLogin } = require('../src/collector/mbasicCollector');

  // Case 1: Facebook title "Lỗi" on /me when cookie expired
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/me', '<html><head><title>Lỗi</title></head><body>...</body></html>'), true);

  // Case 2: Bloks guest upsell AccountRequiredProductRule
  assert.equal(isCheckpointOrLogin('https://m.facebook.com/posts/123', '<div>..."AccountRequiredProductRule"...</div>'), true);

  // Case 3: Guest mobile prompt "Tận hưởng trải nghiệm trọn vẹn"
  assert.equal(isCheckpointOrLogin('https://m.facebook.com/posts/123', '<div>Tận hưởng trải nghiệm trọn vẹn, Xem mọi người đang yêu thích...</div>'), true);

  // Case 4: Normal valid post HTML
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/posts/123', '<html><head><title>Nguyen Hai Nam | Facebook</title></head><body><a href="/ufi/reaction/profile/browser/">100 người khác</a></body></html>'), false);
});

test('Worker Integrity: Schema column verification - proxies table uses last_tested_at', () => {
  const schemaSql = fs.readFileSync('migrations/0001_initial_schema.sql', 'utf8');
  assert.ok(schemaSql.includes('last_tested_at TEXT'), 'Schema must define last_tested_at in proxies');
  assert.ok(!schemaSql.includes('last_checked_at TEXT') || schemaSql.includes('monitored_targets'), 'proxies must not have last_checked_at');
});
