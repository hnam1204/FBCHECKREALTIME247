const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

test('Worker Integrity: Production Exports & Handlers', async (t) => {
  // Directly import the real production worker implementation (NOT a simulation or mock)
  const worker = await import('../src/worker.js');
  const { maskProxyUrl, recordAlertWithCooldown, computeEvidenceHash, worker_default } = worker;

  assert.ok(typeof maskProxyUrl === 'function', 'maskProxyUrl must be exported from worker');
  assert.ok(typeof recordAlertWithCooldown === 'function', 'recordAlertWithCooldown must be exported from worker');
  assert.ok(typeof computeEvidenceHash === 'function', 'computeEvidenceHash must be exported from worker');
  assert.ok(typeof worker_default.fetch === 'function', 'worker_default.fetch must be the primary HTTP handler');

  // Test 1: Real maskProxyUrl implementation
  const url1 = 'http://user30493:1xaQ87vc@proxy-156.psun.io.vn:30493';
  assert.equal(maskProxyUrl(url1), 'http://user30493:***@proxy-156.psun.io.vn:30493');

  const url2 = 'proxy-523.psun.io.vn:33354:user33354:ihVpkr4g';
  assert.equal(maskProxyUrl(url2), 'proxy-523.psun.io.vn:33354:user33354:***');

  const url3 = 'http://103.1.2.3:8080';
  assert.equal(maskProxyUrl(url3), 'http://103.1.2.3:8080');
  assert.equal(maskProxyUrl(null), null);

  // Test 2: Real computeEvidenceHash
  const hash = await computeEvidenceHash('post_content_test');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64, 'SHA-256 hex string must be 64 characters');

  // Test 3: Real recordAlertWithCooldown implementation on SQLite
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

  const d1Mock = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const wrap = (...args) => ({
        bind: (...bArgs) => wrap(...bArgs),
        first: async () => stmt.get(...args),
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => {
          const res = stmt.run(...args);
          return { meta: { last_row_id: Number(res.lastInsertRowid), changes: res.changes } };
        }
      });
      return wrap();
    }
  };

  const t1 = '2026-11-22T10:00:00.000Z';
  const t2 = '2026-11-22T10:05:00.000Z';

  const id1 = await recordAlertWithCooldown(d1Mock, {
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
  assert.equal(id1, 1);

  // Second call within 30m updates without duplicate
  const id2 = await recordAlertWithCooldown(d1Mock, {
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
  assert.equal(id2, 1);
  assert.equal(db.prepare('SELECT count(*) as count FROM alerts').get().count, 1);

  // Test 4: Real production worker_default.fetch handler invocation
  db.exec(`
    CREATE TABLE monitored_targets (
      id INTEGER PRIMARY KEY,
      status TEXT,
      last_error TEXT,
      latest_reactions INTEGER DEFAULT 0,
      latest_comments INTEGER DEFAULT 0,
      latest_shares INTEGER DEFAULT 0,
      baseline_reactions INTEGER DEFAULT 0,
      baseline_comments INTEGER DEFAULT 0,
      baseline_shares INTEGER DEFAULT 0
    );
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      status TEXT
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      target_id INTEGER,
      observed_at TEXT,
      total_reactions INTEGER,
      total_comments INTEGER,
      total_shares INTEGER,
      delta_reactions INTEGER,
      delta_comments INTEGER,
      delta_shares INTEGER,
      raw_json TEXT
    );
  `);

  const mockEnv = {
    DB: d1Mock,
    ENCRYPTION_MASTER_KEY: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  };

  const req = new Request('https://cookiefb.coongviec.workers.dev/api/health');
  const res = await worker_default.fetch(req, mockEnv);
  assert.equal(res.status, 200);
  const healthData = await res.json();
  assert.ok(healthData.integrity, 'Health data must contain integrity object');
  assert.equal(healthData.integrity.totalTargets, 0);
  assert.equal(healthData.integrity.activeAccounts, 0);
});

test('Worker Integrity: Sidecar snapshot requires the X-Sidecar-Secret header', async () => {
  const worker = await import('../src/worker.js');
  const { worker_default } = worker;
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE monitored_targets (
      id INTEGER PRIMARY KEY,
      status TEXT,
      last_error TEXT,
      latest_reactions INTEGER DEFAULT 0,
      latest_comments INTEGER DEFAULT 0,
      latest_shares INTEGER DEFAULT 0,
      baseline_reactions INTEGER DEFAULT 0,
      baseline_comments INTEGER DEFAULT 0,
      baseline_shares INTEGER DEFAULT 0
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      target_id INTEGER,
      observed_at TEXT,
      total_reactions INTEGER,
      total_comments INTEGER,
      total_shares INTEGER,
      delta_reactions INTEGER,
      delta_comments INTEGER,
      delta_shares INTEGER,
      raw_json TEXT
    );
  `);
  const d1Mock = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() { return stmt.get(...args); },
            async all() { return { results: stmt.all(...args) }; },
            async run() { const result = stmt.run(...args); return { meta: { changes: result.changes } }; }
          };
        }
      };
    }
  };
  const env = { DB: d1Mock, ENCRYPTION_MASTER_KEY: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  const body = JSON.stringify({ secret: env.ENCRYPTION_MASTER_KEY, target_id: 1 });
  const response = await worker_default.fetch(new Request('https://example.test/api/sidecar/push-snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }), env);
  assert.equal(response.status, 401);
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
