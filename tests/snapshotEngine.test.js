process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/db/database');
const snapshotEngine = require('../src/engine/snapshotEngine');

test('SnapshotEngine: Initial snapshot establishes baseline', () => {
  const db = getDb();
  const testUrl = `https://fb.com/test_post_${Date.now()}_${Math.random()}`;
  // Create dummy target
  const info = db.prepare(`
    INSERT INTO monitored_targets (
      original_url, normalized_url, target_type, content_id,
      author_name, status, check_interval_sec, priority, created_at
    ) VALUES (
      ?, ?, 'post', 'test_post_1',
      'Test Author', 'ACTIVE', 60, 1, ?
    )
  `).run(testUrl, testUrl, new Date().toISOString());

  const targetId = Number(info.lastInsertRowid);

  const collected = {
    authorName: 'Test Fanpage',
    reactions: { total: 100, like: 70, love: 20, care: 5, haha: 3, wow: 1, sad: 1, angry: 0 },
    comments: { total: 15, identifiableItems: [] },
    shares: { total: 8 },
    sourceType: 'SIMULATION',
    observedAt: new Date().toISOString()
  };

  const processed = snapshotEngine.processNewSnapshot(targetId, collected);

  assert.equal(processed.isFirstRun, true);
  assert.equal(processed.totalReactions, 100);
  assert.equal(processed.deltas.reactions, 0); // baseline has 0 delta

  const target = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(targetId);
  assert.equal(target.baseline_reactions, 100);
  assert.equal(target.latest_reactions, 100);

  // Subsequent snapshot computes positive deltas
  const collected2 = {
    authorName: 'Test Fanpage',
    reactions: { total: 135, like: 90, love: 30, care: 5, haha: 5, wow: 2, sad: 2, angry: 1 },
    comments: { total: 22, identifiableItems: [] },
    shares: { total: 10 },
    sourceType: 'SIMULATION',
    observedAt: new Date(Date.now() + 60000).toISOString()
  };

  const processed2 = snapshotEngine.processNewSnapshot(targetId, collected2);
  assert.equal(processed2.isFirstRun, false);
  assert.equal(processed2.deltas.reactions, 35);
  assert.equal(processed2.deltas.comments, 7);
  assert.equal(processed2.deltas.shares, 2);
});
