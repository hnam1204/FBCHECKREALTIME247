const { getDb } = require('../src/db/database');
const dataCollector = require('../src/collector/dataCollector');
const snapshotEngine = require('../src/engine/snapshotEngine');
const db = getDb();

async function main() {
  console.log('[c4] Đang dọn sạch targets và alerts phát sinh từ unit test...');

  // 1. Remove mock targets and mock alerts
  db.exec(`
    DELETE FROM monitored_targets WHERE content_id IN ('test_post_1', 'test_spike') OR author_name IN ('Test Fanpage', 'Spike Page');
    DELETE FROM alerts;
    UPDATE monitored_targets SET status = 'ACTIVE', retry_count = 0, last_error = NULL WHERE author_name = 'Hainam';
  `);

  console.log('[c4] Đã làm sạch toàn bộ alerts cũ.');

  // 2. Perform live sync for Hainam target
  const target = db.prepare("SELECT * FROM monitored_targets WHERE author_name = 'Hainam'").get();
  if (target) {
    console.log(`[c4] Đang đồng bộ dữ liệu thật cho target #${target.id} (${target.author_name})...`);
    const collected = await dataCollector.collect(target);
    const processed = snapshotEngine.processNewSnapshot(target.id, collected);
    console.log('[c4] Đồng bộ thành công! Snapshot:', {
      targetId: processed.targetId,
      totalReactions: processed.totalReactions,
      totalComments: processed.totalComments,
      totalShares: processed.totalShares,
      observedAt: processed.observedAt
    });
  }

  const remainingTargets = db.prepare('SELECT id, author_name, content_id, status, last_error FROM monitored_targets').all();
  console.log('[c4] Danh sách bài viết thật hiện tại:', remainingTargets);
  const remainingAlerts = db.prepare('SELECT count(*) as count FROM alerts').get();
  console.log('[c4] Tổng số cảnh báo hiện tại:', remainingAlerts.count);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(err => {
    console.error('[c4 Lỗi]:', err);
    process.exitCode = 1;
  });
