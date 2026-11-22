const { getDb } = require('../db/database');
const { encrypt, decrypt } = require('../utils/crypto');
const config = require('../config');

class AccountManager {
  constructor() {
    this.db = getDb();
  }

  /**
   * Register or update an authorized Meta account / Fanpage connection
   */
  addAccount({ name, accountType = 'page', fbAccountId, accessToken, scopes = [], expiresAt = null }) {
    if (!name || !fbAccountId || !accessToken) {
      throw new Error('Thiếu thông tin tài khoản, ID hoặc Access Token');
    }

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
      return { id: existing.id, fbAccountId, status: 'UPDATED' };
    }

    const info = this.db.prepare(`
      INSERT INTO accounts (name, account_type, fb_account_id, encrypted_token, scopes, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(name, accountType, fbAccountId, encryptedToken, scopeStr, expiresAt, now);

    return { id: Number(info.lastInsertRowid), fbAccountId, status: 'CREATED' };
  }

  /**
   * List all connected accounts (WITHOUT revealing raw decrypted token)
   */
  listAccounts() {
    const rows = this.db.prepare(`
      SELECT id, name, account_type, fb_account_id, scopes, status, expires_at, last_sync_at, error_log, created_at
      FROM accounts
      ORDER BY id DESC
    `).all();

    return rows.map(acc => ({
      ...acc,
      scopes: acc.scopes ? acc.scopes.split(',') : [],
      isExpired: acc.expires_at ? new Date(acc.expires_at).getTime() < Date.now() : false
    }));
  }

  /**
   * Get an active, decrypted access token for a specific account ID
   */
  getTokenForAccount(accountId) {
    const row = this.db.prepare(`
      SELECT encrypted_token, status, expires_at 
      FROM accounts 
      WHERE id = ?
    `).get(accountId);

    if (!row) return null;
    if (row.status !== 'ACTIVE') return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      this.markStatus(accountId, 'EXPIRED', 'Token đã hết hạn');
      return null;
    }

    return decrypt(row.encrypted_token, config.encryptionKey);
  }

  /**
   * Match an appropriate active connection for a monitored target
   */
  findEligibleAccountForTarget(target) {
    if (target.bound_account_id) {
      const token = this.getTokenForAccount(target.bound_account_id);
      if (token) return { accountId: target.bound_account_id, token };
    }

    // Otherwise, pick the most recently synced active account with pages_read_engagement
    const candidate = this.db.prepare(`
      SELECT id, encrypted_token, expires_at
      FROM accounts
      WHERE status = 'ACTIVE'
      ORDER BY last_sync_at DESC, id DESC
      LIMIT 1
    `).get();

    if (!candidate) return null;
    if (candidate.expires_at && new Date(candidate.expires_at).getTime() < Date.now()) {
      this.markStatus(candidate.id, 'EXPIRED', 'Token đã hết hạn');
      return null;
    }

    return {
      accountId: candidate.id,
      token: decrypt(candidate.encrypted_token, config.encryptionKey)
    };
  }

  /**
   * Update sync time and clear errors on successful fetch
   */
  recordSyncSuccess(accountId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts 
      SET last_sync_at = ?, status = 'ACTIVE', error_log = NULL 
      WHERE id = ?
    `).run(now, accountId);
  }

  /**
   * Log an error on an account
   */
  recordSyncError(accountId, errorMsg, isAuthError = false) {
    const status = isAuthError ? 'EXPIRED' : 'ACTIVE';
    this.db.prepare(`
      UPDATE accounts 
      SET error_log = ?, status = ? 
      WHERE id = ?
    `).run(errorMsg, status, accountId);
  }

  /**
   * Revoke / Delete account connection
   */
  revokeAccount(id) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return { success: true };
  }

  markStatus(id, status, errorMsg = '') {
    this.db.prepare(`
      UPDATE accounts 
      SET status = ?, error_log = ? 
      WHERE id = ?
    `).run(status, errorMsg, id);
  }
}

module.exports = new AccountManager();
