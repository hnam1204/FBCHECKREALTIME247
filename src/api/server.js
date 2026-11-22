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
    const totalTargets = db.prepare('SELECT COUNT(*) as count FROM monitored_targets').get().count;
    const activeTasks = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").get().count;
    const errorTasks = db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('INACCESSIBLE', 'NEEDS_AUTH')").get().count;

    const totals = db.prepare(`
      SELECT 
        SUM(latest_reactions) as total_reactions,
        SUM(latest_comments) as total_comments,
        SUM(latest_shares) as total_shares
      FROM monitored_targets
    `).get();

    // Fastest growing targets (5m rate or latest reactions delta)
    const topFastest = db.prepare(`
      SELECT t.id, t.author_name, t.content_snippet, t.target_type, t.normalized_url,
             t.latest_reactions, t.latest_comments, t.latest_shares,
             s.delta_reactions, s.growth_rate_5m, s.growth_rate_1h
      FROM monitored_targets t
      LEFT JOIN snapshots s ON s.target_id = t.id AND s.id = (
        SELECT MAX(id) FROM snapshots WHERE target_id = t.id
      )
      WHERE t.status = 'ACTIVE'
      ORDER BY s.growth_rate_5m DESC, s.delta_reactions DESC
      LIMIT 5
    `).all();

    // Recent 10 alerts
    const recentAlerts = db.prepare(`
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ORDER BY a.detected_at DESC
      LIMIT 10
    `).all();

    res.json({
      metrics: {
        totalTargets,
        activeTasks,
        errorTasks,
        totalReactions: totals.total_reactions || 0,
        totalComments: totals.total_comments || 0,
        totalShares: totals.total_shares || 0
      },
      topFastest,
      recentAlerts
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
    const { status, search, type, limit = 50, page = 1 } = req.query;
    let sql = 'SELECT * FROM monitored_targets WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (type) {
      sql += ' AND target_type = ?';
      params.push(type);
    }
    if (search) {
      sql += ' AND (normalized_url LIKE ? OR author_name LIKE ? OR content_snippet LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), (parseInt(page, 10) - 1) * parseInt(limit, 10));

    const targets = db.prepare(sql).all(...params);
    res.json({ targets, page: parseInt(page, 10) });
  });

  // 5. Get Single Target Detail (Section 5, 6, 7)
  app.get('/api/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Không tìm thấy đối tượng' });

    // Recent snapshots (timeline for 3 groups of metrics)
    const snapshots = db.prepare(`
      SELECT * FROM snapshots 
      WHERE target_id = ? 
      ORDER BY observed_at DESC 
      LIMIT 100
    `).all(id);

    // Latest snapshot
    const latestSnapshot = snapshots[0] || null;

    // Identifiable accounts interacted (Section 6)
    const interactedAccounts = db.prepare(`
      SELECT * FROM accounts_interacted 
      WHERE target_id = ? 
      ORDER BY observed_at DESC 
      LIMIT 50
    `).all(id);

    // Alert config
    const alertConfig = alertEngine.getAlertConfig(id);

    res.json({
      target,
      latestSnapshot,
      snapshots: snapshots.reverse(), // chronologically for chart
      interactedAccounts,
      alertConfig
    });
  });

  // 6. Update Target
  app.patch('/api/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, checkIntervalSec, priority } = req.body;

    const target = db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Không tìm thấy đối tượng' });

    db.prepare(`
      UPDATE monitored_targets 
      SET status = COALESCE(?, status),
          check_interval_sec = COALESCE(?, check_interval_sec),
          priority = COALESCE(?, priority)
      WHERE id = ?
    `).run(status || null, checkIntervalSec || null, priority || null, id);

    res.json({ success: true, updated: { id, status, checkIntervalSec, priority } });
  });

  // 7. Trigger Manual Immediate Sync
  app.post('/api/targets/:id/sync-now', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await monitorScheduler.triggerImmediateCheck(id);
      res.json({ success: true, message: 'Đã kích hoạt đồng bộ tức thời' });
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
