const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { getDb } = require('../db/database');
const { parseBatchUrls, normalizeUrl, analyzeUrl } = require('../analyzer/urlAnalyzer');
const accountManager = require('../auth/accountManager');
const alertEngine = require('../analytics/alertEngine');
const monitorScheduler = require('../scheduler/monitorScheduler');
const config = require('../config');

function createServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const db = getDb();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../../public')));

  // --- WebSocket Live Broadcast ---
  const broadcast = (type, data) => {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  };

  monitorScheduler.onUpdate((event, payload) => broadcast(event, payload));
  alertEngine.onBroadcast((alert) => broadcast('NEW_ALERT', alert));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Kết nối WebSocket giám sát thành công 24/7' }));
  });

  // --- API Endpoints ---

  // 1. Overview Dashboard Summary (Section 7)
  app.get('/api/overview', (req, res) => {
    const rangeParam = req.query.range || '24H';
    const rangeMap = {
      '5M': 5 * 60 * 1000,
      '15M': 15 * 60 * 1000,
      '30M': 30 * 60 * 1000,
      '1H': 60 * 60 * 1000,
      '3H': 3 * 60 * 60 * 1000,
      '6H': 6 * 60 * 60 * 1000,
      '12H': 12 * 60 * 60 * 1000,
      '24H': 24 * 60 * 60 * 1000,
      '7D': 7 * 24 * 60 * 60 * 1000,
      '30D': 30 * 24 * 60 * 60 * 1000,
    };
    const rangeMs = rangeMap[rangeParam] || (24 * 60 * 60 * 1000);
    const nowMs = Date.now();
    const cutoffTime = new Date(nowMs - rangeMs).toISOString();
    const priorCutoffTime = new Date(nowMs - 2 * rangeMs).toISOString();

    const totalTargets = db.prepare('SELECT COUNT(*) as count FROM monitored_targets').get()?.count || 0;
    const activeTasks = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").get()?.count || 0;
    const errorTasks = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('INACCESSIBLE', 'NEEDS_AUTH')").get()?.count || 0;

    const totals = db.prepare(`
      SELECT 
        SUM(latest_reactions) as total_reactions,
        SUM(latest_comments) as total_comments,
        SUM(latest_shares) as total_shares
      FROM monitored_targets
    `).get() || {};

    // Breakdown of 7 reactions across latest snapshots
    const reactionBreakdown = db.prepare(`
      SELECT 
        SUM(s.like_count) as like_count,
        SUM(s.love_count) as love_count,
        SUM(s.care_count) as care_count,
        SUM(s.haha_count) as haha_count,
        SUM(s.wow_count) as wow_count,
        SUM(s.sad_count) as sad_count,
        SUM(s.angry_count) as angry_count
      FROM snapshots s
      INNER JOIN (
        SELECT target_id, MAX(id) as max_id
        FROM snapshots
        GROUP BY target_id
      ) latest ON s.target_id = latest.target_id AND s.id = latest.max_id
    `).get() || { like_count: 0, love_count: 0, care_count: 0, haha_count: 0, wow_count: 0, sad_count: 0, angry_count: 0 };

    // Delta in the selected period vs prior period
    const periodDelta = db.prepare(`
      SELECT 
        SUM(delta_reactions) as delta_reactions,
        SUM(delta_comments) as delta_comments,
        SUM(delta_shares) as delta_shares
      FROM snapshots
      WHERE observed_at >= ?
    `).get(cutoffTime) || {};

    const prevPeriodDelta = db.prepare(`
      SELECT 
        SUM(delta_reactions) as delta_reactions,
        SUM(delta_comments) as delta_comments,
        SUM(delta_shares) as delta_shares
      FROM snapshots
      WHERE observed_at >= ? AND observed_at < ?
    `).get(priorCutoffTime, cutoffTime) || {};

    const totalAlertsInPeriod = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE detected_at >= ?').get(cutoffTime)?.count || 0;
    const unresolvedAlerts = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').get()?.count || 0;
    const lastSyncAt = db.prepare('SELECT MAX(observed_at) as last_sync FROM snapshots').get()?.last_sync || null;

    // Time-series points for the chart in the selected range
    const rawSnapshots = db.prepare(`
      SELECT observed_at, 
             SUM(total_reactions) as total_reactions,
             SUM(total_comments) as total_comments,
             SUM(total_shares) as total_shares,
             SUM(delta_reactions) as delta_reactions,
             SUM(delta_comments) as delta_comments,
             SUM(delta_shares) as delta_shares
      FROM snapshots
      WHERE observed_at >= ?
      GROUP BY observed_at
      ORDER BY observed_at ASC
    `).all(cutoffTime) || [];

    let timeSeries = [];
    if (rawSnapshots.length <= 30) {
      timeSeries = rawSnapshots;
    } else {
      const step = rawSnapshots.length / 25;
      for (let i = 0; i < 25; i++) {
        const idx = Math.min(Math.floor(i * step), rawSnapshots.length - 1);
        timeSeries.push(rawSnapshots[idx]);
      }
      if (rawSnapshots.length > 0 && timeSeries[timeSeries.length - 1] !== rawSnapshots[rawSnapshots.length - 1]) {
        timeSeries.push(rawSnapshots[rawSnapshots.length - 1]);
      }
    }

    // Top 5 noteworthy items
    const topFastest = db.prepare(`
      SELECT t.id, t.author_name, t.content_snippet, t.target_type, t.normalized_url,
             t.latest_reactions, t.latest_comments, t.latest_shares, t.status, t.last_checked_at,
             s.delta_reactions, s.growth_rate_5m, s.growth_rate_1h
      FROM monitored_targets t
      LEFT JOIN snapshots s ON s.target_id = t.id AND s.id = (
        SELECT MAX(id) FROM snapshots WHERE target_id = t.id
      )
      ORDER BY s.growth_rate_5m DESC, (t.latest_reactions + t.latest_comments + t.latest_shares) DESC
      LIMIT 5
    `).all() || [];

    // Engagement reliability analysis
    const totalIdentified = db.prepare('SELECT COUNT(*) as count FROM accounts_interacted').get()?.count || 0;
    const grandTotalInteractions = (totals.total_reactions || 0) + (totals.total_comments || 0) + (totals.total_shares || 0);
    const suspiciousCount = db.prepare(`
      SELECT COUNT(*) as count FROM accounts_interacted 
      WHERE comment_text IN (
        SELECT comment_text FROM accounts_interacted WHERE comment_text IS NOT NULL AND length(comment_text) > 3 
        GROUP BY comment_text HAVING count(*) > 3
      )
    `).get()?.count || 0;

    const organicCount = Math.max(0, totalIdentified - suspiciousCount);
    const unknownCount = Math.max(0, grandTotalInteractions - totalIdentified);

    const reliability = {
      status: 'AVAILABLE',
      totalIdentified,
      organicCount,
      suspiciousCount,
      unknownCount,
      grandTotalInteractions,
      note: 'Meta Graph API chỉ trả về danh tính ở phạm vi phân quyền cho phép; các reaction dạng tổng hợp ngoài page được xếp vào nhóm UNKNOWN theo nguyên tắc dữ liệu thực.'
    };

    // Recent 10 alerts
    const recentAlerts = db.prepare(`
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ORDER BY a.detected_at DESC
      LIMIT 10
    `).all() || [];

    const recentActivity = recentAlerts.map(a => ({
      id: a.id,
      timestamp: a.detected_at,
      targetId: a.target_id,
      authorName: a.author_name || 'Facebook Post',
      eventType: a.alert_type,
      message: a.message,
      severity: a.severity,
      delta: a.delta,
      acknowledged: a.acknowledged
    }));

    res.json({
      range: rangeParam,
      lastSyncAt,
      metrics: {
        totalTargets,
        activeTasks,
        errorTasks,
        totalReactions: totals.total_reactions || 0,
        totalComments: totals.total_comments || 0,
        totalShares: totals.total_shares || 0,
        reactionBreakdown,
        periodDelta: {
          reactions: periodDelta.delta_reactions || 0,
          comments: periodDelta.delta_comments || 0,
          shares: periodDelta.delta_shares || 0
        },
        prevPeriodDelta: {
          reactions: prevPeriodDelta.delta_reactions || 0,
          comments: prevPeriodDelta.delta_comments || 0,
          shares: prevPeriodDelta.delta_shares || 0
        },
        totalAlerts: totalAlertsInPeriod,
        unresolvedAlerts
      },
      timeSeries,
      topFastest,
      recentAlerts,
      recentActivity,
      reliability
    });
  });

  // 2. Batch URL Parse & Pre-check (Section 2)
  app.post('/api/targets/batch-parse', (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'Cần cung cấp danh sách URL Facebook' });
    const parsed = parseBatchUrls(input);
    res.json({ items: parsed, totalCount: parsed.length });
  });

  // 3. Create Monitored Targets (Section 2 & 4)
  app.post('/api/targets', async (req, res) => {
    const { urls, checkIntervalSec = 60, priority = 1, boundAccountId = null } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Danh sách URLs không hợp lệ' });
    }

    const created = [];
    const skipped = [];
    const now = new Date().toISOString();

    const insertStmt = db.prepare(`
      INSERT INTO monitored_targets (
        original_url, normalized_url, target_type, content_id,
        author_name, status, check_interval_sec, priority, bound_account_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rawUrl of urls) {
      const clean = normalizeUrl(rawUrl);
      if (!clean) {
        skipped.push({ url: rawUrl, reason: 'URL không hợp lệ' });
        continue;
      }

      const existing = db.prepare('SELECT id FROM monitored_targets WHERE normalized_url = ?').get(clean);
      if (existing) {
        skipped.push({ url: clean, reason: 'Đã tồn tại trong hệ thống' });
        continue;
      }

      const analysis = analyzeUrl(clean);
      try {
        const info = insertStmt.run(
          rawUrl,
          clean,
          analysis.type,
          analysis.contentId || null,
          analysis.type.toUpperCase(),
          analysis.status === 'INACCESSIBLE' ? 'INACCESSIBLE' : 'ACTIVE',
          Math.max(10, parseInt(checkIntervalSec, 10)),
          Math.max(1, Math.min(10, parseInt(priority, 10))),
          boundAccountId || null,
          now
        );

        const newTargetId = Number(info.lastInsertRowid);
        const targetRow = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(newTargetId);
        created.push(targetRow);

        // Immediate baseline execution asynchronously
        monitorScheduler.triggerImmediateCheck(newTargetId).catch(err => {
          console.error(`Lỗi tạo baseline cho target #${newTargetId}:`, err.message);
        });
      } catch (err) {
        skipped.push({ url: clean, reason: err.message });
      }
    }

    res.json({ createdCount: created.length, created, skipped });
  });

  // 4. List Targets with Filter & Pagination
  app.get('/api/targets', (req, res) => {
    const { status, search, type, sort = 'newest', limit = 50, page = 1 } = req.query;
    let whereClause = ' WHERE 1=1';
    const params = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }
    if (type) {
      whereClause += ' AND target_type = ?';
      params.push(type);
    }
    if (search) {
      whereClause += ' AND (normalized_url LIKE ? OR author_name LIKE ? OR content_snippet LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    let orderSql = ' ORDER BY id DESC';
    if (sort === 'growth') {
      orderSql = ' ORDER BY (SELECT growth_rate_5m FROM snapshots WHERE target_id = monitored_targets.id ORDER BY id DESC LIMIT 1) DESC, latest_reactions DESC';
    } else if (sort === 'reactions') {
      orderSql = ' ORDER BY latest_reactions DESC';
    } else if (sort === 'comments') {
      orderSql = ' ORDER BY latest_comments DESC';
    } else if (sort === 'shares') {
      orderSql = ' ORDER BY latest_shares DESC';
    } else if (sort === 'oldest') {
      orderSql = ' ORDER BY id ASC';
    }

    const countSql = `SELECT COUNT(*) as count FROM monitored_targets ${whereClause}`;
    const totalCount = db.prepare(countSql).get(...params)?.count || 0;

    const sql = `SELECT * FROM monitored_targets ${whereClause} ${orderSql} LIMIT ? OFFSET ?`;
    const lim = parseInt(limit, 10);
    const p = parseInt(page, 10);
    const targets = db.prepare(sql).all(...params, lim, (p - 1) * lim);

    const totalTargets = db.prepare('SELECT COUNT(*) as count FROM monitored_targets').get()?.count || 0;
    const activeTargets = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").get()?.count || 0;
    const pausedTargets = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'PAUSED'").get()?.count || 0;
    const errorTargets = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('ERROR', 'INACCESSIBLE', 'NEEDS_AUTH', 'PERMISSION_REQUIRED', 'RATE_LIMITED')").get()?.count || 0;
    const unresolvedAlerts = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0").get()?.count || 0;

    res.json({
      targets,
      totalCount,
      page: p,
      limit: lim,
      totalPages: Math.max(1, Math.ceil(totalCount / lim)),
      kpi: {
        totalTargets,
        activeTargets,
        pausedTargets,
        errorTargets,
        unresolvedAlerts
      }
    });
  });

  // 5. Get Single Target Detail (Section 5, 6, 7)
  app.get('/api/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rangeParam = req.query.range || '24H';
    const rangeMap = {
      '1M': 60 * 1000,
      '5M': 5 * 60 * 1000,
      '15M': 15 * 60 * 1000,
      '30M': 30 * 60 * 1000,
      '1H': 60 * 60 * 1000,
      '3H': 3 * 60 * 60 * 1000,
      '6H': 6 * 60 * 60 * 1000,
      '12H': 12 * 60 * 60 * 1000,
      '24H': 24 * 60 * 60 * 1000,
      '7D': 7 * 24 * 60 * 60 * 1000,
      '30D': 30 * 24 * 60 * 60 * 1000
    };
    const rangeMs = rangeMap[rangeParam] || (24 * 60 * 60 * 1000);
    const cutoffTime = new Date(Date.now() - rangeMs).toISOString();

    const target = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Không tìm thấy đối tượng' });

    // Snapshots within range
    const snapshots = db.prepare(`
      SELECT * FROM snapshots 
      WHERE target_id = ? AND observed_at >= ?
      ORDER BY observed_at DESC 
      LIMIT 100
    `).all(id, cutoffTime);

    let latestSnapshot = snapshots[0] || null;
    if (!latestSnapshot) {
      latestSnapshot = db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY id DESC LIMIT 1').get(id);
    }

    // Identifiable accounts interacted
    const interactedAccounts = db.prepare(`
      SELECT * FROM accounts_interacted 
      WHERE target_id = ? AND observed_at >= ?
      ORDER BY observed_at DESC 
      LIMIT 50
    `).all(id, cutoffTime);

    const alertConfig = alertEngine.getAlertConfig(id);
    const recentAlerts = db.prepare('SELECT * FROM alerts WHERE target_id = ? ORDER BY detected_at DESC LIMIT 10').all(id);

    const totalIdentified = interactedAccounts.length;
    const suspiciousCount = db.prepare(`
      SELECT COUNT(*) as count FROM accounts_interacted 
      WHERE target_id = ? AND comment_text IN (
        SELECT comment_text FROM accounts_interacted WHERE target_id = ? AND comment_text IS NOT NULL AND length(comment_text) > 3 
        GROUP BY comment_text HAVING count(*) > 2
      )
    `).get(id, id)?.count || 0;

    const totalEngagement = (target.latest_reactions || 0) + (target.latest_comments || 0) + (target.latest_shares || 0);
    const organicCount = Math.max(0, totalIdentified - suspiciousCount);
    const unknownCount = Math.max(0, totalEngagement - totalIdentified);

    let deltaPeriod = { reactions: 0, comments: 0, shares: 0 };
    if (snapshots.length >= 2) {
      const oldest = snapshots[snapshots.length - 1];
      const newest = snapshots[0];
      deltaPeriod = {
        reactions: Math.max(0, (newest.total_reactions || 0) - (oldest.total_reactions || 0)),
        comments: Math.max(0, (newest.total_comments || 0) - (oldest.total_comments || 0)),
        shares: Math.max(0, (newest.total_shares || 0) - (oldest.total_shares || 0))
      };
    } else if (snapshots.length === 1) {
      deltaPeriod = {
        reactions: snapshots[0].delta_reactions || 0,
        comments: snapshots[0].delta_comments || 0,
        shares: snapshots[0].delta_shares || 0
      };
    }

    res.json({
      range: rangeParam,
      target,
      latestSnapshot,
      snapshots: snapshots.reverse(),
      interactedAccounts,
      alertConfig,
      recentAlerts,
      authenticity: {
        totalIdentified,
        organicCount,
        suspiciousCount,
        unknownCount,
        totalEngagement,
        status: totalIdentified > 0 ? 'AVAILABLE' : 'PARTIAL'
      },
      deltaPeriod
    });
  });

  // 6. Update Target
  app.patch('/api/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, checkIntervalSec, check_interval_sec, priority } = req.body;
    const intervalVal = checkIntervalSec || check_interval_sec || null;

    const target = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Không tìm thấy đối tượng' });

    db.prepare(`
      UPDATE monitored_targets 
      SET status = COALESCE(?, status),
          check_interval_sec = COALESCE(?, check_interval_sec),
          priority = COALESCE(?, priority)
      WHERE id = ?
    `).run(status || null, intervalVal, priority || null, id);

    res.json({ success: true, updated: { id, status, check_interval_sec: intervalVal, priority } });
  });

  // 7. Trigger Manual Immediate Sync (Single)
  app.post('/api/targets/:id/sync-now', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await monitorScheduler.triggerImmediateCheck(id);
      res.json({ success: true, message: 'Đã kích hoạt đồng bộ tức thời' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7b. Trigger Manual Immediate Sync (All Active Targets)
  app.post('/api/targets/sync-all', async (req, res) => {
    try {
      const targets = db.prepare("SELECT id FROM monitored_targets WHERE status != 'PAUSED' LIMIT 20").all();
      for (const t of targets) {
        await monitorScheduler.triggerImmediateCheck(t.id).catch(() => {});
      }
      res.json({ success: true, count: targets.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. Delete Target
  app.delete('/api/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM monitored_targets WHERE id = ?').run(id);
    res.json({ success: true });
  });

  // 9. Accounts Management (Section 3)
  app.get('/api/accounts', (req, res) => {
    res.json({ accounts: accountManager.listAccounts() });
  });

  app.post('/api/accounts/inspect-and-import', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Cần cung cấp token' });
    try {
      const AccountInspectorTool = require('../../Tool/inspectAccount');
      const tool = new AccountInspectorTool();
      const result = await tool.run(token);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/accounts', (req, res) => {
    try {
      const { name, accountType, fbAccountId, accessToken, scopes, expiresAt } = req.body;
      const result = accountManager.addAccount({
        name,
        accountType,
        fbAccountId,
        accessToken,
        scopes,
        expiresAt
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    accountManager.revokeAccount(id);
    res.json({ success: true });
  });

  // 10. Alerts & Threshold Config (Section 8)
  app.get('/api/alerts', (req, res) => {
    const { acknowledged } = req.query;
    let sql = `
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
    `;
    const params = [];
    if (acknowledged !== undefined) {
      sql += ' WHERE a.acknowledged = ?';
      params.push(parseInt(acknowledged, 10));
    }
    sql += ' ORDER BY a.detected_at DESC LIMIT 100';

    const alerts = db.prepare(sql).all(...params);
    res.json({ alerts });
  });

  app.patch('/api/alerts/:id/ack', (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
    res.json({ success: true });
  });

  app.put('/api/targets/:id/alert-config', (req, res) => {
    const id = parseInt(req.params.id, 10);
    alertEngine.setAlertConfig(id, req.body);
    res.json({ success: true });
  });

  // 11. Multi-Target Comparison (Section 7)
  app.get('/api/comparison', (req, res) => {
    const ids = (req.query.ids || '').split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (ids.length === 0) return res.json({ series: [] });

    const results = ids.map(id => {
      const target = db.prepare('SELECT id, author_name, normalized_url, target_type FROM monitored_targets WHERE id = ?').get(id);
      const points = db.prepare(`
        SELECT observed_at, total_reactions, total_comments, total_shares 
        FROM snapshots 
        WHERE target_id = ? 
        ORDER BY observed_at ASC 
        LIMIT 50
      `).all(id);
      return { target, points };
    });

    res.json({ comparison: results });
  });

  // 12. System Health & Operational Status (Section 9)
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'HEALTHY',
      uptimeSec: Math.floor(process.uptime()),
      scheduler: {
        running: monitorScheduler.isRunning,
        activeTasks: monitorScheduler.activeTaskCount,
        maxConcurrent: config.maxConcurrentChecks
      },
      devSimulationEnabled: config.enableDevSimulator,
      timestamp: new Date().toISOString()
    });
  });

  return { app, server };
}

module.exports = { createServer };
