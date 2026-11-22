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
   * Evaluate a newly processed snapshot against alert rules & dynamic configs
   */
  evaluate(processedData) {
    if (processedData.isFirstRun) return []; // Skip baseline run

    const targetId = processedData.targetId;
    const config = this.getAlertConfig(targetId);
    const deltas = processedData.deltas;
    const detectedAt = processedData.observedAt || new Date().toISOString();
    const generatedAlerts = [];

    // 1. Group 1: REACTION_SPIKE
    if (deltas.reactions >= config.reaction_spike_threshold) {
      const severity = deltas.reactions >= config.reaction_spike_threshold * 2 ? 'CRITICAL' : 'WARNING';
      const alert = this.recordAlert({
        targetId,
        alertType: 'REACTION_SPIKE',
        metricName: 'reactions',
        oldVal: processedData.totalReactions - deltas.reactions,
        newVal: processedData.totalReactions,
        delta: deltas.reactions,
        threshold: config.reaction_spike_threshold,
        severity,
        message: `Lượt cảm xúc tăng vọt (+${deltas.reactions.toLocaleString()}) trong lần đồng bộ vừa qua.`,
        detectedAt,
        payload: {
          metric: 'reactions',
          before: processedData.totalReactions - deltas.reactions,
          after: processedData.totalReactions,
          timeWindow: '5M',
          explanation: `Lượt cảm xúc tăng vượt ngưỡng ${config.reaction_spike_threshold} được thiết lập.`
        }
      });
      generatedAlerts.push(alert);
    }

    // 2. Group 1: COMMENT_SURGE
    if (deltas.comments >= config.comment_surge_threshold) {
      const severity = deltas.comments >= config.comment_surge_threshold * 2 ? 'HIGH' : 'WARNING';
      const alert = this.recordAlert({
        targetId,
        alertType: 'COMMENT_SURGE',
        metricName: 'comments',
        oldVal: processedData.totalComments - deltas.comments,
        newVal: processedData.totalComments,
        delta: deltas.comments,
        threshold: config.comment_surge_threshold,
        severity,
        message: `Lượng bình luận tăng đột biến (+${deltas.comments.toLocaleString()}) trên bài viết.`,
        detectedAt,
        payload: {
          metric: 'comments',
          before: processedData.totalComments - deltas.comments,
          after: processedData.totalComments,
          timeWindow: '5M',
          explanation: `Số lượng bình luận mới tăng vượt ngưỡng quy định ${config.comment_surge_threshold}.`
        }
      });
      generatedAlerts.push(alert);
    }

    // 3. Group 1: SHARE_BURST
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
        message: `Lượt chia sẻ lan truyền nhanh bất thường (+${deltas.shares.toLocaleString()}).`,
        detectedAt,
        payload: {
          metric: 'shares',
          before: processedData.totalShares - deltas.shares,
          after: processedData.totalShares,
          timeWindow: '5M',
          explanation: `Lượt chia sẻ tăng vượt ngưỡng lan truyền ${config.share_burst_threshold}.`
        }
      });
      generatedAlerts.push(alert);
    }

    // 4. Group 1: VIRAL_SHIFT (Tăng trưởng bùng nổ)
    if (processedData.growthRates && processedData.growthRates.rate5m >= 50 && deltas.reactions >= 15) {
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
        detectedAt,
        payload: {
          metric: 'growth_rate_5m',
          rate: processedData.growthRates.rate5m,
          deltaReactions: deltas.reactions,
          timeWindow: '5M',
          explanation: 'Tốc độ tăng trưởng vượt ngưỡng viral 50% trong khung giờ 5 phút.'
        }
      });
      generatedAlerts.push(alert);
    }

    // 5. Group 1: ENGAGEMENT_DROP (Tương tác sụt giảm do gỡ like/xóa comment)
    if (deltas.reactions <= -10 || deltas.comments <= -10) {
      const dropMetric = deltas.reactions <= -10 ? 'reactions' : 'comments';
      const dropDelta = deltas.reactions <= -10 ? deltas.reactions : deltas.comments;
      const alert = this.recordAlert({
        targetId,
        alertType: 'ENGAGEMENT_DROP',
        metricName: dropMetric,
        oldVal: (dropMetric === 'reactions' ? processedData.totalReactions : processedData.totalComments) - dropDelta,
        newVal: dropMetric === 'reactions' ? processedData.totalReactions : processedData.totalComments,
        delta: dropDelta,
        threshold: 10,
        severity: 'INFO',
        message: `Ghi nhận tương tác giảm (${dropDelta}) do người dùng gỡ cảm xúc hoặc xóa bình luận.`,
        detectedAt,
        payload: {
          metric: dropMetric,
          delta: dropDelta,
          timeWindow: '5M',
          explanation: 'Biến động âm thực tế được snapshot ghi nhận trung thực theo Meta API.'
        }
      });
      generatedAlerts.push(alert);
    }

    // 6. Group 2: SUSPICIOUS_GROWTH (Tăng trưởng bất thường)
    if (processedData.growthRates && processedData.growthRates.rate5m >= 200 && deltas.reactions >= 50) {
      const alert = this.recordAlert({
        targetId,
        alertType: 'SUSPICIOUS_GROWTH',
        metricName: 'growth_anomaly',
        oldVal: processedData.totalReactions - deltas.reactions,
        newVal: processedData.totalReactions,
        delta: deltas.reactions,
        threshold: 50,
        severity: 'HIGH',
        message: `Phát hiện tăng trưởng đột biến bất thường (+${deltas.reactions.toLocaleString()} tương tác trong 5 phút).`,
        detectedAt,
        payload: {
          metric: 'suspicious_growth',
          growthRate: processedData.growthRates.rate5m,
          delta: deltas.reactions,
          timeWindow: '5M',
          explanation: 'Tốc độ gia tăng vượt quá 200% so với mốc quan sát thông thường.'
        }
      });
      generatedAlerts.push(alert);
    }

    // 7. Custom Rules from alert_rules table
    try {
      const customRules = this.db.prepare(`
        SELECT * FROM alert_rules 
        WHERE (target_id = ? OR target_id IS NULL) AND is_active = 1
      `).all(targetId);

      for (const rule of customRules) {
        let currentDelta = 0;
        let currentTotal = 0;
        if (rule.metric === 'reactions') {
          currentDelta = deltas.reactions;
          currentTotal = processedData.totalReactions;
        } else if (rule.metric === 'comments') {
          currentDelta = deltas.comments;
          currentTotal = processedData.totalComments;
        } else if (rule.metric === 'shares') {
          currentDelta = deltas.shares;
          currentTotal = processedData.totalShares;
        }

        let triggered = false;
        if (rule.condition === 'gt_count' && currentDelta >= rule.threshold) {
          triggered = true;
        } else if (rule.condition === 'gt_total' && currentTotal >= rule.threshold) {
          triggered = true;
        }

        if (triggered) {
          const alert = this.recordAlert({
            targetId,
            alertType: 'CUSTOM_RULE_TRIGGERED',
            metricName: rule.metric,
            oldVal: currentTotal - currentDelta,
            newVal: currentTotal,
            delta: currentDelta,
            threshold: rule.threshold,
            severity: rule.severity || 'WARNING',
            message: `Quy tắc tùy chỉnh [${rule.name}]: ${rule.metric} vượt ngưỡng ${rule.threshold} (+${currentDelta}).`,
            detectedAt,
            ruleId: rule.id,
            cooldownSec: rule.cooldown_sec || 300,
            payload: {
              ruleId: rule.id,
              ruleName: rule.name,
              metric: rule.metric,
              threshold: rule.threshold,
              timeWindow: rule.time_window,
              channels: rule.channels
            }
          });
          generatedAlerts.push(alert);
        }
      }
    } catch (e) {
      // Custom rules evaluation safe catch
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
      detectedAt: new Date().toISOString(),
      payload: {
        error: errorMessage,
        timeWindow: '1M',
        explanation: 'Phiên kết nối hoặc cookie tài khoản bị checkpoint hoặc thiếu quyền truy cập Meta.'
      }
    });
  }

  /**
   * Log state transition (e.g. paused, resumed)
   */
  recordMonitorStateChange(targetId, eventType, message, severity = 'INFO') {
    return this.recordAlert({
      targetId,
      alertType: eventType,
      metricName: 'status',
      oldVal: 0,
      newVal: 1,
      delta: 0,
      threshold: 0,
      severity,
      message,
      detectedAt: new Date().toISOString(),
      payload: { eventType, explanation: message }
    });
  }

  /**
   * Main Record & Deduplicate Engine
   */
  recordAlert({ targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, detectedAt, payload, ruleId, cooldownSec = 300, evidenceStatus, sourceType, detectionVersion }) {
    const safeOldVal = oldVal !== undefined ? oldVal : (payload?.oldVal ?? 0);
    const safeNewVal = newVal !== undefined ? newVal : (payload?.newVal ?? 0);
    const safeDelta = delta !== undefined ? delta : (payload?.delta ?? 0);
    const safeThreshold = threshold !== undefined ? threshold : (payload?.threshold ?? 0);
    const safeMetricName = metricName || 'system';
    const safeDetectedAt = detectedAt || new Date().toISOString();
    const dedupKey = `target_${targetId}_${alertType}_${safeMetricName}`;
    const nowMs = new Date(safeDetectedAt).getTime();

    // Deduplication check: Is there an existing OPEN alert with this dedup_key within cooldownSec?
    try {
      const existing = this.db.prepare(`
        SELECT * FROM alerts 
        WHERE dedup_key = ? AND status = 'OPEN' 
        ORDER BY id DESC LIMIT 1
      `).get(dedupKey);

      if (existing) {
        const lastDetectedMs = new Date(existing.detected_at).getTime();
        const diffSec = (nowMs - lastDetectedMs) / 1000;
        if (diffSec < cooldownSec) {
          // Aggregate / update existing open alert instead of creating spam duplicate
          let existingPayload = {};
          try { existingPayload = JSON.parse(existing.payload || '{}'); } catch {}
          const occurrences = (existingPayload.occurrences || 1) + 1;
          const updatedPayload = JSON.stringify({
            ...existingPayload,
            ...(payload || {}),
            occurrences,
            last_delta: safeDelta,
            max_delta: Math.max(existing.delta || 0, safeDelta),
            peak_val: Math.max(existing.new_val || 0, safeNewVal),
            updated_at: safeDetectedAt
          });

          // Escalate severity if incoming severity is higher
          const severityRanks = { INFO: 1, WARNING: 2, HIGH: 3, CRITICAL: 4 };
          const curRank = severityRanks[existing.severity] || 1;
          const newRank = severityRanks[severity] || 1;
          const finalSeverity = newRank > curRank ? severity : existing.severity;

          this.db.prepare(`
            UPDATE alerts 
            SET new_val = ?, delta = ?, severity = ?, detected_at = ?, payload = ?, is_read = 0
            WHERE id = ?
          `).run(safeNewVal, safeDelta, finalSeverity, safeDetectedAt, updatedPayload, existing.id);

          const updatedAlert = {
            id: existing.id,
            targetId,
            alertType,
            metricName: safeMetricName,
            oldVal: existing.old_val,
            newVal: safeNewVal,
            delta: safeDelta,
            threshold: safeThreshold,
            severity: finalSeverity,
            message,
            detectedAt: safeDetectedAt,
            acknowledged: existing.acknowledged,
            is_read: 0,
            status: 'OPEN',
            dedup_key: dedupKey,
            payload: updatedPayload,
            rule_id: existing.rule_id
          };
          this.emitAlert(updatedAlert);
          return updatedAlert;
        }
      }
    } catch (e) {
      // Fallback to insertion if dedup check fails
    }

    // Otherwise insert new alert record
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || { occurrences: 1 });
    const info = this.db.prepare(`
      INSERT INTO alerts (
        target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at, acknowledged, is_read, status, dedup_key, payload, rule_id, evidence_status, source_type, detection_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'OPEN', ?, ?, ?, ?, ?, ?)
    `).run(
      targetId,
      alertType,
      safeMetricName,
      safeOldVal,
      safeNewVal,
      safeDelta,
      safeThreshold,
      severity,
      message,
      safeDetectedAt,
      dedupKey,
      payloadStr,
      ruleId || null,
      evidenceStatus || 'VERIFIED',
      sourceType || 'mbasic/comet',
      detectionVersion || 'NHN Detection Engine v2.1'
    );

    const insertedId = Number(info.lastInsertRowid);
    try {
      this.db.prepare(`
        INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
        VALUES (?, 'TRIGGERED', 'System / AlertEngine', NULL, 'OPEN', ?, ?)
      `).run(insertedId, message, safeDetectedAt);
    } catch {}

    const alertObject = {
      id: insertedId,
      targetId,
      alertType,
      metricName: safeMetricName,
      oldVal: safeOldVal,
      newVal: safeNewVal,
      delta: safeDelta,
      threshold: safeThreshold,
      severity,
      message,
      detectedAt,
      acknowledged: 0,
      is_read: 0,
      status: 'OPEN',
      dedup_key: dedupKey,
      payload: payloadStr,
      rule_id: ruleId || null
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
