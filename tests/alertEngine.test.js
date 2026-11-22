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
});
