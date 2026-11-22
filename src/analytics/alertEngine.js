const { getDb } = require('../db/database');

class AlertEngine {
  constructor() {
    this.db = getDb();
    this.broadcastListeners = new Set();
  }

  onBroadcast(listener) {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  emitAlert(alert) {
    for (const listener of this.broadcastListeners) {
      try {
        listener(alert);
      } catch (err) {
        console.error('Lỗi dispatch alert listener:', err);
      }
    }
  }

  /**
   * Evaluate a newly processed snapshot against alert rules
   */
  evaluate(processedData) {
    if (processedData.isFirstRun) return []; // Skip baseline run

    const targetId = processedData.targetId;
    const config = this.getAlertConfig(targetId);
    const deltas = processedData.deltas;
    const detectedAt = processedData.observedAt || new Date().toISOString();
    const generatedAlerts = [];

    // 1. Reaction Spike
    if (deltas.reactions >= config.reaction_spike_threshold) {
      const alert = this.recordAlert({
        targetId,
        alertType: 'REACTION_SPIKE',
        metricName: 'reactions',
        oldVal: processedData.totalReactions - deltas.reactions,
        newVal: processedData.totalReactions,
        delta: deltas.reactions,
        threshold: config.reaction_spike_threshold,
        severity: deltas.reactions >= config.reaction_spike_threshold * 2 ? 'CRITICAL' : 'WARNING',
        message: `Lượt cảm xúc tăng vọt (+${deltas.reactions}) trong lần đồng bộ vừa qua.`,
        detectedAt
      });
      generatedAlerts.push(alert);
    }

    // 2. Comment Surge
    if (deltas.comments >= config.comment_surge_threshold) {
      const alert = this.recordAlert({
        targetId,
        alertType: 'COMMENT_SURGE',
        metricName: 'comments',
        oldVal: processedData.totalComments - deltas.comments,
        newVal: processedData.totalComments,
        delta: deltas.comments,
        threshold: config.comment_surge_threshold,
        severity: 'WARNING',
        message: `Lượng bình luận tăng đột biến (+${deltas.comments}) trên bài viết.`,
        detectedAt
      });
      generatedAlerts.push(alert);
    }

    // 3. Share Burst
    if (deltas.shares >= config.share_burst_threshold) {
      const alert = this.recordAlert({
        targetId,
        alertType: 'SHARE_BURST',
        metricName: 'shares',
        oldVal: processedData.totalShares - deltas.shares,
        newVal: processedData.totalShares,
        delta: deltas.shares,
        threshold: config.share_burst_threshold,
        severity: 'CRITICAL',
        message: `Lượt chia sẻ tăng nhanh bất thường (+${deltas.shares}).`,
        detectedAt
      });
      generatedAlerts.push(alert);
    }

    // 4. Viral Shift (from dormant to high growth)
    if (processedData.growthRates.rate5m >= 50 && deltas.reactions >= 15) {
      const alert = this.recordAlert({
        targetId,
        alertType: 'VIRAL_SHIFT',
        metricName: 'growth_rate_5m',
        oldVal: 0,
        newVal: processedData.growthRates.rate5m,
        delta: processedData.growthRates.rate5m,
        threshold: 50,
        severity: 'CRITICAL',
        message: `Bài viết chuyển trạng thái bùng nổ: Tốc độ tăng trưởng 5 phút đạt +${processedData.growthRates.rate5m}%.`,
        detectedAt
      });
      generatedAlerts.push(alert);
    }

    return generatedAlerts;
  }

  /**
   * Log an alert when a target is inaccessible or loses permissions
   */
  recordAuthOrAccessError(targetId, errorMessage) {
    return this.recordAlert({
      targetId,
      alertType: 'AUTH_LOST',
      metricName: 'status',
      oldVal: 1,
      newVal: 0,
      delta: 0,
      threshold: 0,
      severity: 'CRITICAL',
      message: `Mất quyền truy xuất hoặc ngắt kết nối: ${errorMessage}`,
      detectedAt: new Date().toISOString()
    });
  }

  recordAlert({ targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, detectedAt }) {
    const info = this.db.prepare(`
      INSERT INTO alerts (
        target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at, acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, detectedAt);

    const alertObject = {
      id: Number(info.lastInsertRowid),
      targetId,
      alertType,
      metricName,
      oldVal,
      newVal,
      delta,
      threshold,
      severity,
      message,
      detectedAt,
      acknowledged: 0
    };

    this.emitAlert(alertObject);
    return alertObject;
  }

  getAlertConfig(targetId) {
    const row = this.db.prepare('SELECT * FROM target_alert_configs WHERE target_id = ?').get(targetId);
    if (row) return row;

    return {
      reaction_spike_threshold: 50,
      comment_surge_threshold: 20,
      share_burst_threshold: 10,
      stall_timeout_min: 30
    };
  }

  setAlertConfig(targetId, config) {
    this.db.prepare(`
      INSERT INTO target_alert_configs (target_id, reaction_spike_threshold, comment_surge_threshold, share_burst_threshold, stall_timeout_min)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        reaction_spike_threshold = excluded.reaction_spike_threshold,
        comment_surge_threshold = excluded.comment_surge_threshold,
        share_burst_threshold = excluded.share_burst_threshold,
        stall_timeout_min = excluded.stall_timeout_min
    `).run(
      targetId,
      config.reaction_spike_threshold || 50,
      config.comment_surge_threshold || 20,
      config.share_burst_threshold || 10,
      config.stall_timeout_min || 30
    );
  }
}

module.exports = new AlertEngine();
