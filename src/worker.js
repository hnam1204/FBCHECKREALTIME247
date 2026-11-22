import crypto from 'node:crypto';
import { parseBatchUrls, normalizeUrl, analyzeUrl } from './analyzer/urlAnalyzer.js';
import { extractCUser, isCheckpointOrLogin, parseMbasicHtml, parseMbasicReactionsBreakdown, parseMbasicReactors } from './collector/mbasicCollector.js';

// --- Crypto Utilities (AES-256-GCM) ---
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function encryptToken(text, masterHexKey) {
  if (!text) return '';
  const key = Buffer.from(masterHexKey.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptToken(payload, masterHexKey) {
  if (!payload || !payload.includes(':')) return '';
  const [ivHex, tagHex, encryptedHex] = payload.split(':');
  if (!ivHex || !tagHex || !encryptedHex) return '';
  const key = Buffer.from(masterHexKey.slice(0, 64), 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Helper: JSON Response
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

// --- Main Cloudflare Worker Export ---
export default {
  // 1. HTTP Request Router (Edge API & Static Assets)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return jsonResponse({ ok: true });
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

    return new Response('Asset Binding Not Found', { status: 404 });
  },

  // 2. 24/7 Cloudflare Edge Cron Trigger (Runs every minute)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledMonitoringTick(env));
  }
};

// --- API Router Implementation for Cloudflare D1 ---
async function handleApiRoute(pathname, method, request, env, url) {
  const db = env.DB;
  const masterKey = env.ENCRYPTION_MASTER_KEY || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const graphVersion = env.META_GRAPH_VERSION || 'v21.0';

  // GET /api/overview
  if (pathname === '/api/overview' && method === 'GET') {
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

    const topFastest = (await db.prepare(`
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
    `).all())?.results || [];

    const recentAlerts = (await db.prepare(`
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ORDER BY a.detected_at DESC
      LIMIT 10
    `).all())?.results || [];

    return jsonResponse({
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
    sql += ' ORDER BY id DESC LIMIT 50';

    const results = (await db.prepare(sql).bind(...params).all())?.results || [];
    return jsonResponse({ targets: results });
  }

  // GET /api/targets/:id
  const targetIdMatch = pathname.match(/^\/api\/targets\/(\d+)$/);
  if (targetIdMatch && method === 'GET') {
    const id = parseInt(targetIdMatch[1], 10);
    const target = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(id).first();
    if (!target) return jsonResponse({ error: 'Không tìm thấy đối tượng' }, 404);

    const snapshots = (await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 50').bind(id).all())?.results || [];
    const latestSnapshot = snapshots[0] || null;
    const interactedAccounts = (await db.prepare('SELECT * FROM accounts_interacted WHERE target_id = ? ORDER BY observed_at DESC LIMIT 30').bind(id).all())?.results || [];
    const alertConfig = (await db.prepare('SELECT * FROM target_alert_configs WHERE target_id = ?').bind(id).first()) || {};

    return jsonResponse({
      target,
      latestSnapshot,
      snapshots: snapshots.reverse(),
      interactedAccounts,
      alertConfig
    });
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

  // GET /api/comparison (So sánh tương tác đa nội dung)
  if (pathname === '/api/comparison' && method === 'GET') {
    const idsParam = url.searchParams.get('ids') || '';
    const ids = idsParam.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean);
    if (ids.length === 0) return jsonResponse({ comparison: [] });

    const comparison = [];
    for (const id of ids) {
      const target = await db.prepare('SELECT id, author_name, normalized_url, target_type, latest_reactions, latest_comments, latest_shares, last_checked_at FROM monitored_targets WHERE id = ?').bind(id).first();
      if (!target) continue;

      const points = (await db.prepare(`
        SELECT observed_at, total_reactions, total_comments, total_shares
        FROM snapshots
        WHERE target_id = ?
        ORDER BY observed_at ASC
        LIMIT 50
      `).bind(id).all())?.results || [];

      if (points.length === 0) {
        points.push({
          observed_at: target.last_checked_at || new Date().toISOString(),
          total_reactions: target.latest_reactions || 0,
          total_comments: target.latest_comments || 0,
          total_shares: target.latest_shares || 0
        });
      }

      comparison.push({ target, points });
    }

    return jsonResponse({ comparison });
  }

  // GET /api/accounts
  if (pathname === '/api/accounts' && method === 'GET') {
    const accounts = (await db.prepare('SELECT id, name, account_type, fb_account_id, scopes, status, expires_at, last_sync_at, error_log FROM accounts ORDER BY id DESC').all())?.results || [];
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
    const encToken = encryptToken(token, masterKey);

    await db.prepare(`
      INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, created_at)
      VALUES (?, 'user', ?, ?, ?, 'ACTIVE', ?)
      ON CONFLICT(fb_account_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, scopes = excluded.scopes, status = 'ACTIVE'
    `).bind(me.name, me.id, encToken, grantedScopes, now).run();

    const pagesRes = await fetch(`https://graph.facebook.com/${graphVersion}/me/accounts?fields=id,name,access_token&limit=100&access_token=${token}`);
    const pages = (await pagesRes.json()).data || [];

    for (const page of pages) {
      const pageEnc = encryptToken(page.access_token, masterKey);
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
    const encCookie = encryptToken(cookie.trim(), masterKey);
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

    const cookie = decryptToken(acc.encrypted_token, masterKey);
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
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
  }

  // GET /api/alerts
  if (pathname === '/api/alerts' && method === 'GET') {
    const alerts = (await db.prepare(`
      SELECT a.*, t.author_name, t.normalized_url
      FROM alerts a
      JOIN monitored_targets t ON t.id = a.target_id
      ORDER BY a.detected_at DESC
      LIMIT 100
    `).all())?.results || [];
    return jsonResponse({ alerts });
  }

  // PATCH /api/alerts/:id/ack
  const alertAckMatch = pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
  if (alertAckMatch && method === 'PATCH') {
    const id = parseInt(alertAckMatch[1], 10);
    await db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
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
    const secret = request.headers.get('X-Sidecar-Secret') || url.searchParams.get('secret');
    if (!secret || secret !== masterKey) {
      return jsonResponse({ error: 'Mã bí mật xác thực Sidecar không hợp lệ' }, 401);
    }

    const targets = (await db.prepare("SELECT * FROM monitored_targets WHERE status != 'PAUSED' ORDER BY priority DESC LIMIT 20").all())?.results || [];
    const cookieAcc = await db.prepare("SELECT * FROM accounts WHERE account_type = 'cookie' AND status = 'ACTIVE' ORDER BY last_sync_at ASC LIMIT 1").first();
    const cookie = cookieAcc ? decryptToken(cookieAcc.encrypted_token, masterKey) : null;
    const proxyRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'residential_proxy_url'").first();

    return jsonResponse({
      targets,
      cookie,
      proxyUrl: proxyRow?.value || null
    });
  }

  // POST /api/sidecar/push-snapshot (Nhận snapshot từ Local Sidecar cào qua IP dân cư thật)
  if (pathname === '/api/sidecar/push-snapshot' && method === 'POST') {
    const secret = request.headers.get('X-Sidecar-Secret');
    const body = await request.json();
    const checkSecret = secret || body.secret;
    if (!checkSecret || checkSecret !== masterKey) {
      return jsonResponse({ error: 'Không có quyền truy cập (Invalid Sidecar Secret)' }, 401);
    }

    const {
      target_id,
      total_reactions = 0,
      reactions = {},
      total_comments = 0,
      total_shares = 0,
      author_name = null,
      content_snippet = null,
      interacted_accounts = []
    } = body;

    const now = new Date().toISOString();
    const target = await db.prepare('SELECT * FROM monitored_targets WHERE id = ?').bind(target_id).first();
    if (!target) return jsonResponse({ error: 'Target không tồn tại' }, 404);

    const lastSnap = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1').bind(target_id).first();
    const deltaRx = lastSnap ? (total_reactions - lastSnap.total_reactions) : 0;
    const deltaCmt = lastSnap ? (total_comments - lastSnap.total_comments) : 0;
    const deltaSh = lastSnap ? (total_shares - lastSnap.total_shares) : 0;

    const rx = { like: total_reactions, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0, ...reactions };

    const snapRes = await db.prepare(`
      INSERT INTO snapshots (
        target_id, observed_at, source_type,
        total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
        total_comments, total_shares, delta_reactions, delta_comments, delta_shares
      ) VALUES (?, ?, 'LOCAL_SIDECAR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      target_id, now,
      total_reactions,
      rx.like || 0, rx.love || 0, rx.care || 0, rx.haha || 0, rx.wow || 0, rx.sad || 0, rx.angry || 0,
      total_comments, total_shares,
      deltaRx, deltaCmt, deltaSh
    ).run();

    await db.prepare(`
      UPDATE monitored_targets
      SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
          author_name = COALESCE(?, author_name),
          content_snippet = COALESCE(?, content_snippet),
          last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
      WHERE id = ?
    `).bind(total_reactions, total_comments, total_shares, author_name, content_snippet, now, target_id).run();

    // Insert interacted accounts with deduplication
    if (Array.isArray(interacted_accounts) && interacted_accounts.length > 0) {
      for (const item of interacted_accounts.slice(0, 30)) {
        const dName = item.display_name || item.displayName || 'Người dùng Facebook';
        const iType = item.interaction_type || item.interactionType || 'COMMENT';
        const cText = item.comment_text || item.commentText || null;

        const existing = await db.prepare(`
          SELECT id FROM accounts_interacted 
          WHERE target_id = ? AND display_name = ? AND interaction_type = ? 
            AND (comment_text = ? OR (comment_text IS NULL AND ? IS NULL))
          LIMIT 1
        `).bind(target_id, dName, iType, cText, cText).first();

        if (!existing) {
          await db.prepare(`
            INSERT INTO accounts_interacted (
              target_id, fb_user_id, display_name, profile_url, avatar_url,
              interaction_type, reaction_type, comment_text, observed_at, data_completeness
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FULL')
          `).bind(
            target_id,
            item.fb_user_id || item.fbUserId || null,
            dName,
            item.profile_url || item.profileUrl || null,
            item.avatar_url || item.avatarUrl || null,
            iType,
            item.reaction_type || item.reactionType || null,
            cText,
            now
          ).run();
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

  // GET /api/health
  if (pathname === '/api/health' && method === 'GET') {
    return jsonResponse({
      status: 'HEALTHY',
      platform: 'Serverless Edge 24/7',
      engine: 'Hybrid (Meta Graph API + mbasic Scraper)',
      timestamp: new Date().toISOString()
    });
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
      token = decryptToken(acc.encrypted_token, masterKey);
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
        token = decryptToken(p.encrypted_token, masterKey);
        await db.prepare('UPDATE monitored_targets SET bound_account_id = ? WHERE id = ?').bind(p.id, target.id).run();
        break;
      }
    }
  }

  if (!token) {
    const candidate = await db.prepare("SELECT encrypted_token FROM accounts WHERE status = 'ACTIVE' AND account_type IN ('page', 'user') ORDER BY last_sync_at DESC LIMIT 1").first();
    if (candidate) token = decryptToken(candidate.encrypted_token, masterKey);
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

  await db.prepare(`
    INSERT INTO snapshots (
      target_id, observed_at, source_type,
      total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
      total_comments, total_shares, delta_reactions, delta_comments, delta_shares
    ) VALUES (?, ?, 'GRAPH_API', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
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
    deltaRx, deltaCmt, deltaSh
  ).run();

  await db.prepare(`
    UPDATE monitored_targets
    SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
        author_name = COALESCE(?, author_name),
        last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
    WHERE id = ?
  `).bind(totalReactions, totalComments, totalShares, data.from?.name || null, now, target.id).run();

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
    await db.prepare(`
      INSERT INTO alerts (target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at)
      VALUES (?, 'REACTION_SPIKE', 'reactions', ?, ?, ?, 50, 'WARNING', 'Lượt cảm xúc tăng vọt (+${deltaRx}) trên Edge.', ?)
    `).bind(target.id, lastSnap.total_reactions, totalReactions, deltaRx, now).run();
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

  const cookie = decryptToken(cookieAcc.encrypted_token, masterKey);
  if (!cookie) {
    throw new Error('Không thể giải mã cookie');
  }

  // Format URL for fetching: support both share short links and full post links
  let fetchUrl = target.normalized_url;
  if (!fetchUrl.startsWith('http')) {
    fetchUrl = `https://www.facebook.com/${target.content_id}`;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
  if (isCheckpointOrLogin(response.url, html)) {
    await db.prepare("UPDATE accounts SET status = 'NEEDS_REAUTH', error_log = 'Cookie bị checkpoint hoặc hết hạn đăng nhập' WHERE id = ?").bind(cookieAcc.id).run();
    await db.prepare(`
      INSERT INTO alerts (target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at)
      VALUES (?, 'AUTH_LOST', 'cookie', 1, 0, -1, 0, 'CRITICAL', 'Cookie nick phụ (${cookieAcc.name}) bị checkpoint hoặc mất phiên. Cần nạp cookie mới.', ?)
    `).bind(target.id, now).run();
    throw new Error(`Cookie account #${cookieAcc.id} bị checkpoint`);
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

  // Get previous snapshot
  const lastSnap = await db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY observed_at DESC LIMIT 1').bind(target.id).first();
  const deltaRx = lastSnap ? (parsed.totalReactions - lastSnap.total_reactions) : 0;
  const deltaCmt = lastSnap ? (parsed.totalComments - lastSnap.total_comments) : 0;
  const deltaSh = lastSnap ? (parsed.totalShares - lastSnap.total_shares) : 0;

  // Insert Snapshot
  await db.prepare(`
    INSERT INTO snapshots (
      target_id, observed_at, source_type,
      total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
      total_comments, total_shares, delta_reactions, delta_comments, delta_shares
    ) VALUES (?, ?, 'MBASIC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    target.id, now,
    parsed.totalReactions,
    breakdown.like, breakdown.love, breakdown.care, breakdown.haha, breakdown.wow, breakdown.sad, breakdown.angry,
    parsed.totalComments, parsed.totalShares,
    deltaRx, deltaCmt, deltaSh
  ).run();

  // Update Target
  await db.prepare(`
    UPDATE monitored_targets
    SET latest_reactions = ?, latest_comments = ?, latest_shares = ?,
        author_name = COALESCE(?, author_name),
        content_snippet = COALESCE(?, content_snippet),
        last_checked_at = ?, last_error = NULL, status = 'ACTIVE'
    WHERE id = ?
  `).bind(parsed.totalReactions, parsed.totalComments, parsed.totalShares, parsed.authorName, parsed.contentSnippet, now, target.id).run();

  // Update Cookie Account last sync
  await db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').bind(now, cookieAcc.id).run();

  // Anomaly Spike Alert Detection
  if (lastSnap && deltaRx >= 50) {
    await db.prepare(`
      INSERT INTO alerts (target_id, alert_type, metric_name, old_val, new_val, delta, threshold, severity, message, detected_at)
      VALUES (?, 'REACTION_SPIKE', 'reactions', ?, ?, ?, 50, 'WARNING', 'Lượt cảm xúc tăng vọt (+${deltaRx}) trên mbasic Edge.', ?)
    `).bind(target.id, lastSnap.total_reactions, parsed.totalReactions, deltaRx, now).run();
  }
}
