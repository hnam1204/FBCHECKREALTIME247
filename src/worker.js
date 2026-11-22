import { parseBatchUrls, normalizeUrl, analyzeUrl } from './analyzer/urlAnalyzer.js';
import { extractCUser, isCheckpointOrLogin, parseMbasicHtml, parseMbasicReactionsBreakdown, parseMbasicReactors } from './collector/mbasicCollector.js';
import { parseBatchProxies, parseProxyString } from './collector/proxyHelper.js';
import { computeComparisonAnalytics } from './analytics/comparisonEngine.js';

// --- Web Crypto Utilities (AES-256-GCM - Pure Native Web Standards) ---
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptToken(text, masterHexKey) {
  if (!text) return '';
  const key = await crypto.subtle.importKey('raw', hexToBytes(masterHexKey.slice(0, 64)), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const tag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(ciphertext)}`;
}

async function decryptToken(payload, masterHexKey) {
  if (!payload || !payload.includes(':')) return '';
  const [ivHex, tagHex, encryptedHex] = payload.split(':');
  if (!ivHex || !tagHex || !encryptedHex) return '';
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(masterHexKey.slice(0, 64)), { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = hexToBytes(ivHex);
    const ct = hexToBytes(encryptedHex);
    const tag = hexToBytes(tagHex);
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '';
  }
}

// --- Security & Privacy Helpers ---
async function computeEvidenceHash(text) {
  if (!text) return null;
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return bytesToHex(new Uint8Array(hashBuf));
}

function maskProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    if (rawUrl.includes('://')) {
      const u = new URL(rawUrl);
      if (u.password || u.username) {
        return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}`;
      }
      return rawUrl;
    }
    const parts = rawUrl.split(':');
    if (parts.length === 4) {
      return `${parts[0]}:${parts[1]}:${parts[2]}:***`;
    }
    return rawUrl;
  } catch (e) {
    return '***masked-proxy***';
  }
}

// --- Alert Deduplication & Cooldown Engine (30-min window) ---
async function recordAlertWithCooldown(db, { targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, now }, cooldownMinutes = 30) {
  const existing = await db.prepare(`
    SELECT id FROM alerts 
    WHERE target_id = ? AND alert_type = ? 
      AND (acknowledged = 0 OR (strftime('%s', ?) - strftime('%s', detected_at)) < ?)
    ORDER BY detected_at DESC LIMIT 1
  `).bind(targetId, alertType, now, cooldownMinutes * 60).first();

  if (existing) {
    await db.prepare(`
      UPDATE alerts 
      SET detected_at = ?, new_val = ?, delta = ?, message = ?
      WHERE id = ?
    `).bind(now, newVal, delta, message, existing.id).run();
    return existing.id;
  }

  const res = await db.prepare(`
    INSERT INTO alerts (target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at, acknowledged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(targetId, alertType, metricName, oldVal, newVal, delta, threshold, severity, message, now).run();

  return res.meta?.last_row_id;
}

// Helper: JSON Response
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sidecar-Secret',
    }
  });
}

// --- Main Cloudflare Worker Export ---
const worker_default = {
  // 1. HTTP Request Router (Edge API & Static Assets)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return jsonResponse({ ok: true });
    }

    // 0. Native Edge WebSocket for True Realtime 24/7 Telemetry
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      server.send(JSON.stringify({
        type: 'CONNECTED',
        message: 'Edge WebSocket Realtime 24/7 đã kết nối trực tiếp',
        timestamp: new Date().toISOString()
      }));

      server.addEventListener('message', async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'PING') {
            server.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          } else if (msg.type === 'GET_METRICS' || msg.type === 'SYNC_REQUEST') {
            const targets = (await env.DB.prepare(`
              SELECT t.*, 
                     a.name AS bound_account_name, 
                     a.account_type AS bound_account_type,
                     (SELECT source_type FROM snapshots WHERE target_id = t.id ORDER BY id DESC LIMIT 1) AS latest_source_type
              FROM monitored_targets t
              LEFT JOIN accounts a ON a.id = t.bound_account_id
              WHERE t.status != 'PAUSED'
              ORDER BY t.priority DESC, t.last_checked_at DESC
            `).all())?.results || [];

            const totals = (await env.DB.prepare(`
              SELECT 
                SUM(latest_reactions) as total_reactions,
                SUM(latest_comments) as total_comments,
                SUM(latest_shares) as total_shares
              FROM monitored_targets
            `).first()) || {};

            server.send(JSON.stringify({
              type: 'LIVE_METRICS',
              targets,
              totals,
              timestamp: new Date().toISOString()
            }));
          }
        } catch (err) {}
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // Only intercept /api/* routes; all other paths served from public/ via env.ASSETS
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApiRoute(pathname, method, request, env, url);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Fallback to static assets (public/index.html, styles.css, app.js)
    if (env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    // Fallback UI for Cloudflare Dashboard Quick Edit Preview (where static assets are not mounted)
    const previewFallbackHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="refresh" content="3;url=https://cookiefb.coongviec.workers.dev"/>
  <title>NHN Telemetry - Cloudflare Edge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 520px; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h1 { font-size: 1.25rem; font-weight: 700; color: #38bdf8; margin: 0 0 12px; }
    p { font-size: 0.875rem; color: #94a3b8; line-height: 1.6; margin: 8px 0; }
    .btn { display: inline-block; margin-top: 18px; padding: 10px 20px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; font-size: 0.875rem; border-radius: 8px; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
    .badge { display: inline-block; padding: 4px 10px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-radius: 6px; font-size: 0.75rem; font-weight: 600; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">NHN TELEMETRY • CLOUDFLARE EDGE ACTIVE</div>
    <h1>Hệ thống Đang Hoạt Động Bình Thường</h1>
    <p>Trình xem thử (Quick Edit Preview) trong Dashboard của Cloudflare không tự động đính kèm thư mục tệp tĩnh (Static Assets).</p>
    <p>Website thực tế đã được deploy và đang hoạt động đầy đủ tại:</p>
    <a class="btn" href="https://cookiefb.coongviec.workers.dev" target="_blank" rel="noopener">Mở Website Trực Tiếp (cookiefb.coongviec.workers.dev) ↗</a>
  </div>
</body>
</html>`;

    return new Response(previewFallbackHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  },

  // 2. 24/7 Cloudflare Edge Cron Trigger (Runs every minute)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledMonitoringTick(env));
  }
};

export default worker_default;
export {
  worker_default,
  maskProxyUrl,
  recordAlertWithCooldown,
  encryptToken,
  decryptToken,
  computeEvidenceHash
};

// --- API Router Implementation for Cloudflare D1 ---
async function handleApiRoute(pathname, method, request, env, url) {
  const db = env.DB;
  const masterKey = env.ENCRYPTION_MASTER_KEY || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const graphVersion = env.META_GRAPH_VERSION || 'v21.0';

  // GET /api/overview
  if (pathname === '/api/overview' && method === 'GET') {
    const rangeParam = url.searchParams.get('range') || '24H';
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

    const totalTargets = (await db.prepare('SELECT COUNT(*) as count FROM monitored_targets').first())?.count || 0;
    const activeTasks = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").first())?.count || 0;
    const errorTasks = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('INACCESSIBLE', 'NEEDS_AUTH')").first())?.count || 0;

    const totals = (await db.prepare(`
      SELECT 
        SUM(latest_reactions) as total_reactions,
        SUM(latest_comments) as total_comments,
        SUM(latest_shares) as total_shares
      FROM monitored_targets
    `).first()) || {};

    // Breakdown of 7 reactions across latest snapshots
    const reactionBreakdown = (await db.prepare(`
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
    `).first()) || { like_count: 0, love_count: 0, care_count: 0, haha_count: 0, wow_count: 0, sad_count: 0, angry_count: 0 };

    // Delta in the selected period vs prior period (Lọc bỏ các delta âm bất thường và spike rác)
    const periodDelta = (await db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN delta_reactions > 0 AND delta_reactions < 2000 THEN delta_reactions ELSE 0 END), 0) as delta_reactions,
        COALESCE(SUM(CASE WHEN delta_comments > 0 AND delta_comments < 2000 THEN delta_comments ELSE 0 END), 0) as delta_comments,
        COALESCE(SUM(CASE WHEN delta_shares > 0 AND delta_shares < 2000 THEN delta_shares ELSE 0 END), 0) as delta_shares
      FROM snapshots
      WHERE observed_at >= ?
    `).bind(cutoffTime).first()) || {};

    const prevPeriodDelta = (await db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN delta_reactions > 0 AND delta_reactions < 2000 THEN delta_reactions ELSE 0 END), 0) as delta_reactions,
        COALESCE(SUM(CASE WHEN delta_comments > 0 AND delta_comments < 2000 THEN delta_comments ELSE 0 END), 0) as delta_comments,
        COALESCE(SUM(CASE WHEN delta_shares > 0 AND delta_shares < 2000 THEN delta_shares ELSE 0 END), 0) as delta_shares
      FROM snapshots
      WHERE observed_at >= ? AND observed_at < ?
    `).bind(priorCutoffTime, cutoffTime).first()) || {};

    const totalAlertsInPeriod = (await db.prepare('SELECT COUNT(*) as count FROM alerts WHERE detected_at >= ?').bind(cutoffTime).first())?.count || 0;
    const unresolvedAlerts = (await db.prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').first())?.count || 0;
    const lastSyncAt = (await db.prepare('SELECT MAX(observed_at) as last_sync FROM snapshots').first())?.last_sync || null;

    // Time-series points for the chart in the selected range
    const rawSnapshots = (await db.prepare(`
      SELECT observed_at, 
             SUM(total_reactions) as total_reactions,
             SUM(total_comments) as total_comments,
             SUM(total_shares) as total_shares,
             COALESCE(SUM(CASE WHEN delta_reactions > 0 AND delta_reactions < 2000 THEN delta_reactions ELSE 0 END), 0) as delta_reactions,
             COALESCE(SUM(CASE WHEN delta_comments > 0 AND delta_comments < 2000 THEN delta_comments ELSE 0 END), 0) as delta_comments,
             COALESCE(SUM(CASE WHEN delta_shares > 0 AND delta_shares < 2000 THEN delta_shares ELSE 0 END), 0) as delta_shares
      FROM snapshots
      WHERE observed_at >= ?
      GROUP BY observed_at
      ORDER BY observed_at ASC
    `).bind(cutoffTime).all())?.results || [];

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
    const topFastest = (await db.prepare(`
      SELECT t.id, t.author_name, t.content_snippet, t.target_type, t.normalized_url,
             t.latest_reactions, t.latest_comments, t.latest_shares, t.status, t.last_checked_at,
             s.delta_reactions, s.growth_rate_5m, s.growth_rate_1h
      FROM monitored_targets t
      LEFT JOIN snapshots s ON s.target_id = t.id AND s.id = (
        SELECT MAX(id) FROM snapshots WHERE target_id = t.id
      )
      ORDER BY s.growth_rate_5m DESC, (t.latest_reactions + t.latest_comments + t.latest_shares) DESC
      LIMIT 5
    `).all())?.results || [];

    // Engagement reliability analysis
    const totalIdentified = (await db.prepare('SELECT COUNT(*) as count FROM accounts_interacted').first())?.count || 0;
    const grandTotalInteractions = (totals.total_reactions || 0) + (totals.total_comments || 0) + (totals.total_shares || 0);
    const suspiciousCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM accounts_interacted 
      WHERE comment_text IN (
        SELECT comment_text FROM accounts_interacted WHERE comment_text IS NOT NULL AND length(comment_text) > 3 
        GROUP BY comment_text HAVING count(*) > 3
      )
    `).first())?.count || 0;

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
    const recentAlerts = (await db.prepare(`
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ORDER BY a.detected_at DESC
      LIMIT 10
    `).all())?.results || [];

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

    return jsonResponse({
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
  }

  // POST /api/targets/batch-parse
  if (pathname === '/api/targets/batch-parse' && method === 'POST') {
    const body = await request.json();
    if (!body.input) return jsonResponse({ error: 'Cần cung cấp danh sách URL Facebook' }, 400);
    const parsed = parseBatchUrls(body.input);
    return jsonResponse({ items: parsed, totalCount: parsed.length });
  }

  // POST /api/targets
  if (pathname === '/api/targets' && method === 'POST') {
    const { urls, checkIntervalSec = 60, priority = 1, boundAccountId = null } = await request.json();
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return jsonResponse({ error: 'Danh sách URLs không hợp lệ' }, 400);
    }

    const created = [];
    const skipped = [];
    const now = new Date().toISOString();

    for (const rawUrl of urls) {
      const clean = normalizeUrl(rawUrl);
      if (!clean) {
        skipped.push({ url: rawUrl, reason: 'URL không hợp lệ' });
        continue;
      }

      const existing = await db.prepare('SELECT id FROM monitored_targets WHERE normalized_url = ?').bind(clean).first();
      if (existing) {
        skipped.push({ url: clean, reason: 'Đã tồn tại trong hệ thống' });
        continue;
      }

      const analysis = analyzeUrl(clean);
      try {
        const insertRes = await db.prepare(`
          INSERT INTO monitored_targets (
            original_url, normalized_url, target_type, content_id,
            author_name, status, check_interval_sec, priority, bound_account_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          rawUrl, clean, analysis.type, analysis.contentId || null,
          analysis.type.toUpperCase(),
          analysis.status === 'INACCESSIBLE' ? 'INACCESSIBLE' : 'ACTIVE',
          Math.max(10, parseInt(checkIntervalSec, 10)),
          Math.max(1, Math.min(10, parseInt(priority, 10))),
          boundAccountId || null,
          now
        ).run();

        const newTargetId = insertRes.meta.last_row_id;
        const targetRow = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(newTargetId).first();
        created.push(targetRow);
      } catch (err) {
        skipped.push({ url: clean, reason: err.message });
      }
    }

    return jsonResponse({ createdCount: created.length, created, skipped });
  }

  // GET /api/targets
  if (pathname === '/api/targets' && method === 'GET') {
    const status = url.searchParams.get('status');
    const type = url.searchParams.get('type');
    const search = url.searchParams.get('search');
    const sort = url.searchParams.get('sort') || 'newest';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const offset = (page - 1) * limit;

    let whereClause = ' WHERE 1=1';
    const params = [];

    if (status) {
      whereClause += ' AND t.status = ?';
      params.push(status);
    }
    if (type) {
      whereClause += ' AND t.target_type = ?';
      params.push(type);
    }
    if (search) {
      whereClause += ' AND (t.normalized_url LIKE ? OR t.author_name LIKE ? OR t.content_snippet LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    // Sort order
    let orderSql = ' ORDER BY t.id DESC';
    if (sort === 'growth') {
      orderSql = ' ORDER BY (SELECT growth_rate_5m FROM snapshots WHERE target_id = t.id ORDER BY id DESC LIMIT 1) DESC, t.latest_reactions DESC';
    } else if (sort === 'reactions') {
      orderSql = ' ORDER BY t.latest_reactions DESC';
    } else if (sort === 'comments') {
      orderSql = ' ORDER BY t.latest_comments DESC';
    } else if (sort === 'shares') {
      orderSql = ' ORDER BY t.latest_shares DESC';
    } else if (sort === 'oldest') {
      orderSql = ' ORDER BY t.id ASC';
    }

    const countSql = `SELECT COUNT(*) as count FROM monitored_targets t ${whereClause}`;
    const totalCount = (await db.prepare(countSql).bind(...params).first())?.count || 0;

    const sql = `
      SELECT t.*, 
             a.name AS bound_account_name, 
             a.account_type AS bound_account_type,
             (SELECT source_type FROM snapshots WHERE target_id = t.id ORDER BY id DESC LIMIT 1) AS latest_source_type,
             (SELECT growth_rate_5m FROM snapshots WHERE target_id = t.id ORDER BY id DESC LIMIT 1) AS latest_growth_5m
      FROM monitored_targets t
      LEFT JOIN accounts a ON a.id = t.bound_account_id
      ${whereClause}
      ${orderSql}
      LIMIT ? OFFSET ?
    `;

    const results = (await db.prepare(sql).bind(...params, limit, offset).all())?.results || [];

    // 5 Monitoring KPI Stats
    const totalTargets = (await db.prepare('SELECT COUNT(*) as count FROM monitored_targets').first())?.count || 0;
    const activeTargets = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").first())?.count || 0;
    const pausedTargets = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'PAUSED'").first())?.count || 0;
    const errorTargets = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('ERROR', 'INACCESSIBLE', 'NEEDS_AUTH', 'PERMISSION_REQUIRED', 'RATE_LIMITED')").first())?.count || 0;
    const unresolvedAlerts = (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0").first())?.count || 0;

    return jsonResponse({
      targets: results,
      totalCount,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      kpi: {
        totalTargets,
        activeTargets,
        pausedTargets,
        errorTargets,
        unresolvedAlerts
      }
    });
  }

  // GET /api/targets/:id
  const targetIdMatch = pathname.match(/^\/api\/targets\/(\d+)$/);
  if (targetIdMatch && method === 'GET') {
    const id = parseInt(targetIdMatch[1], 10);
    const rangeParam = url.searchParams.get('range') || '24H';
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

    const target = await db.prepare(`
      SELECT t.*, 
             a.name AS bound_account_name, 
             a.account_type AS bound_account_type,
             (SELECT source_type FROM snapshots WHERE target_id = t.id ORDER BY id DESC LIMIT 1) AS latest_source_type
      FROM monitored_targets t
      LEFT JOIN accounts a ON a.id = t.bound_account_id
      WHERE t.id = ?
    `).bind(id).first();
    if (!target) return jsonResponse({ error: 'Không tìm thấy đối tượng' }, 404);

    const snapshots = (await db.prepare('SELECT * FROM snapshots WHERE target_id = ? AND observed_at >= ? ORDER BY observed_at DESC LIMIT 100').bind(id, cutoffTime).all())?.results || [];
    
    // Fallback if no snapshots in time range: get at least the latest snapshot
    let latestSnapshot = snapshots[0] || null;
    if (!latestSnapshot) {
      latestSnapshot = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
    }

    let interactedAccounts = (await db.prepare('SELECT * FROM accounts_interacted WHERE target_id = ? AND observed_at >= ? ORDER BY observed_at DESC LIMIT 50').bind(id, cutoffTime).all())?.results || [];
    if (interactedAccounts.length === 0) {
      interactedAccounts = (await db.prepare('SELECT * FROM accounts_interacted WHERE target_id = ? ORDER BY observed_at DESC LIMIT 50').bind(id).all())?.results || [];
    }
    const alertConfig = (await db.prepare('SELECT * FROM target_alert_configs WHERE target_id = ?').bind(id).first()) || {};
    const recentAlerts = (await db.prepare('SELECT * FROM alerts WHERE target_id = ? ORDER BY detected_at DESC LIMIT 10').bind(id).all())?.results || [];

    // Authenticity Analysis for this specific target
    const totalIdentified = interactedAccounts.length;
    const suspiciousCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM accounts_interacted 
      WHERE target_id = ? AND comment_text IN (
        SELECT comment_text FROM accounts_interacted WHERE target_id = ? AND comment_text IS NOT NULL AND length(comment_text) > 3 
        GROUP BY comment_text HAVING count(*) > 2
      )
    `).bind(id, id).first())?.count || 0;

    const totalEngagement = (target.latest_reactions || 0) + (target.latest_comments || 0) + (target.latest_shares || 0);
    const organicCount = Math.max(0, totalIdentified - suspiciousCount);
    const unknownCount = Math.max(0, totalEngagement - totalIdentified);

    // Delta within the selected period
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

    return jsonResponse({
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
  }

  // PATCH /api/targets/:id (Update status, check_interval_sec, priority)
  if (targetIdMatch && method === 'PATCH') {
    const id = parseInt(targetIdMatch[1], 10);
    const body = await request.json();
    const updates = [];
    const params = [];

    if (body.status !== undefined) {
      updates.push('status = ?');
      params.push(body.status);
    }
    if (body.check_interval_sec !== undefined || body.checkIntervalSec !== undefined) {
      updates.push('check_interval_sec = ?');
      params.push(parseInt(body.check_interval_sec || body.checkIntervalSec, 10));
    }
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      params.push(parseInt(body.priority, 10));
    }

    if (updates.length > 0) {
      params.push(id);
      await db.prepare(`UPDATE monitored_targets SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    }
    return jsonResponse({ success: true, id });
  }

  // DELETE /api/targets/:id
  if (targetIdMatch && method === 'DELETE') {
    const id = parseInt(targetIdMatch[1], 10);
    await db.prepare('DELETE FROM monitored_targets WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
  }

  // POST /api/targets/:id/sync-now
  const syncMatch = pathname.match(/^\/api\/targets\/(\d+)\/sync-now$/);
  if (syncMatch && method === 'POST') {
    const id = parseInt(syncMatch[1], 10);
    const target = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(id).first();
    if (!target) return jsonResponse({ error: 'Không tìm thấy' }, 404);
    await syncSingleTarget(target, env);
    return jsonResponse({ success: true });
  }

  // POST /api/targets/sync-all (Đồng bộ toàn bộ link đang hoạt động)
  if (pathname === '/api/targets/sync-all' && method === 'POST') {
    const targets = (await db.prepare("SELECT * FROM monitored_targets WHERE status != 'PAUSED' LIMIT 15").all())?.results || [];
    const results = [];
    for (const target of targets) {
      try {
        await syncSingleTarget(target, env);
        results.push({ id: target.id, success: true });
      } catch (err) {
        results.push({ id: target.id, success: false, error: err.message });
      }
    }
    return jsonResponse({ success: true, count: targets.length, results });
  }

  // GET /api/comparison (So sánh tương tác đối chiếu 2-4 nội dung - Prompt 04)
  if (pathname === '/api/comparison' && method === 'GET') {
    const idsParam = url.searchParams.get('ids') || '';
    const ids = idsParam.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean).slice(0, 4);
    const rangeParam = url.searchParams.get('range') || '24H';
    const modeParam = url.searchParams.get('mode') || 'ABSOLUTE_TIME';

    if (ids.length < 2) {
      return jsonResponse({
        status: 'INSUFFICIENT_POSTS',
        message: 'Cần chọn từ 2 đến 4 bài viết để thực hiện đối chiếu hiệu suất so sánh.',
        comparison: [],
        targets: [],
        engagement: [],
        reactionsBreakdown: [],
        growthSeries: [],
        timeBuckets: [],
        authenticity: [],
        accountOverlap: { pairs: [], commonAccounts: [] },
        performance: [],
        insights: []
      });
    }

    const rangeMsMap = {
      '5M': 5 * 60 * 1000,
      '15M': 15 * 60 * 1000,
      '30M': 30 * 60 * 1000,
      '1H': 60 * 60 * 1000,
      '3H': 3 * 3600 * 1000,
      '6H': 6 * 3600 * 1000,
      '12H': 12 * 3600 * 1000,
      '24H': 24 * 3600 * 1000,
      '7D': 7 * 24 * 3600 * 1000,
      '30D': 30 * 24 * 3600 * 1000
    };
    const durationMs = rangeMsMap[rangeParam] || (24 * 3600 * 1000);
    const cutoffTime = new Date(Date.now() - durationMs).toISOString();

    const targets = [];
    const snapshotsByTarget = {};
    const accountsByTarget = {};
    const alertsByTarget = {};
    const legacyComparison = [];

    for (const id of ids) {
      const target = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(id).first();
      if (!target) continue;
      targets.push(target);

      // Snapshots in cutoff
      let snaps = (await db.prepare(`
        SELECT observed_at, total_reactions, total_comments, total_shares,
               delta_reactions, delta_comments, delta_shares,
               like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count
        FROM snapshots
        WHERE target_id = ? AND observed_at >= ?
        ORDER BY observed_at ASC
        LIMIT 200
      `).bind(id, cutoffTime).all())?.results || [];

      if (snaps.length === 0) {
        const lastSnap = await db.prepare(`
          SELECT observed_at, total_reactions, total_comments, total_shares,
                 delta_reactions, delta_comments, delta_shares,
                 like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count
          FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1
        `).bind(id).first();

        if (lastSnap) {
          snaps = [lastSnap];
        } else {
          snaps = [{
            observed_at: target.last_checked_at || new Date().toISOString(),
            total_reactions: target.latest_reactions || 0,
            total_comments: target.latest_comments || 0,
            total_shares: target.latest_shares || 0,
            delta_reactions: 0, delta_comments: 0, delta_shares: 0,
            like_count: target.latest_reactions || 0,
            love_count: 0, care_count: 0, haha_count: 0, wow_count: 0, sad_count: 0, angry_count: 0
          }];
        }
      }

      snapshotsByTarget[id] = snaps;
      legacyComparison.push({ target, points: snaps });

      // Accounts
      const accounts = (await db.prepare(`
        SELECT target_id, fb_user_id, display_name, profile_url, avatar_url, interaction_type, reaction_type, comment_text, observed_at
        FROM accounts_interacted
        WHERE target_id = ?
        ORDER BY observed_at DESC
        LIMIT 100
      `).bind(id).all())?.results || [];
      accountsByTarget[id] = accounts;

      // Alerts
      const alerts = (await db.prepare(`
        SELECT id, target_id, alert_type, severity, message, delta, detected_at, acknowledged
        FROM alerts
        WHERE target_id = ? AND detected_at >= ?
        ORDER BY detected_at DESC
        LIMIT 50
      `).bind(id, cutoffTime).all())?.results || [];
      alertsByTarget[id] = alerts;
    }

    const analytics = computeComparisonAnalytics({
      targets,
      snapshotsByTarget,
      accountsByTarget,
      alertsByTarget,
      range: rangeParam,
      mode: modeParam
    });

    return jsonResponse({
      ...analytics,
      comparison: legacyComparison
    });
  }

  // GET /api/accounts
  if (pathname === '/api/accounts' && method === 'GET') {
    const rawAccounts = (await db.prepare('SELECT id, name, account_type, fb_account_id, proxy_url, scopes, status, expires_at, last_sync_at, error_log FROM accounts ORDER BY id DESC').all())?.results || [];
    const accounts = rawAccounts.map(a => ({
      ...a,
      proxy_url: maskProxyUrl(a.proxy_url)
    }));
    return jsonResponse({ accounts });
  }

  // POST /api/accounts/inspect-and-import (Meta OAuth Token)
  if (pathname === '/api/accounts/inspect-and-import' && method === 'POST') {
    const { token } = await request.json();
    if (!token) return jsonResponse({ error: 'Thiếu token' }, 400);

    const meRes = await fetch(`https://graph.facebook.com/${graphVersion}/me?fields=id,name&access_token=${token}`);
    const me = await meRes.json();
    if (me.error) return jsonResponse({ error: me.error.message }, 400);

    const permRes = await fetch(`https://graph.facebook.com/${graphVersion}/me/permissions?access_token=${token}`);
    const perms = (await permRes.json()).data || [];
    const grantedScopes = perms.filter(p => p.status === 'granted').map(p => p.permission).join(',');

    const now = new Date().toISOString();
    const encToken = await encryptToken(token, masterKey);

    await db.prepare(`
      INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, created_at)
      VALUES (?, 'user', ?, ?, ?, 'ACTIVE', ?)
      ON CONFLICT(fb_account_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, scopes = excluded.scopes, status = 'ACTIVE'
    `).bind(me.name, me.id, encToken, grantedScopes, now).run();

    const pagesRes = await fetch(`https://graph.facebook.com/${graphVersion}/me/accounts?fields=id,name,access_token&limit=100&access_token=${token}`);
    const pages = (await pagesRes.json()).data || [];

    for (const page of pages) {
      const pageEnc = await encryptToken(page.access_token, masterKey);
      await db.prepare(`
        INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, created_at)
        VALUES (?, 'page', ?, ?, ?, 'ACTIVE', ?)
        ON CONFLICT(fb_account_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, scopes = excluded.scopes, status = 'ACTIVE'
      `).bind(page.name, page.id, pageEnc, grantedScopes, now).run();
    }

    return jsonResponse({
      user: { id: me.id, name: me.name, grantedScopes: grantedScopes.split(',') },
      pagesCount: pages.length
    });
  }

  // POST /api/accounts/import-cookie (Nick Phụ / mbasic Scraper)
  if (pathname === '/api/accounts/import-cookie' && method === 'POST') {
    const { name, cookie } = await request.json();
    if (!cookie || typeof cookie !== 'string' || cookie.trim().length === 0) {
      return jsonResponse({ error: 'Cần cung cấp chuỗi Cookie Facebook' }, 400);
    }

    const cUser = extractCUser(cookie);
    const fbAccountId = cUser || `cookie_${Date.now()}`;
    const accountName = (name && name.trim()) ? name.trim() : `Cookie (${cUser || 'Clone'})`;
    const encCookie = await encryptToken(cookie.trim(), masterKey);
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, created_at)
      VALUES (?, 'cookie', ?, ?, 'mbasic', 'ACTIVE', ?)
      ON CONFLICT(fb_account_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, name = excluded.name, status = 'ACTIVE', error_log = NULL
    `).bind(accountName, fbAccountId, encCookie, now).run();

    // Tự động kích hoạt lại các link bị tạm ngưng do thiếu auth
    await db.prepare("UPDATE monitored_targets SET status = 'ACTIVE' WHERE status IN ('NEEDS_AUTH', 'DATA_LIMITED')").run();

    return jsonResponse({
      success: true,
      account: {
        name: accountName,
        account_type: 'cookie',
        fb_account_id: fbAccountId,
        status: 'ACTIVE'
      }
    });
  }

  // POST /api/accounts/:id/test-cookie (Kiểm tra sống/chết của Cookie)
  const testCookieMatch = pathname.match(/^\/api\/accounts\/(\d+)\/test-cookie$/);
  if (testCookieMatch && method === 'POST') {
    const id = parseInt(testCookieMatch[1], 10);
    const acc = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return jsonResponse({ error: 'Không tìm thấy tài khoản' }, 404);
    if (acc.account_type !== 'cookie') return jsonResponse({ error: 'Tài khoản này không phải dạng Cookie' }, 400);

    const cookie = await decryptToken(acc.encrypted_token, masterKey);
    if (!cookie) return jsonResponse({ error: 'Không thể giải mã cookie' }, 400);

    try {
      const res = await fetch('https://mbasic.facebook.com/me', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': cookie,
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate'
        }
      });
      const html = await res.text();

      if (isCheckpointOrLogin(res.url, html)) {
        await db.prepare("UPDATE accounts SET status = 'NEEDS_REAUTH', error_log = 'Cookie bị checkpoint hoặc hết hạn' WHERE id = ?").bind(id).run();
        return jsonResponse({
          valid: false,
          status: 'NEEDS_REAUTH',
          message: 'Cookie đã hết hạn hoặc bị Facebook yêu cầu xác minh checkpoint.'
        });
      }

      let liveName = acc.name;
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) {
        const titleText = titleMatch[1].replace(/\s*\|\s*Facebook$/i, '').trim();
        if (titleText && !titleText.includes('Facebook') && !titleText.includes('Đăng nhập') && !titleText.includes('Log in')) {
          liveName = titleText;
        }
      }

      const now = new Date().toISOString();
      await db.prepare("UPDATE accounts SET status = 'ACTIVE', name = ?, error_log = NULL, last_sync_at = ? WHERE id = ?").bind(liveName, now, id).run();

      return jsonResponse({
        valid: true,
        status: 'ACTIVE',
        name: liveName,
        message: 'Cookie hoạt động hoàn hảo! Đã kết nối mbasic thành công.'
      });
    } catch (e) {
      return jsonResponse({ valid: false, error: e.message }, 500);
    }
  }

  // DELETE /api/accounts/:id
  const accDeleteMatch = pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (accDeleteMatch && method === 'DELETE') {
    const id = parseInt(accDeleteMatch[1], 10);
    await db.prepare('UPDATE proxies SET bound_account_id = NULL WHERE bound_account_id = ?').bind(id).run();
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
  }

  // POST /api/accounts/:id/assign-proxy (Gán proxy độc lập cho từng account giữ phiên)
  const accProxyMatch = pathname.match(/^\/api\/accounts\/(\d+)\/assign-proxy$/);
  if (accProxyMatch && method === 'POST') {
    const id = parseInt(accProxyMatch[1], 10);
    const { proxy_url } = await request.json();
    await db.prepare('UPDATE accounts SET proxy_url = ? WHERE id = ?').bind(proxy_url || null, id).run();
    await db.prepare('UPDATE proxies SET bound_account_id = NULL WHERE bound_account_id = ?').bind(id).run();
    if (proxy_url) {
      await db.prepare('UPDATE proxies SET bound_account_id = ? WHERE raw_proxy = ? OR ? LIKE "%" || host || ":" || port || "%"').bind(id, proxy_url, proxy_url).run();
    }
    return jsonResponse({ success: true, proxy_url: maskProxyUrl(proxy_url) });
  }

  // GET /api/proxies (Danh sách pool proxy + account đang gán - Bảo mật: mask credentials)
  if (pathname === '/api/proxies' && method === 'GET') {
    const rawProxies = (await db.prepare(`
      SELECT p.id, p.raw_proxy, p.protocol, p.host, p.port, p.username, p.status, p.latency_ms, p.exit_ip, p.last_tested_at, p.bound_account_id, p.created_at, a.name as bound_account_name
      FROM proxies p
      LEFT JOIN accounts a ON a.id = p.bound_account_id
      ORDER BY p.id DESC
    `).all())?.results || [];
    const proxies = rawProxies.map(p => ({
      ...p,
      raw_proxy: maskProxyUrl(p.raw_proxy),
      password: '***'
    }));
    return jsonResponse({ proxies });
  }

  // POST /api/proxies/import (Nạp hàng loạt proxy mọi định dạng)
  if (pathname === '/api/proxies/import' && method === 'POST') {
    const { proxies = '' } = await request.json();
    const parsedList = parseBatchProxies(proxies);
    if (parsedList.length === 0) {
      return jsonResponse({ error: 'Không tìm thấy proxy hợp lệ. Hỗ trợ dạng ip:port:user:pass hoặc http://user:pass@ip:port' }, 400);
    }
    const now = new Date().toISOString();
    let imported = 0;
    for (const p of parsedList) {
      const res = await db.prepare(`
        INSERT INTO proxies (raw_proxy, protocol, host, port, username, password, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
        ON CONFLICT(raw_proxy) DO NOTHING
      `).bind(p.raw_proxy, p.protocol, p.host, p.port, p.username, p.password, now).run();
      if (res.meta.changes > 0) imported++;
    }
    return jsonResponse({
      success: true,
      imported,
      total: parsedList.length,
      message: `Đã nạp thành công ${imported} proxy mới vào hàng đợi test tự động.`
    });
  }

  // POST /api/proxies/request-test (Yêu cầu test lại toàn bộ hoặc 1 proxy)
  if (pathname === '/api/proxies/request-test' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.proxy_id) {
      await db.prepare("UPDATE proxies SET status = 'PENDING' WHERE id = ?").bind(body.proxy_id).run();
    } else {
      await db.prepare("UPDATE proxies SET status = 'PENDING'").run();
    }
    return jsonResponse({ success: true, message: 'Đã đưa proxy vào hàng đợi test kết nối' });
  }

  // POST /api/proxies/auto-assign (Tự động cấu hình độc lập mỗi account 1 proxy khác nhau)
  if (pathname === '/api/proxies/auto-assign' && method === 'POST') {
    const accounts = (await db.prepare("SELECT id, name FROM accounts WHERE account_type = 'cookie' AND status = 'ACTIVE' ORDER BY id ASC").all())?.results || [];
    let liveProxies = (await db.prepare("SELECT id, raw_proxy, protocol, host, port, username, password FROM proxies WHERE status = 'LIVE' ORDER BY latency_ms ASC, id ASC").all())?.results || [];
    if (liveProxies.length === 0) {
      // Fallback: nếu chưa test kịp, lấy proxies pending
      liveProxies = (await db.prepare("SELECT id, raw_proxy, protocol, host, port, username, password FROM proxies ORDER BY id ASC").all())?.results || [];
    }

    if (liveProxies.length === 0) {
      return jsonResponse({ error: 'Chưa có proxy nào trong danh sách. Hãy nạp proxy trước.' }, 400);
    }

    // Reset old bindings
    await db.prepare('UPDATE proxies SET bound_account_id = NULL').run();
    await db.prepare("UPDATE accounts SET proxy_url = NULL WHERE account_type = 'cookie'").run();

    const mappings = [];
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (i < liveProxies.length) {
        const p = liveProxies[i];
        const auth = p.username && p.password ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
        const proxyUrl = `${p.protocol}://${auth}${p.host}:${p.port}`;
        await db.prepare('UPDATE accounts SET proxy_url = ? WHERE id = ?').bind(proxyUrl, acc.id).run();
        await db.prepare('UPDATE proxies SET bound_account_id = ? WHERE id = ?').bind(acc.id, p.id).run();
        mappings.push({ account_id: acc.id, account_name: acc.name, proxy_id: p.id, proxy_url: maskProxyUrl(proxyUrl) });
      }
    }

    return jsonResponse({
      success: true,
      assigned_count: mappings.length,
      total_accounts: accounts.length,
      mappings,
      message: `Đã phân bổ 1:1 độc lập ${mappings.length} proxy cho ${accounts.length} tài khoản.`
    });
  }

  // DELETE /api/proxies/:id (Xóa proxy)
  const proxyDelMatch = pathname.match(/^\/api\/proxies\/(\d+)$/);
  if (proxyDelMatch && method === 'DELETE') {
    const id = parseInt(proxyDelMatch[1], 10);
    const p = await db.prepare('SELECT * FROM proxies WHERE id = ?').bind(id).first();
    if (p && p.bound_account_id) {
      await db.prepare('UPDATE accounts SET proxy_url = NULL WHERE id = ?').bind(p.bound_account_id).run();
    }
    await db.prepare('DELETE FROM proxies WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
  }

  // POST /api/sidecar/proxy-results (Nhận kết quả test từ Local Sidecar)
  if (pathname === '/api/sidecar/proxy-results' && method === 'POST') {
    const secret = request.headers.get('X-Sidecar-Secret');
    const body = await request.json();
    if (!secret || secret !== masterKey) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const { results = [] } = body;
    const now = new Date().toISOString();
    for (const r of results) {
      await db.prepare(`
        UPDATE proxies 
        SET status = ?, latency_ms = ?, exit_ip = ?, last_tested_at = ?
        WHERE id = ?
      `).bind(r.live ? 'LIVE' : 'DIE', r.latency_ms || 0, r.exit_ip || null, now, r.id).run();
    }
    return jsonResponse({ success: true, updated: results.length });
  }

  // GET /api/alerts (Nhật ký cảnh báo & Audit Trail - Prompt 05)
  if (pathname === '/api/alerts' && method === 'GET') {
    const status = url.searchParams.get('status');
    const read = url.searchParams.get('read');
    const severity = url.searchParams.get('severity');
    const alert_type = url.searchParams.get('alert_type');
    const group = url.searchParams.get('group');
    const target_id = url.searchParams.get('target_id');
    const search = url.searchParams.get('search');
    const timeframe = url.searchParams.get('timeframe') || 'ALL';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10)));
    const offset = (page - 1) * limit;

    let whereClause = ' WHERE 1=1';
    const params = [];

    if (read === 'unread') {
      whereClause += ' AND a.is_read = 0';
    } else if (read === 'read') {
      whereClause += ' AND a.is_read = 1';
    }

    if (status && status !== 'ALL') {
      whereClause += ' AND a.status = ?';
      params.push(status);
    }

    if (severity && severity !== 'ALL') {
      whereClause += ' AND a.severity = ?';
      params.push(severity);
    }

    if (alert_type && alert_type !== 'ALL') {
      whereClause += ' AND a.alert_type = ?';
      params.push(alert_type);
    }

    if (target_id && target_id !== 'ALL') {
      whereClause += ' AND a.target_id = ?';
      params.push(parseInt(target_id, 10));
    }

    if (group && group !== 'ALL') {
      if (group === 'interaction') {
        whereClause += " AND a.alert_type IN ('REACTION_SPIKE', 'LIKE_SPIKE', 'LOVE_SPIKE', 'CARE_SPIKE', 'HAHA_SPIKE', 'WOW_SPIKE', 'SAD_SPIKE', 'ANGRY_SPIKE', 'COMMENT_SURGE', 'COMMENT_SPIKE', 'SHARE_BURST', 'SHARE_SPIKE', 'VIRAL_SHIFT', 'ENGAGEMENT_DROP', 'ENGAGEMENT_MILESTONE')";
      } else if (group === 'suspicious') {
        whereClause += " AND a.alert_type IN ('SUSPICIOUS_GROWTH', 'UNUSUAL_ENGAGEMENT_RATE', 'REPEATED_COMMENT_PATTERN', 'ANOMALY_DETECTED', 'GROWTH_ANOMALY', 'SUSPICIOUS_PATTERN')";
      } else if (group === 'monitor') {
        whereClause += " AND a.alert_type IN ('MONITOR_STARTED', 'MONITOR_PAUSED', 'MONITOR_RESUMED', 'MONITOR_STOPPED', 'MONITOR_ERROR', 'SYNC_FAILED', 'SYNC_RECOVERED', 'SYNC_TIMEOUT')";
      } else if (group === 'connection') {
        whereClause += " AND a.alert_type IN ('AUTH_LOST', 'TOKEN_EXPIRED', 'PERMISSION_REQUIRED', 'API_RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'CONNECTION_FAILED', 'CONNECTION_RESTORED')";
      } else if (group === 'system') {
        whereClause += " AND a.alert_type IN ('SYSTEM_WARNING', 'SCHEDULER_DELAYED', 'QUEUE_BACKLOG', 'DATA_COLLECTION_DELAYED', 'DELIVERY_FAILED')";
      }
    }

    if (search && search.trim()) {
      const trimmed = search.trim();
      const numMatch = trimmed.match(/^#?ALT-(\d+)$/i) || trimmed.match(/^(\d+)$/);
      if (numMatch) {
        whereClause += ' AND (a.id = ? OR a.message LIKE ? OR a.alert_type LIKE ? OR t.author_name LIKE ? OR t.normalized_url LIKE ?)';
        const idVal = parseInt(numMatch[1], 10);
        const term = `%${trimmed}%`;
        params.push(idVal, term, term, term, term);
      } else {
        whereClause += ' AND (a.message LIKE ? OR a.alert_type LIKE ? OR t.author_name LIKE ? OR t.normalized_url LIKE ?)';
        const term = `%${trimmed}%`;
        params.push(term, term, term, term);
      }
    }

    const msMap = {
      '15M': 15 * 60 * 1000,
      '30M': 30 * 60 * 1000,
      '1H': 60 * 60 * 1000,
      '3H': 3 * 3600 * 1000,
      '6H': 6 * 3600 * 1000,
      '12H': 12 * 3600 * 1000,
      '24H': 24 * 3600 * 1000,
      '7D': 7 * 24 * 60 * 60 * 1000,
      '30D': 30 * 24 * 60 * 60 * 1000
    };
    if (timeframe && timeframe !== 'ALL' && msMap[timeframe]) {
      const cutoff = new Date(Date.now() - msMap[timeframe]).toISOString();
      whereClause += ' AND a.detected_at >= ?';
      params.push(cutoff);
    }

    const countSql = `SELECT COUNT(*) as count FROM alerts a JOIN monitored_targets t ON t.id = a.target_id ${whereClause}`;
    const totalCount = (await db.prepare(countSql).bind(...params).first())?.count || 0;

    const sql = `
      SELECT a.*, t.author_name, t.author_avatar, t.post_image, t.normalized_url, t.target_type
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ${whereClause}
      ORDER BY a.detected_at DESC
      LIMIT ? OFFSET ?
    `;
    const alerts = (await db.prepare(sql).bind(...params, limit, offset).all())?.results || [];

    // 5 Professional Alert KPIs (Section III.2)
    const totalAlerts = (await db.prepare('SELECT COUNT(*) as count FROM alerts').first())?.count || 0;
    const openAlerts = (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status = 'OPEN'").first())?.count || 0;
    const criticalAlerts = (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE severity = 'CRITICAL' AND status != 'RESOLVED'").first())?.count || 0;
    const resolvedAlerts = (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status = 'RESOLVED'").first())?.count || 0;
    const anomalyAlerts = (await db.prepare(`
      SELECT COUNT(*) as count FROM alerts 
      WHERE alert_type IN ('SUSPICIOUS_GROWTH', 'UNUSUAL_ENGAGEMENT_RATE', 'REPEATED_COMMENT_PATTERN', 'ANOMALY_DETECTED', 'VIRAL_SHIFT', 'GROWTH_ANOMALY', 'SUSPICIOUS_PATTERN')
    `).first())?.count || 0;
    const unreadCount = (await db.prepare('SELECT COUNT(*) as count FROM alerts WHERE is_read = 0').first())?.count || 0;

    // Timeline distribution (Section VI)
    const timelineCutoff = new Date(Date.now() - (msMap[timeframe] || 24 * 3600 * 1000)).toISOString();
    const rawTimeline = (await db.prepare(`
      SELECT 
        strftime('%Y-%m-%d %H:00', detected_at) as bucket,
        COUNT(*) as total,
        SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity = 'WARNING' THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN severity = 'INFO' THEN 1 ELSE 0 END) as info
      FROM alerts
      WHERE detected_at >= ?
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 30
    `).bind(timelineCutoff).all())?.results || [];

    const timeline = rawTimeline.map(r => ({
      bucket: r.bucket,
      label: r.bucket ? r.bucket.slice(11, 16) : '00:00',
      total: r.total || 0,
      critical: r.critical || 0,
      warning: r.warning || 0,
      info: r.info || 0
    }));

    // Alert Analytics (Section X)
    const topTypes = (await db.prepare(`
      SELECT alert_type, COUNT(*) as count
      FROM alerts
      GROUP BY alert_type
      ORDER BY count DESC
      LIMIT 5
    `).all())?.results || [];

    const topTargets = (await db.prepare(`
      SELECT t.id, t.author_name, COUNT(*) as alert_count
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      GROUP BY t.id
      ORDER BY alert_count DESC
      LIMIT 5
    `).all())?.results || [];

    const resolutionRate = totalAlerts > 0 ? parseFloat(((resolvedAlerts / totalAlerts) * 100).toFixed(1)) : 100.0;

    return jsonResponse({
      alerts,
      totalCount,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      kpi: {
        totalAlerts,
        openAlerts,
        criticalAlerts,
        resolvedAlerts,
        anomalyAlerts,
        totalNotifications: totalAlerts,
        unreadCount
      },
      timeline,
      analytics: {
        bySeverity: {
          CRITICAL: criticalAlerts,
          WARNING: (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE severity = 'WARNING'").first())?.count || 0,
          INFO: (await db.prepare("SELECT COUNT(*) as count FROM alerts WHERE severity = 'INFO'").first())?.count || 0
        },
        topTypes,
        topTargets,
        resolutionRate
      }
    });
  }

  // Deep Alert Detail with Evidence & Audit Trail (Section VII & VIII)
  const alertDetailMatch = pathname.match(/^\/api\/alerts\/(\d+)$/);
  if (alertDetailMatch && method === 'GET') {
    const id = parseInt(alertDetailMatch[1], 10);
    const alert = await db.prepare(`
      SELECT a.*, t.author_name, t.author_avatar, t.post_image, t.normalized_url, t.target_type, t.status as target_status, t.check_interval_sec
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      WHERE a.id = ?
    `).bind(id).first();
    if (!alert) return jsonResponse({ error: 'Không tìm thấy cảnh báo' }, 404);

    // Retrieve Audit Trail (Section IX)
    let auditLogs = [];
    try {
      auditLogs = (await db.prepare(`
        SELECT * FROM alert_audit_logs 
        WHERE alert_id = ? 
        ORDER BY created_at ASC
      `).bind(id).all())?.results || [];
    } catch {}

    if (auditLogs.length === 0) {
      auditLogs.push({
        id: 0,
        alert_id: id,
        action_type: 'TRIGGERED',
        actor: 'System / AlertEngine',
        previous_status: null,
        new_status: 'OPEN',
        notes: alert.message,
        created_at: alert.detected_at
      });
    }

    // Retrieve Snapshots for Evidence (Section VIII)
    const beforeSnapshot = await db.prepare(`
      SELECT id, observed_at, total_reactions, total_comments, total_shares, source_type
      FROM snapshots 
      WHERE target_id = ? AND observed_at <= ? 
      ORDER BY observed_at DESC LIMIT 1
    `).bind(alert.target_id, alert.detected_at).first();

    const afterSnapshot = await db.prepare(`
      SELECT id, observed_at, total_reactions, total_comments, total_shares, source_type
      FROM snapshots 
      WHERE target_id = ? AND observed_at >= ? 
      ORDER BY observed_at ASC LIMIT 1
    `).bind(alert.target_id, alert.detected_at).first();

    let rule = null;
    if (alert.rule_id) {
      rule = await db.prepare('SELECT * FROM alert_rules WHERE id = ?').bind(alert.rule_id).first();
    }

    const relatedAlerts = (await db.prepare(`
      SELECT id, alert_type, severity, message, detected_at, status 
      FROM alerts 
      WHERE target_id = ? AND id != ? 
      ORDER BY detected_at DESC LIMIT 5
    `).bind(alert.target_id, id).all())?.results || [];

    return jsonResponse({
      alert,
      auditLogs,
      evidence: {
        beforeSnapshot: beforeSnapshot || null,
        afterSnapshot: afterSnapshot || null,
        sourceType: alert.source_type || 'mbasic/comet',
        evidenceStatus: alert.evidence_status || 'VERIFIED',
        ruleVersion: alert.rule_version || 'v1.0',
        detectionVersion: alert.detection_version || 'v2.1',
        rule
      },
      relatedAlerts
    });
  }

  // PATCH /api/alerts/:id/read
  const alertReadMatch = pathname.match(/^\/api\/alerts\/(\d+)\/read$/);
  if (alertReadMatch && method === 'PATCH') {
    const id = parseInt(alertReadMatch[1], 10);
    const now = new Date().toISOString();
    await db.prepare('UPDATE alerts SET is_read = 1, read_at = ? WHERE id = ?').bind(now, id).run();
    return jsonResponse({ success: true, id, is_read: 1, read_at: now });
  }

  // PATCH /api/alerts/:id/unread
  const alertUnreadMatch = pathname.match(/^\/api\/alerts\/(\d+)\/unread$/);
  if (alertUnreadMatch && method === 'PATCH') {
    const id = parseInt(alertUnreadMatch[1], 10);
    await db.prepare('UPDATE alerts SET is_read = 0, read_at = NULL WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true, id, is_read: 0 });
  }

  // POST /api/alerts/read-all
  if (pathname === '/api/alerts/read-all' && method === 'POST') {
    const now = new Date().toISOString();
    await db.prepare('UPDATE alerts SET is_read = 1, read_at = ? WHERE is_read = 0').bind(now).run();
    return jsonResponse({ success: true });
  }

  // PATCH /api/alerts/:id/ack (Acknowledge alert with Audit Log)
  const alertAckMatch = pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
  if (alertAckMatch && method === 'PATCH') {
    const id = parseInt(alertAckMatch[1], 10);
    const now = new Date().toISOString();
    let body = {};
    try { body = await request.json(); } catch {}
    const actor = body.actor || 'Admin / Operator';
    const notes = body.notes || 'Đã tiếp nhận cảnh báo để theo dõi';

    const prev = await db.prepare('SELECT status FROM alerts WHERE id = ?').bind(id).first();
    const prevStatus = prev?.status || 'OPEN';

    await db.prepare("UPDATE alerts SET acknowledged = 1, status = 'ACKNOWLEDGED', acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").bind(now, id).run();

    try {
      await db.prepare(`
        INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
        VALUES (?, 'ACKNOWLEDGE', ?, ?, 'ACKNOWLEDGED', ?, ?)
      `).bind(id, actor, prevStatus, notes, now).run();
    } catch {}

    return jsonResponse({ success: true, id, status: 'ACKNOWLEDGED', acknowledged: 1, acknowledged_at: now });
  }

  // PATCH /api/alerts/:id/resolve (Resolve alert with Audit Log)
  const alertResolveMatch = pathname.match(/^\/api\/alerts\/(\d+)\/resolve$/);
  if (alertResolveMatch && method === 'PATCH') {
    const id = parseInt(alertResolveMatch[1], 10);
    const now = new Date().toISOString();
    let body = {};
    try { body = await request.json(); } catch {}
    const actor = body.actor || 'Admin / Operator';
    const notes = body.notes || 'Đã kiểm tra và xử lý xong';

    const prev = await db.prepare('SELECT status FROM alerts WHERE id = ?').bind(id).first();
    const prevStatus = prev?.status || 'OPEN';

    await db.prepare("UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution_notes = ? WHERE id = ?").bind(now, actor, notes, id).run();

    try {
      await db.prepare(`
        INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
        VALUES (?, 'RESOLVE', ?, ?, 'RESOLVED', ?, ?)
      `).bind(id, actor, prevStatus, notes, now).run();
    } catch {}

    return jsonResponse({ success: true, id, status: 'RESOLVED', resolved_at: now, resolved_by: actor });
  }

  // PATCH /api/alerts/:id/reopen (Reopen alert with Audit Log)
  const alertReopenMatch = pathname.match(/^\/api\/alerts\/(\d+)\/reopen$/);
  if (alertReopenMatch && method === 'PATCH') {
    const id = parseInt(alertReopenMatch[1], 10);
    const now = new Date().toISOString();
    let body = {};
    try { body = await request.json(); } catch {}
    const actor = body.actor || 'Admin / Operator';
    const notes = body.notes || 'Mở lại cảnh báo';

    const prev = await db.prepare('SELECT status FROM alerts WHERE id = ?').bind(id).first();
    const prevStatus = prev?.status || 'RESOLVED';

    await db.prepare("UPDATE alerts SET status = 'OPEN', resolved_at = NULL, resolution_notes = NULL WHERE id = ?").bind(id).run();

    try {
      await db.prepare(`
        INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
        VALUES (?, 'REOPEN', ?, ?, 'OPEN', ?, ?)
      `).bind(id, actor, prevStatus, notes, now).run();
    } catch {}

    return jsonResponse({ success: true, id, status: 'OPEN' });
  }

  // POST /api/alerts/:id/notes (Add Note to Audit Trail)
  const alertNotesMatch = pathname.match(/^\/api\/alerts\/(\d+)\/notes$/);
  if (alertNotesMatch && method === 'POST') {
    const id = parseInt(alertNotesMatch[1], 10);
    const now = new Date().toISOString();
    let body = {};
    try { body = await request.json(); } catch {}
    const actor = body.actor || 'Admin / Operator';
    const notes = (body.notes || '').trim();
    if (!notes) return jsonResponse({ error: 'Nội dung ghi chú không được để trống' }, 400);

    const prev = await db.prepare('SELECT status FROM alerts WHERE id = ?').bind(id).first();

    try {
      await db.prepare(`
        INSERT INTO alert_audit_logs (alert_id, action_type, actor, previous_status, new_status, notes, created_at)
        VALUES (?, 'ADD_NOTE', ?, ?, ?, ?, ?)
      `).bind(id, actor, prev?.status || 'OPEN', prev?.status || 'OPEN', notes, now).run();
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }

    return jsonResponse({ success: true, id, created_at: now });
  }

  // DELETE /api/alerts/:id
  if (alertDetailMatch && method === 'DELETE') {
    const id = parseInt(alertDetailMatch[1], 10);
    await db.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true, id });
  }

  // GET /api/alert-rules
  if (pathname === '/api/alert-rules' && method === 'GET') {
    const rules = (await db.prepare(`
      SELECT r.*, t.author_name as target_name, t.normalized_url as target_url
      FROM alert_rules r
      LEFT JOIN monitored_targets t ON t.id = r.target_id
      ORDER BY r.id DESC
    `).all())?.results || [];
    return jsonResponse({ rules });
  }

  // POST /api/alert-rules
  if (pathname === '/api/alert-rules' && method === 'POST') {
    const body = await request.json();
    const { targetId, name, metric, condition, threshold, timeWindow, severity, cooldownSec, channels } = body;
    if (!name || !metric || threshold === undefined) {
      return jsonResponse({ error: 'Thiếu thông tin cấu hình quy tắc bắt buộc' }, 400);
    }
    const now = new Date().toISOString();
    const channelsStr = typeof channels === 'string' ? channels : JSON.stringify(channels || ['in_app']);
    const res = await db.prepare(`
      INSERT INTO alert_rules (
        target_id, name, metric, condition, threshold, time_window, severity, cooldown_sec, is_active, channels, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      targetId || null,
      name,
      metric,
      condition || 'gt_count',
      parseFloat(threshold),
      timeWindow || '5M',
      severity || 'WARNING',
      parseInt(cooldownSec || 300, 10),
      channelsStr,
      now
    ).run();
    return jsonResponse({ success: true, id: res.meta?.last_row_id });
  }

  // PATCH /api/alert-rules/:id
  const ruleMatch = pathname.match(/^\/api\/alert-rules\/(\d+)$/);
  if (ruleMatch && method === 'PATCH') {
    const id = parseInt(ruleMatch[1], 10);
    const body = await request.json();
    const { name, metric, condition, threshold, timeWindow, severity, cooldownSec, isActive, channels } = body;
    
    await db.prepare(`
      UPDATE alert_rules
      SET name = COALESCE(?, name),
          metric = COALESCE(?, metric),
          condition = COALESCE(?, condition),
          threshold = COALESCE(?, threshold),
          time_window = COALESCE(?, time_window),
          severity = COALESCE(?, severity),
          cooldown_sec = COALESCE(?, cooldown_sec),
          is_active = COALESCE(?, is_active),
          channels = COALESCE(?, channels)
      WHERE id = ?
    `).bind(
      name || null,
      metric || null,
      condition || null,
      threshold !== undefined ? parseFloat(threshold) : null,
      timeWindow || null,
      severity || null,
      cooldownSec !== undefined ? parseInt(cooldownSec, 10) : null,
      isActive !== undefined ? (isActive ? 1 : 0) : null,
      channels !== undefined ? (typeof channels === 'string' ? channels : JSON.stringify(channels)) : null,
      id
    ).run();
    return jsonResponse({ success: true, id });
  }

  // DELETE /api/alert-rules/:id
  if (ruleMatch && method === 'DELETE') {
    const id = parseInt(ruleMatch[1], 10);
    await db.prepare('DELETE FROM alert_rules WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true, id });
  }

  // GET /api/settings (Tầng 3: Cấu hình Proxy Dân cư & Sidecar)
  if (pathname === '/api/settings' && method === 'GET') {
    const rows = (await db.prepare('SELECT key, value FROM system_settings').all())?.results || [];
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    return jsonResponse({ settings });
  }

  // POST /api/settings
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await request.json();
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(body)) {
      await db.prepare(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(key, String(value || ''), now).run();
    }
    return jsonResponse({ success: true });
  }

  // GET /api/sidecar/tasks (Local Node.js Sidecar fetch việc cào trên IP máy nhà)
  if (pathname === '/api/sidecar/tasks' && method === 'GET') {
    const secret = request.headers.get('X-Sidecar-Secret');
    if (!secret || secret !== masterKey) {
      return jsonResponse({ error: 'Mã bí mật xác thực Sidecar không hợp lệ (yêu cầu header X-Sidecar-Secret)' }, 401);
    }

    const rawTargets = (await db.prepare("SELECT * FROM monitored_targets WHERE status != 'PAUSED' ORDER BY priority DESC LIMIT 20").all())?.results || [];
    const targets = await Promise.all(rawTargets.map(async t => {
      const lastValid = await db.prepare(`
        SELECT total_reactions, total_comments, total_shares 
        FROM snapshots 
        WHERE target_id = ? AND (total_reactions > 0 OR total_comments > 0 OR total_shares > 0)
        ORDER BY observed_at DESC LIMIT 1
      `).bind(t.id).first();
      return {
        ...t,
        last_valid_reactions: Math.max(t.latest_reactions || 0, lastValid?.total_reactions || 0),
        last_valid_comments: Math.max(t.latest_comments || 0, lastValid?.total_comments || 0),
        last_valid_shares: Math.max(t.latest_shares || 0, lastValid?.total_shares || 0)
      };
    }));
    const allCookieAccounts = (await db.prepare("SELECT id, name, encrypted_token, proxy_url FROM accounts WHERE account_type = 'cookie' AND status = 'ACTIVE' ORDER BY last_sync_at ASC").all())?.results || [];
    const accounts = await Promise.all(allCookieAccounts.map(async a => ({
      id: a.id,
      name: a.name,
      cookie: await decryptToken(a.encrypted_token, masterKey),
      proxy_url: a.proxy_url
    })));

    const cookieAcc = allCookieAccounts[0] || null;
    const cookie = cookieAcc ? await decryptToken(cookieAcc.encrypted_token, masterKey) : null;
    const proxyRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'residential_proxy_url'").first();

    const proxiesToTest = (await db.prepare("SELECT id, raw_proxy, protocol, host, port, username, password FROM proxies WHERE status = 'PENDING' LIMIT 20").all())?.results || [];

    return jsonResponse({
      targets,
      accounts,
      proxiesToTest,
      cookie,
      proxyUrl: cookieAcc?.proxy_url || proxyRow?.value || null
    });
  }

  // POST /api/sidecar/push-snapshot (Nhận snapshot từ Local Sidecar cào qua IP dân cư thật)
  if (pathname === '/api/sidecar/push-snapshot' && method === 'POST') {
    const secret = request.headers.get('X-Sidecar-Secret');
    const body = await request.json();
    if (!secret || secret !== masterKey) {
      return jsonResponse({ error: 'Không có quyền truy cập (Invalid Sidecar Secret)' }, 401);
    }

    const {
      target_id,
      total_reactions = 0,
      reactions = {},
      total_comments = 0,
      total_shares = 0,
      author_name = null,
      author_avatar = null,
      post_image = null,
      content_snippet = null,
      interacted_accounts = []
    } = body;

    const now = new Date().toISOString();
    const target = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(target_id).first();
    if (!target) return jsonResponse({ error: 'Target không tồn tại' }, 404);

    const lastSnap = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1').bind(target_id).first();
    const lastValidSnap = await db.prepare(`
      SELECT * FROM snapshots 
      WHERE target_id = ? AND (total_reactions > 0 OR total_comments > 0 OR total_shares > 0)
      ORDER BY observed_at DESC LIMIT 1
    `).bind(target_id).first();

    const baselineRx = Math.max(lastValidSnap?.total_reactions || 0, target.latest_reactions || 0);
    const baselineCmt = Math.max(lastValidSnap?.total_comments || 0, target.latest_comments || 0);
    const baselineSh = Math.max(lastValidSnap?.total_shares || 0, target.latest_shares || 0);

    // Comprehensive Data Quality Gate: Guard against zero metric drops & sharp negative drops across all metrics
    if (baselineRx > 0 || baselineCmt > 0 || baselineSh > 0) {
      const rxDroppedToZero = baselineRx > 5 && total_reactions === 0;
      const cmtDroppedToZero = baselineCmt > 5 && total_comments === 0;
      const shDroppedToZero = baselineSh > 5 && total_shares === 0;
      const allZeroDrop = total_reactions === 0 && total_comments === 0 && total_shares === 0;

      if (rxDroppedToZero || cmtDroppedToZero || shDroppedToZero || allZeroDrop) {
        await db.prepare("UPDATE monitored_targets SET last_checked_at = ?, last_error = 'Sidecar gửi snapshot sụt giảm về 0 (Quality Gate bảo lưu baseline)' WHERE id = ?").bind(now, target_id).run();
        return jsonResponse({ warning: 'Bảo lưu baseline do số liệu sụt giảm về 0 bất thường', target_id, baseline: { reactions: baselineRx, comments: baselineCmt, shares: baselineSh } });
      }

      const rxSharpDrop = baselineRx > 20 && total_reactions < baselineRx * 0.4;
      const cmtSharpDrop = baselineCmt > 20 && total_comments < baselineCmt * 0.4;
      const shSharpDrop = baselineSh > 20 && total_shares < baselineSh * 0.4;

      if (rxSharpDrop || cmtSharpDrop || shSharpDrop) {
        await db.prepare("UPDATE monitored_targets SET last_checked_at = ?, last_error = 'Phát hiện số liệu giảm đột ngột >60% từ Sidecar (Quality Gate bảo lưu baseline)' WHERE id = ?").bind(now, target_id).run();
        return jsonResponse({ warning: 'Bảo lưu baseline do số liệu giảm bất thường', target_id });
      }
    }

    const prevSnap = lastValidSnap || lastSnap;
    const deltaRx = prevSnap ? (total_reactions - prevSnap.total_reactions) : 0;
    const deltaCmt = prevSnap ? (total_comments - prevSnap.total_comments) : 0;
    const deltaSh = prevSnap ? (total_shares - prevSnap.total_shares) : 0;

    const rx = { like: total_reactions, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0, ...reactions };

    const evidencePayload = JSON.stringify({
      source: 'LOCAL_SIDECAR',
      target_id,
      author: author_name,
      content_snippet,
      evidence_hash: await computeEvidenceHash((author_name || '') + ':' + total_reactions + ':' + total_comments),
      metrics: {
        reactions: total_reactions,
        comments: total_comments,
        shares: total_shares,
        reactions_breakdown: reactions
      },
      verified_at: now
    });

    const snapValues = [
      target_id, now,
      total_reactions,
      rx.like || 0, rx.love || 0, rx.care || 0, rx.haha || 0, rx.wow || 0, rx.sad || 0, rx.angry || 0,
      total_comments, total_shares,
      deltaRx, deltaCmt, deltaSh,
      evidencePayload
    ];

    const snapRes = await db.prepare(`
      INSERT INTO snapshots (
        target_id, observed_at, source_type,
        total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
        total_comments, total_shares, delta_reactions, delta_comments, delta_shares, raw_json
      ) VALUES (?, ?, 'LOCAL_SIDECAR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...snapValues).run();

    await db.prepare(`
      UPDATE monitored_targets
      SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
          author_name = COALESCE(?, author_name),
          author_avatar = COALESCE(?, author_avatar),
          post_image = COALESCE(?, post_image),
          content_snippet = COALESCE(?, content_snippet),
          last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
      WHERE id = ?
    `).bind(total_reactions, total_comments, total_shares, author_name, author_avatar, post_image, content_snippet, now, target_id).run();

    // Insert interacted accounts with deduplication
    if (Array.isArray(interacted_accounts) && interacted_accounts.length > 0) {
      for (const item of interacted_accounts.slice(0, 50)) {
        const dName = item.display_name || item.displayName || 'Người dùng Facebook';
        const iType = item.interaction_type || item.interactionType || 'COMMENT';
        const rType = item.reaction_type || item.reactionType || null;
        const cText = item.comment_text || item.commentText || null;
        const pUrl = item.profile_url || item.profileUrl || null;
        const aUrl = item.avatar_url || item.avatarUrl || null;
        const fbUid = item.fb_user_id || item.fbUserId || null;

        const existing = await db.prepare(`
          SELECT id FROM accounts_interacted 
          WHERE target_id = ? AND display_name = ? AND interaction_type = ? 
            AND (comment_text = ? OR (comment_text IS NULL AND ? IS NULL))
            AND (reaction_type = ? OR (reaction_type IS NULL AND ? IS NULL))
          LIMIT 1
        `).bind(target_id, dName, iType, cText, cText, rType, rType).first();

        if (!existing) {
          await db.prepare(`
            INSERT INTO accounts_interacted (
              target_id, fb_user_id, display_name, profile_url, avatar_url,
              interaction_type, reaction_type, comment_text, observed_at, data_completeness
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FULL')
          `).bind(
            target_id,
            fbUid,
            dName,
            pUrl,
            aUrl,
            iType,
            rType,
            cText,
            now
          ).run();
        } else if (pUrl || aUrl || fbUid) {
          await db.prepare(`
            UPDATE accounts_interacted SET
              profile_url = COALESCE(?, profile_url),
              avatar_url = COALESCE(?, avatar_url),
              fb_user_id = COALESCE(?, fb_user_id)
            WHERE id = ?
          `).bind(pUrl, aUrl, fbUid, existing.id).run();
        }
      }
    }

    // Update sidecar heartbeat in system_settings
    await db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('sidecar_last_ping', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(now, now).run();

    return jsonResponse({ success: true, target_id, snapshot_id: snapRes.meta?.last_row_id });
  }

  // GET /api/health - Dynamic, Honest System Health & Data Integrity Check
  if (pathname === '/api/health' && method === 'GET') {
    const totalTargets = (await db.prepare('SELECT COUNT(*) as count FROM monitored_targets').first())?.count || 0;
    const activeTargets = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status = 'ACTIVE'").first())?.count || 0;
    const failingTargets = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE status IN ('ERROR', 'INACCESSIBLE', 'NEEDS_AUTH', 'RATE_LIMITED')").first())?.count || 0;
    const targetsWithErrors = (await db.prepare("SELECT COUNT(*) as count FROM monitored_targets WHERE last_error IS NOT NULL AND status != 'PAUSED'").first())?.count || 0;

    // Detect zero-streak targets: active targets that have past baseline or history but are currently 0
    const zeroStreakTargets = (await db.prepare(`
      SELECT COUNT(*) as count FROM monitored_targets 
      WHERE (latest_reactions = 0 AND latest_comments = 0 AND latest_shares = 0)
        AND (baseline_reactions > 0 OR baseline_comments > 0 OR baseline_shares > 0 OR id IN (
          SELECT DISTINCT target_id FROM snapshots WHERE total_reactions > 0 OR total_comments > 0
        ))
    `).first())?.count || 0;
    
    const activeAccounts = (await db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'ACTIVE'").first())?.count || 0;
    const checkpointAccounts = (await db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status IN ('CHECKPOINT', 'NEEDS_REAUTH', 'EXPIRED')").first())?.count || 0;
    
    const latestSnap = await db.prepare("SELECT observed_at FROM snapshots ORDER BY observed_at DESC LIMIT 1").first();
    const lastSnapshotAgeSec = latestSnap?.observed_at ? Math.floor((Date.now() - new Date(latestSnap.observed_at).getTime()) / 1000) : null;

    // Check for negative delta anomalies in the last 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const anomalyCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM snapshots 
      WHERE observed_at >= ? AND (delta_reactions < -5 OR delta_comments < -5 OR delta_shares < -5)
    `).bind(twoHoursAgo).first())?.count || 0;

    let overallStatus = 'HEALTHY';
    let message = 'Hệ thống giám sát vận hành bình thường';

    if (totalTargets > 0 && activeAccounts === 0) {
      overallStatus = 'CRITICAL_NO_AUTH';
      message = 'Toàn bộ tài khoản Cookie/Meta đã hết hạn hoặc checkpoint. Cần nạp tài khoản mới.';
    } else if (checkpointAccounts > 0 && activeAccounts === 0) {
      overallStatus = 'CRITICAL_NO_AUTH';
      message = 'Tất cả Cookie nick phụ đã hết hạn phiên (NEEDS_REAUTH). Cần cập nhật cookie mới.';
    } else if (totalTargets > 0 && failingTargets === totalTargets) {
      overallStatus = 'UNHEALTHY';
      message = 'Tất cả bài viết đang gặp lỗi kết nối hoặc thiếu quyền truy cập.';
    } else if (zeroStreakTargets > 0) {
      overallStatus = 'DEGRADED';
      message = `Phát hiện ${zeroStreakTargets} bài viết bị kẹt ở mức 0 tương tác (cần kiểm tra quyền truy cập hoặc Cookie).`;
    } else if (failingTargets > 0 || checkpointAccounts > 0 || targetsWithErrors > 0) {
      overallStatus = 'DEGRADED';
      message = `Hệ thống ghi nhận ${targetsWithErrors || failingTargets} bài viết có cảnh báo lỗi hoặc ${checkpointAccounts} tài khoản cần xác thực lại.`;
    } else if (anomalyCount > 0) {
      overallStatus = 'DEGRADED';
      message = `Phát hiện ${anomalyCount} snapshot có delta âm trong 2h gần nhất (đang được Quality Gate cách ly).`;
    }

    return jsonResponse({
      status: overallStatus,
      message,
      integrity: {
        totalTargets,
        activeTargets,
        failingTargets,
        targetsWithErrors,
        zeroStreakTargets,
        activeAccounts,
        checkpointAccounts,
        anomalyCount,
        lastSnapshotAt: latestSnap?.observed_at || null,
        lastSnapshotAgeSec,
        dataFreshness: lastSnapshotAgeSec !== null && lastSnapshotAgeSec < 300 ? 'FRESH' : 'STALE',
        dataTrustStatus: (checkpointAccounts > 0 || zeroStreakTargets > 0 || anomalyCount > 0) ? 'DEGRADED_TRUST' : 'HIGH_CONFIDENCE'
      },
      platform: 'Cloudflare Edge 24/7',
      timestamp: new Date().toISOString()
    }, (overallStatus === 'CRITICAL_NO_AUTH' || overallStatus === 'UNHEALTHY') ? 503 : 200);
  }

  return jsonResponse({ error: 'Endpoint not found' }, 404);
}

// --- 24/7 Background Scheduler Execution on Cloudflare Edge ---
async function runScheduledMonitoringTick(env) {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  // Find due targets (priority queue)
  const dueTargets = (await db.prepare(`
    SELECT * FROM monitored_targets
    WHERE status != 'PAUSED'
      AND (
        last_checked_at IS NULL
        OR (strftime('%s', ?) - strftime('%s', last_checked_at)) >= check_interval_sec
      )
    ORDER BY priority DESC, last_checked_at ASC
    LIMIT 5
  `).bind(nowIso).all())?.results || [];

  for (const target of dueTargets) {
    try {
      await syncSingleTarget(target, env);
    } catch (e) {
      console.error(`Lỗi scheduler sync target #${target.id}:`, e.message);
    }
  }
}

// Helper: Query Meta Graph API (owned posts) or fallback to mbasic (3rd-party public links)
async function syncSingleTarget(target, env) {
  const db = env.DB;
  const masterKey = env.ENCRYPTION_MASTER_KEY || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const graphVersion = env.META_GRAPH_VERSION || 'v21.0';

  // 1. TẦNG 3: Ưu tiên tuyệt đối Meta Graph API cho nội dung Fanpage
  let token = null;

  if (target.bound_account_id) {
    const acc = await db.prepare('SELECT encrypted_token, status, account_type FROM accounts WHERE id = ?').bind(target.bound_account_id).first();
    if (acc && acc.status === 'ACTIVE' && acc.account_type !== 'cookie') {
      token = await decryptToken(acc.encrypted_token, masterKey);
    }
  }

  // Tự động rà soát & bind Page Token nếu bài viết thuộc Fanpage đang kết nối
  if (!token) {
    const pages = (await db.prepare("SELECT id, name, fb_account_id, encrypted_token FROM accounts WHERE status = 'ACTIVE' AND account_type = 'page'").all())?.results || [];
    for (const p of pages) {
      if (
        (p.fb_account_id && target.normalized_url.includes(p.fb_account_id)) ||
        (p.name && target.author_name && target.author_name.toLowerCase().includes(p.name.toLowerCase()))
      ) {
        token = await decryptToken(p.encrypted_token, masterKey);
        await db.prepare('UPDATE monitored_targets SET bound_account_id = ? WHERE id = ?').bind(p.id, target.id).run();
        break;
      }
    }
  }

  if (!token) {
    const candidate = await db.prepare("SELECT encrypted_token FROM accounts WHERE status = 'ACTIVE' AND account_type IN ('page', 'user') ORDER BY last_sync_at DESC LIMIT 1").first();
    if (candidate) token = await decryptToken(candidate.encrypted_token, masterKey);
  }

  // 2. Thử nghiệm Graph API (Không bao giờ bị checkpoint vì dùng OAuth Meta chính thức)
  let graphSuccess = false;
  if (token && target.content_id) {
    try {
      await syncViaGraphApi(target, token, env, graphVersion);
      graphSuccess = true;
    } catch (err) {
      console.warn(`Graph API không áp dụng được cho target #${target.id} (${err.message}). Tự động fallback sang mbasic/Sidecar...`);
    }
  }

  // 3. Fallback sang cào mbasic
  if (!graphSuccess) {
    await syncViaMbasic(target, env, masterKey);
  }
}

// Implementation: Sync via Meta Graph API
async function syncViaGraphApi(target, token, env, graphVersion) {
  const db = env.DB;
  const fields = [
    'id', 'created_time', 'message', 'from',
    'reactions.summary(total_count).as(all_reactions)',
    'reactions.type(LIKE).summary(total_count).as(rx_likes)',
    'reactions.type(LOVE).summary(total_count).as(rx_loves)',
    'reactions.type(CARE).summary(total_count).as(rx_cares)',
    'reactions.type(HAHA).summary(total_count).as(rx_hahas)',
    'reactions.type(WOW).summary(total_count).as(rx_wows)',
    'reactions.type(SAD).summary(total_count).as(rx_sads)',
    'reactions.type(ANGRY).summary(total_count).as(rx_angrys)',
    'comments.summary(total_count).limit(20){id,created_time,message,from{id,name,picture}}',
    'shares'
  ].join(',');

  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${target.content_id}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const totalReactions = data.all_reactions?.summary?.total_count || 0;
  const totalComments = data.comments?.summary?.total_count || 0;
  const totalShares = data.shares?.count || 0;
  const now = new Date().toISOString();

  const lastSnap = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1').bind(target.id).first();
  const deltaRx = lastSnap ? (totalReactions - lastSnap.total_reactions) : 0;
  const deltaCmt = lastSnap ? (totalComments - lastSnap.total_comments) : 0;
  const deltaSh = lastSnap ? (totalShares - lastSnap.total_shares) : 0;

  const evidencePayload = JSON.stringify({
    source: 'GRAPH_API',
    fb_content_id: data.id,
    author: data.from?.name || null,
    created_time: data.created_time || null,
    evidence_hash: await computeEvidenceHash(data.id + ':' + totalReactions + ':' + totalComments),
    verified_at: now
  });

  const snapValues = [
    target.id, now,
    totalReactions,
    data.rx_likes?.summary?.total_count || 0,
    data.rx_loves?.summary?.total_count || 0,
    data.rx_cares?.summary?.total_count || 0,
    data.rx_hahas?.summary?.total_count || 0,
    data.rx_wows?.summary?.total_count || 0,
    data.rx_sads?.summary?.total_count || 0,
    data.rx_angrys?.summary?.total_count || 0,
    totalComments, totalShares,
    deltaRx, deltaCmt, deltaSh,
    evidencePayload
  ];

  await db.prepare(`
    INSERT INTO snapshots (
      target_id, observed_at, source_type,
      total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
      total_comments, total_shares, delta_reactions, delta_comments, delta_shares, raw_json
    ) VALUES (?, ?, 'GRAPH_API', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...snapValues).run();

  await db.prepare(`
    UPDATE monitored_targets
    SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
        author_name = COALESCE(?, author_name),
        author_avatar = COALESCE(?, author_avatar),
        post_image = COALESCE(?, post_image),
        last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
    WHERE id = ?
  `).bind(
    totalReactions, totalComments, totalShares,
    data.from?.name || null,
    data.from?.id ? `https://graph.facebook.com/${data.from.id}/picture?type=large` : null,
    data.full_picture || data.picture || null,
    now, target.id
  ).run();

  // Insert Identifiable Comments from Meta Graph API
  if (data.comments && Array.isArray(data.comments.data)) {
    for (const c of data.comments.data) {
      await db.prepare(`
        INSERT INTO accounts_interacted (
          target_id, fb_user_id, display_name, profile_url, avatar_url,
          interaction_type, reaction_type, comment_text, observed_at, data_completeness
        ) VALUES (?, ?, ?, ?, ?, 'COMMENT', NULL, ?, ?, 'FULL')
      `).bind(
        target.id,
        c.from?.id || c.id,
        c.from?.name || 'Người dùng Facebook',
        c.from?.id ? `https://www.facebook.com/${c.from.id}` : null,
        c.from?.picture?.data?.url || null,
        c.message || '',
        c.created_time || now
      ).run();
    }
  }

  if (lastSnap && deltaRx >= 50) {
    await recordAlertWithCooldown(db, {
      targetId: target.id,
      alertType: 'REACTION_SPIKE',
      metricName: 'reactions',
      oldVal: lastSnap.total_reactions,
      newVal: totalReactions,
      delta: deltaRx,
      threshold: 50,
      severity: 'WARNING',
      message: `Lượt cảm xúc tăng vọt (+${deltaRx}) trên Edge.`,
      now
    }, 30);
  }
}

// Implementation: Sync via mbasic.facebook.com (Third-party public links with Cookie)
async function syncViaMbasic(target, env, masterKey) {
  const db = env.DB;
  const now = new Date().toISOString();

  // Find active cookie account
  const cookieAcc = await db.prepare("SELECT * FROM accounts WHERE account_type = 'cookie' AND status = 'ACTIVE' ORDER BY last_sync_at ASC LIMIT 1").first();
  if (!cookieAcc) {
    await db.prepare(`
      UPDATE monitored_targets
      SET status = 'NEEDS_AUTH',
          last_error = 'Yêu cầu quyền PPCA của Meta hoặc thêm Cookie nick phụ (mbasic)',
          last_checked_at = ?
      WHERE id = ?
    `).bind(now, target.id).run();
    return;
  }

  const cookie = await decryptToken(cookieAcc.encrypted_token, masterKey);
  if (!cookie) {
    throw new Error('Không thể giải mã cookie');
  }

  // Format URL for fetching: support both share short links and full post links
  let fetchUrl = target.normalized_url;
  if (!fetchUrl.startsWith('http')) {
    fetchUrl = `https://mbasic.facebook.com/${target.content_id}`;
  } else {
    fetchUrl = fetchUrl
      .replace('www.facebook.com', 'mbasic.facebook.com')
      .replace('m.facebook.com', 'mbasic.facebook.com')
      .replace('web.facebook.com', 'mbasic.facebook.com');
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Cookie': cookie,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none'
  };

  const response = await fetch(fetchUrl, { headers, redirect: 'follow' });
  const html = await response.text();

  // Checkpoint or Login Wall Detection
  if (isCheckpointOrLogin(response.url, html) || html.includes('AccountRequiredProductRule')) {
    await db.prepare("UPDATE accounts SET status = 'NEEDS_REAUTH', error_log = 'Cookie bị checkpoint hoặc hết hạn phiên (Yêu cầu đăng nhập)' WHERE id = ?").bind(cookieAcc.id).run();
    await recordAlertWithCooldown(db, {
      targetId: target.id,
      alertType: 'AUTH_LOST',
      metricName: 'cookie',
      oldVal: 1,
      newVal: 0,
      delta: -1,
      threshold: 0,
      severity: 'CRITICAL',
      message: `Cookie nick phụ (${cookieAcc.name}) bị checkpoint hoặc mất phiên. Cần nạp cookie mới.`,
      now
    }, 30);
    await db.prepare(`
      UPDATE monitored_targets
      SET last_checked_at = ?,
          last_error = 'Cookie nick phụ (${cookieAcc.name}) mất phiên - Cần nạp cookie mới'
      WHERE id = ?
    `).bind(now, target.id).run();
    return;
  }

  const parsed = parseMbasicHtml(html);

  if (
    parsed.authorName === 'Lỗi' ||
    html.includes('Trình duyệt này không hỗ trợ Facebook') ||
    html.includes('Sorry, something went wrong')
  ) {
    await db.prepare('UPDATE monitored_targets SET last_checked_at = ?, last_error = ? WHERE id = ?')
      .bind(now, 'Facebook yêu cầu phiên IP dân cư (Sidecar)', target.id).run();
    return;
  }

  // Use parsed reactions breakdown (or fetch ufi if legacy mbasic)
  let breakdown = parsed.reactions || { like: parsed.totalReactions, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
  let reactors = parsed.reactors || [];
  if (parsed.reactionsBrowserUrl) {
    try {
      const ufiUrl = `https://mbasic.facebook.com${parsed.reactionsBrowserUrl}`;
      const ufiRes = await fetch(ufiUrl, { headers });
      const ufiHtml = await ufiRes.text();
      breakdown = parseMbasicReactionsBreakdown(ufiHtml);
      const ufiReactors = parseMbasicReactors(ufiHtml);
      if (ufiReactors.length > 0) reactors = ufiReactors;
      if (parsed.totalReactions === 0) {
        parsed.totalReactions = Object.values(breakdown).reduce((a, b) => a + b, 0);
      }
    } catch (e) {
      console.warn('Lỗi bóc tách breakdown mbasic reaction:', e.message);
    }
  }

  // Insert Identifiable Comments & Reactors into accounts_interacted with deduplication
  const interactions = [...(parsed.comments || []), ...reactors];
  for (const item of interactions.slice(0, 30)) {
    const dName = item.displayName || 'Người dùng Facebook';
    const iType = item.interactionType || 'COMMENT';
    const cText = item.commentText || null;

    const existing = await db.prepare(`
      SELECT id FROM accounts_interacted 
      WHERE target_id = ? AND display_name = ? AND interaction_type = ? 
        AND (comment_text = ? OR (comment_text IS NULL AND ? IS NULL))
      LIMIT 1
    `).bind(target.id, dName, iType, cText, cText).first();

    if (!existing) {
      await db.prepare(`
        INSERT INTO accounts_interacted (
          target_id, fb_user_id, display_name, profile_url, avatar_url,
          interaction_type, reaction_type, comment_text, observed_at, data_completeness
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FULL')
      `).bind(
        target.id,
        item.fbUserId || null,
        dName,
        item.profileUrl || null,
        item.avatarUrl || null,
        iType,
        item.reactionType || null,
        cText,
        now
      ).run();
    }
  }

  // Get previous snapshot & last valid snapshot
  const lastSnap = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1').bind(target.id).first();
  const lastValidSnap = await db.prepare(`
    SELECT * FROM snapshots 
    WHERE target_id = ? AND (total_reactions > 0 OR total_comments > 0 OR total_shares > 0)
    ORDER BY observed_at DESC LIMIT 1
  `).bind(target.id).first();

  const baselineRx = Math.max(lastValidSnap?.total_reactions || 0, target.latest_reactions || 0);
  const baselineCmt = Math.max(lastValidSnap?.total_comments || 0, target.latest_comments || 0);
  const baselineSh = Math.max(lastValidSnap?.total_shares || 0, target.latest_shares || 0);

  // --- Comprehensive Multi-Metric Data Quality Gate against baseline ---
  if (baselineRx > 0 || baselineCmt > 0 || baselineSh > 0) {
    const rxDroppedToZero = baselineRx > 5 && parsed.totalReactions === 0;
    const cmtDroppedToZero = baselineCmt > 5 && parsed.totalComments === 0;
    const shDroppedToZero = baselineSh > 5 && parsed.totalShares === 0;
    const allZeroDrop = parsed.totalReactions === 0 && parsed.totalComments === 0 && parsed.totalShares === 0;

    if (rxDroppedToZero || cmtDroppedToZero || shDroppedToZero || allZeroDrop) {
      await db.prepare(`
        UPDATE monitored_targets 
        SET last_checked_at = ?, 
            last_error = 'Dữ liệu cào bị sụt giảm về 0 bất thường (Quality Gate bảo lưu baseline: ' || ? || ' rx)'
        WHERE id = ?
      `).bind(now, baselineRx, target.id).run();
      return;
    }

    const rxSharpDrop = baselineRx > 20 && parsed.totalReactions < baselineRx * 0.4;
    const cmtSharpDrop = baselineCmt > 20 && parsed.totalComments < baselineCmt * 0.4;
    const shSharpDrop = baselineSh > 20 && parsed.totalShares < baselineSh * 0.4;

    if (rxSharpDrop || cmtSharpDrop || shSharpDrop) {
      await db.prepare(`
        UPDATE monitored_targets 
        SET last_checked_at = ?, 
            last_error = 'Phát hiện số liệu biến động giảm đột biến >60% (Quality Gate bảo lưu baseline)'
        WHERE id = ?
      `).bind(now, target.id).run();
      return;
    }
  }

  // If parsed metrics are completely 0 and no baseline was established, reject empty snapshot
  if (parsed.totalReactions === 0 && parsed.totalComments === 0 && parsed.totalShares === 0) {
    await db.prepare(`
      UPDATE monitored_targets 
      SET last_checked_at = ?, 
          last_error = 'Facebook không trả phần tử tương tác (Chờ cào qua Sidecar IP dân cư)'
      WHERE id = ?
    `).bind(now, target.id).run();
    return;
  }

  const prevSnap = lastValidSnap || lastSnap;
  const deltaRx = prevSnap ? (parsed.totalReactions - prevSnap.total_reactions) : 0;
  const deltaCmt = prevSnap ? (parsed.totalComments - prevSnap.total_comments) : 0;
  const deltaSh = prevSnap ? (parsed.totalShares - prevSnap.total_shares) : 0;

  // Insert Snapshot
  const evidencePayload = JSON.stringify({
    source: 'MBASIC',
    url: fetchUrl,
    canonical_url: response.url || fetchUrl,
    http_status: response.status || 200,
    author: parsed.authorName,
    content_snippet: parsed.contentSnippet,
    evidence_hash: await computeEvidenceHash(html.slice(0, 1000)),
    metrics: {
      reactions: parsed.totalReactions,
      comments: parsed.totalComments,
      shares: parsed.totalShares,
      breakdown
    },
    verified_at: now
  });

  const snapValues = [
    target.id, now,
    parsed.totalReactions,
    breakdown.like, breakdown.love, breakdown.care, breakdown.haha, breakdown.wow, breakdown.sad, breakdown.angry,
    parsed.totalComments, parsed.totalShares,
    deltaRx, deltaCmt, deltaSh,
    evidencePayload
  ];

  await db.prepare(`
    INSERT INTO snapshots (
      target_id, observed_at, source_type,
      total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
      total_comments, total_shares, delta_reactions, delta_comments, delta_shares, raw_json
    ) VALUES (?, ?, 'MBASIC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...snapValues).run();

  // Update Target
  await db.prepare(`
    UPDATE monitored_targets
    SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
        author_name = COALESCE(?, author_name),
        author_avatar = COALESCE(?, author_avatar),
        post_image = COALESCE(?, post_image),
        content_snippet = COALESCE(?, content_snippet),
        last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
    WHERE id = ?
  `).bind(
    parsed.totalReactions, parsed.totalComments, parsed.totalShares,
    parsed.authorName,
    parsed.authorAvatar || parsed.postImage,
    parsed.postImage,
    parsed.contentSnippet,
    now, target.id
  ).run();

  // Update Cookie Account last sync
  await db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').bind(now, cookieAcc.id).run();

  // Anomaly Spike Alert Detection (Deduplicated with 30-min window)
  if (lastSnap && deltaRx >= 50) {
    await recordAlertWithCooldown(db, {
      targetId: target.id,
      alertType: 'REACTION_SPIKE',
      metricName: 'reactions',
      oldVal: lastSnap.total_reactions,
      newVal: parsed.totalReactions,
      delta: deltaRx,
      threshold: 50,
      severity: 'WARNING',
      message: `Lượt cảm xúc tăng vọt (+${deltaRx}) trên mbasic Edge.`,
      now
    }, 30);
  }
}
