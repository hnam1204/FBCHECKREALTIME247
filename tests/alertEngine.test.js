process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/db/database');
const alertEngine = require('../src/analytics/alertEngine');

test('AlertEngine: Triggers REACTION_SPIKE when delta exceeds threshold', () => {
  const db = getDb();
  const testUrl = `https://fb.com/test_spike_${Date.now()}_${Math.random()}`;
  const info = db.prepare(`
    INSERT INTO monitored_targets (
      original_url, normalized_url, target_type, content_id,
      author_name, status, check_interval_sec, priority, created_at
    ) VALUES (
      ?, ?, 'post', 'test_spike',
      'Spike Page', 'ACTIVE', 60, 1, ?
    )
  `).run(testUrl, testUrl, new Date().toISOString());

  const targetId = Number(info.lastInsertRowid);
  alertEngine.setAlertConfig(targetId, {
    reaction_spike_threshold: 40,
    comment_surge_threshold: 15,
    share_burst_threshold: 10
  });

  const processedData = {
    targetId,
    isFirstRun: false,
    totalReactions: 250,
    totalComments: 30,
    totalShares: 15,
    deltas: {
      reactions: 60, // Exceeds threshold of 40
      comments: 5,
      shares: 2
    },
    growthRates: {
      rate5m: 30,
      rate1h: 40,
      rate24h: 50
    },
    observedAt: new Date().toISOString()
  };

  const alerts = alertEngine.evaluate(processedData);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, 'REACTION_SPIKE');
  assert.equal(alerts[0].delta, 60);

  // Check alert stored in database
  const inDb = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alerts[0].id);
  assert.ok(inDb);
  assert.equal(inDb.metric_name, 'reactions');
  assert.equal(inDb.status, 'OPEN');
  assert.equal(inDb.is_read, 0);

  // Deduplication & Cooldown check: second immediate spike within cooldown updates existing alert without creating a second DB row
  const immediateSpike = {
    ...processedData,
    deltas: { reactions: 80, comments: 0, shares: 0 }
  };
  const secondEval = alertEngine.evaluate(immediateSpike);
  assert.equal(secondEval.length, 1, 'Should return updated alert');
  assert.equal(secondEval[0].id, alerts[0].id, 'Should keep the same alert ID via dedup aggregation');

  const count = db.prepare('SELECT count(*) as count FROM alerts WHERE target_id = ?').get(targetId).count;
  assert.equal(count, 1, 'Should not create duplicate alert row in database');
});

test('AlertEngine: Custom alert rule triggers properly', () => {
  const db = getDb();
  const testUrl = `https://fb.com/test_rule_${Date.now()}_${Math.random()}`;
  const info = db.prepare(`
    INSERT INTO monitored_targets (
      original_url, normalized_url, target_type, content_id,
      author_name, status, check_interval_sec, priority, created_at
    ) VALUES (
      ?, ?, 'post', 'test_rule',
      'Rule Page', 'ACTIVE', 60, 1, ?
    )
  `).run(testUrl, testUrl, new Date().toISOString());

  const targetId = Number(info.lastInsertRowid);

  // Insert a custom rule
  db.prepare(`
    INSERT INTO alert_rules (
      name, target_id, metric, condition, threshold, time_window, severity, cooldown_sec, is_active, created_at
    ) VALUES (
      'Bùng nổ bình luận test', ?, 'comments', 'gt_count', 25, '5M', 'CRITICAL', 300, 1, ?
    )
  `).run(targetId, new Date().toISOString());

  const processedData = {
    targetId,
    isFirstRun: false,
    totalReactions: 100,
    totalComments: 50,
    totalShares: 10,
    deltas: {
      reactions: 5,
      comments: 30, // Exceeds rule threshold of 25
      shares: 0
    },
    growthRates: { rate5m: 10, rate1h: 15, rate24h: 20 },
    observedAt: new Date().toISOString()
  };

  const triggered = alertEngine.evaluate(processedData);
  const customAlert = triggered.find(a => a.alertType === 'CUSTOM_RULE_TRIGGERED');
  assert.ok(customAlert, 'Should trigger CUSTOM_RULE_TRIGGERED from custom rule');
  assert.equal(customAlert.severity, 'CRITICAL');
});
