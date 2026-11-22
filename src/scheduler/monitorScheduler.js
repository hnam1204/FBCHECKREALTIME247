const { getDb } = require('../db/database');
const dataCollector = require('../collector/dataCollector');
const snapshotEngine = require('../engine/snapshotEngine');
const alertEngine = require('../analytics/alertEngine');
const config = require('../config');

class MonitorScheduler {
  constructor() {
    this.db = getDb();
    this.isRunning = false;
    this.timer = null;
    this.activeTaskCount = 0;
    this.listeners = new Set();
  }

  onUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event, payload) {
    for (const fn of this.listeners) {
      try {
        fn(event, payload);
      } catch (e) {
        console.error('Lỗi scheduler broadcast listener:', e);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[c4] MonitorScheduler đã khởi động chế độ 24/7');
    this.scheduleNextTick(1000);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[c4] MonitorScheduler đã tạm dừng');
  }

  scheduleNextTick(ms = 3000) {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.isRunning) return;

    try {
      const availableSlots = config.maxConcurrentChecks - this.activeTaskCount;
      if (availableSlots > 0) {
        const dueTargets = this.getDueTargets(availableSlots);
        for (const target of dueTargets) {
          this.executeTask(target);
        }
      }
    } catch (err) {
      console.error('[c4] Lỗi trong scheduler tick:', err);
    } finally {
      this.scheduleNextTick(4000); // Poll every 4 seconds for due targets
    }
  }

  /**
   * Query targets that are due for polling ordered by priority and last checked time
   */
  getDueTargets(limit) {
    const nowIso = new Date().toISOString();
    return this.db.prepare(`
      SELECT * FROM monitored_targets
      WHERE status = 'ACTIVE'
        AND (
          last_checked_at IS NULL
          OR (strftime('%s', ?) - strftime('%s', last_checked_at)) >= check_interval_sec
        )
      ORDER BY priority DESC, last_checked_at ASC
      LIMIT ?
    `).all(nowIso, limit);
  }

  /**
   * Run collection and processing for a single target
   */
  async executeTask(target) {
    this.activeTaskCount++;
    try {
      const collected = await dataCollector.collect(target);
      const processed = snapshotEngine.processNewSnapshot(target.id, collected);
      const alerts = alertEngine.evaluate(processed);

      this.broadcast('SNAPSHOT_PROCESSED', {
        targetId: target.id,
        processed,
        alerts
      });
    } catch (err) {
      this.handleTaskError(target, err);
    } finally {
      this.activeTaskCount--;
    }
  }

  /**
   * Handle task execution error with controlled retry backoff
   */
  handleTaskError(target, err) {
    const nextRetry = (target.retry_count || 0) + 1;
    const now = new Date().toISOString();
    const isExceeded = nextRetry >= config.retryMaxAttempts;

    const newStatus = isExceeded ? 'INACCESSIBLE' : 'ACTIVE';
    const errorMsg = err.message || 'Lỗi không xác định khi đồng bộ dữ liệu';

    this.db.prepare(`
      UPDATE monitored_targets
      SET retry_count = ?,
          last_error = ?,
          status = ?,
          last_checked_at = ?
      WHERE id = ?
    `).run(nextRetry, errorMsg, newStatus, now, target.id);

    if (isExceeded) {
      alertEngine.recordAuthOrAccessError(target.id, errorMsg);
    }

    this.broadcast('TASK_ERROR', {
      targetId: target.id,
      retryCount: nextRetry,
      error: errorMsg,
      status: newStatus
    });
  }

  /**
   * Force sync a specific target immediately
   */
  async triggerImmediateCheck(targetId) {
    const target = this.db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(targetId);
    if (!target) throw new Error('Không tìm thấy đối tượng giám sát');
    return this.executeTask(target);
  }
}

module.exports = new MonitorScheduler();
