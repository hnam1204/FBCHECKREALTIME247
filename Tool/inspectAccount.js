const { getDb } = require('../src/db/database');
const { encrypt } = require('../src/utils/crypto');
const config = require('../src/config');

/**
 * Phân tích và tự động hóa trích xuất thông tin Meta Account:
 * 1. Kiểm tra tính hợp lệ & danh tính tài khoản (/me)
 * 2. Bóc tách danh sách quyền hạn thực tế (/me/permissions)
 * 3. Bóc tách toàn bộ Fanpage trực thuộc & Page Access Token riêng biệt (/me/accounts)
 * 4. Tự động nâng cấp Long-lived Token (60 ngày) nếu có App Secret
 * 5. Mã hóa AES-256-GCM và lưu thẳng vào SQLite của hệ thống chính
 */
class AccountInspectorTool {
  constructor() {
    this.db = getDb();
    this.graphVersion = config.meta.graphVersion || 'v21.0';
  }

  async run(inputToken, options = {}) {
    if (!inputToken) {
      throw new Error('Cần cung cấp Meta Access Token để phân tích.');
    }

    console.log(`[Tool] Bắt đầu truy vấn Meta Graph API (${this.graphVersion})...`);

    // 1. Lấy thông tin cơ bản của User
    const userProfile = await this.fetchUserProfile(inputToken);
    console.log(`[Tool] Tài khoản: ${userProfile.name} (ID: ${userProfile.id})`);

    // 2. Bóc tách toàn bộ Scopes (Permissions)
    const permissions = await this.fetchPermissions(inputToken);
    const grantedScopes = permissions.filter(p => p.status === 'granted').map(p => p.permission);
    const declinedScopes = permissions.filter(p => p.status === 'declined').map(p => p.permission);
    console.log(`[Tool] Scopes hợp lệ (${grantedScopes.length}): ${grantedScopes.join(', ')}`);
    if (declinedScopes.length > 0) {
      console.warn(`[Tool] Scopes bị từ chối (${declinedScopes.length}): ${declinedScopes.join(', ')}`);
    }

    // 3. Tùy chọn nâng cấp Long-lived Token
    let effectiveUserToken = inputToken;
    let expiresAt = null;

    if (config.meta.appId && config.meta.appSecret) {
      try {
        const longLived = await this.exchangeLongLivedToken(inputToken, config.meta.appId, config.meta.appSecret);
        effectiveUserToken = longLived.access_token;
        if (longLived.expires_in) {
          expiresAt = new Date(Date.now() + longLived.expires_in * 1000).toISOString();
        }
        console.log(`[Tool] Đã nâng cấp thành công Long-lived Token (thời hạn ~60 ngày)`);
      } catch (err) {
        console.warn(`[Tool] Không thể nâng cấp Long-lived token: ${err.message}`);
      }
    }

    // 4. Lấy toàn bộ Fanpage được quản lý (/me/accounts)
    const pages = await this.fetchManagedPages(inputToken);
    console.log(`[Tool] Tìm thấy ${pages.length} Fanpage được cấp quyền quản lý.`);

    // 5. Đồng bộ vào cơ sở dữ liệu chính
    const importedAccounts = [];

    // Lưu tài khoản User cá nhân
    const userImport = this.upsertAccount({
      name: userProfile.name,
      accountType: 'user',
      fbAccountId: userProfile.id,
      accessToken: effectiveUserToken,
      scopes: grantedScopes,
      expiresAt
    });
    importedAccounts.push({ ...userImport, type: 'user', name: userProfile.name });

    // Lưu từng Page kèm Page Access Token riêng
    for (const page of pages) {
      const pageImport = this.upsertAccount({
        name: page.name,
        accountType: 'page',
        fbAccountId: page.id,
        accessToken: page.access_token,
        scopes: grantedScopes,
        expiresAt: null // Page Access Token gắn với Long-lived User Token sẽ không bao giờ hết hạn
      });
      importedAccounts.push({ ...pageImport, type: 'page', name: page.name, pageId: page.id });
      console.log(`  -> Đã mã hóa và nạp Page: ${page.name} (ID: ${page.id})`);
    }

    return {
      user: {
        id: userProfile.id,
        name: userProfile.name,
        grantedScopes,
        declinedScopes,
        expiresAt
      },
      pagesCount: pages.length,
      importedAccounts
    };
  }

  async fetchUserProfile(token) {
    const res = await fetch(`https://graph.facebook.com/${this.graphVersion}/me?fields=id,name,email&access_token=${token}`);
    const data = await res.json();
    if (data.error) throw new Error(`Meta API Error: ${data.error.message}`);
    return data;
  }

  async fetchPermissions(token) {
    const res = await fetch(`https://graph.facebook.com/${this.graphVersion}/me/permissions?access_token=${token}`);
    const data = await res.json();
    if (data.error) return [];
    return data.data || [];
  }

  async fetchManagedPages(token) {
    const res = await fetch(`https://graph.facebook.com/${this.graphVersion}/me/accounts?fields=id,name,category,access_token,tasks&limit=100&access_token=${token}`);
    const data = await res.json();
    if (data.error) return [];
    return data.data || [];
  }

  async exchangeLongLivedToken(shortLivedToken, appId, appSecret) {
    const url = `https://graph.facebook.com/${this.graphVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  upsertAccount({ name, accountType, fbAccountId, accessToken, scopes, expiresAt }) {
    const encryptedToken = encrypt(accessToken, config.encryptionKey);
    const scopeStr = Array.isArray(scopes) ? scopes.join(',') : (scopes || '');
    const now = new Date().toISOString();

    const existing = this.db.prepare('SELECT id FROM accounts WHERE fb_account_id = ?').get(fbAccountId);

    if (existing) {
      this.db.prepare(`
        UPDATE accounts 
        SET name = ?, account_type = ?, encrypted_token = ?, scopes = ?, status = 'ACTIVE', expires_at = ?, error_log = NULL
        WHERE fb_account_id = ?
      `).run(name, accountType, encryptedToken, scopeStr, expiresAt, fbAccountId);
      return { id: existing.id, fbAccountId, action: 'UPDATED' };
    }

    const info = this.db.prepare(`
      INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(name, accountType, fbAccountId, encryptedToken, scopeStr, expiresAt, now);

    return { id: Number(info.lastInsertRowid), fbAccountId, action: 'CREATED' };
  }
}

// CLI Execution Support
if (require.main === module) {
  const readline = require('node:readline');

  async function getOrPromptToken() {
    let token = process.argv[2];
    if (token) return token.trim();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise(resolve => {
      rl.question('\n[Tool] Nhập hoặc dán Meta Access Token (sau đó nhấn Enter):\n> ', answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  getOrPromptToken()
    .then(token => {
      if (!token) {
        console.log('[Tool] Lỗi: Token không được để trống.');
        process.exit(1);
      }
      const tool = new AccountInspectorTool();
      return tool.run(token);
    })
    .then(result => {
      console.log('\n=======================================================');
      console.log('[c4] ĐÃ NẠP THÀNH CÔNG VÀO HỆ THỐNG GIÁM SÁT');
      console.log(`- Tài khoản cá nhân: ${result.user.name} (ID: ${result.user.id})`);
      console.log(`- Số Fanpage trực thuộc: ${result.pagesCount}`);
      console.log(`- Scopes đã cấp: ${result.user.grantedScopes.join(', ')}`);
      console.log('=======================================================');
      process.exitCode = 0;
    })
    .catch(err => {
      console.error('\n[Tool Lỗi]:', err.message);
      process.exitCode = 1;
    });
}

module.exports = AccountInspectorTool;
