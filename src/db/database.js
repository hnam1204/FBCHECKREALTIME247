const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let dbInstance = null;

function getDb(customPath = null) {
  if (dbInstance && !customPath) return dbInstance;
  
  const targetPath = customPath || config.dbPath;
  const instance = new DatabaseSync(targetPath);
  
  // Enable WAL mode & busy timeout for safe concurrency
  instance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);

  initSchema(instance);
  if (!customPath) {
    dbInstance = instance;
  }
  return instance;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'page',
      fb_account_id TEXT UNIQUE NOT NULL,
      encrypted_token TEXT NOT NULL,
      scopes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      expires_at TEXT,
      last_sync_at TEXT,
      error_log TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitored_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_url TEXT NOT NULL,
      normalized_url TEXT UNIQUE NOT NULL,
      target_type TEXT NOT NULL,
      content_id TEXT,
      author_name TEXT,
      author_avatar TEXT,
      content_snippet TEXT,
      post_created_time TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      check_interval_sec INTEGER NOT NULL DEFAULT 60,
      priority INTEGER NOT NULL DEFAULT 1,
      bound_account_id INTEGER,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      last_checked_at TEXT,
      baseline_reactions INTEGER DEFAULT 0,
      baseline_comments INTEGER DEFAULT 0,
      baseline_shares INTEGER DEFAULT 0,
      latest_reactions INTEGER DEFAULT 0,
      latest_comments INTEGER DEFAULT 0,
      latest_shares INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (bound_account_id) REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      total_reactions INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      love_count INTEGER DEFAULT 0,
      care_count INTEGER DEFAULT 0,
      haha_count INTEGER DEFAULT 0,
      wow_count INTEGER DEFAULT 0,
      sad_count INTEGER DEFAULT 0,
      angry_count INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      total_shares INTEGER DEFAULT 0,
      delta_reactions INTEGER DEFAULT 0,
      delta_comments INTEGER DEFAULT 0,
      delta_shares INTEGER DEFAULT 0,
      growth_rate_5m REAL DEFAULT 0,
      growth_rate_1h REAL DEFAULT 0,
      growth_rate_24h REAL DEFAULT 0,
      raw_json TEXT,
      FOREIGN KEY (target_id) REFERENCES monitored_targets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounts_interacted (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      fb_user_id TEXT,
      display_name TEXT NOT NULL,
      profile_url TEXT,
      avatar_url TEXT,
      interaction_type TEXT NOT NULL,
      reaction_type TEXT,
      comment_text TEXT,
      observed_at TEXT NOT NULL,
      data_completeness TEXT NOT NULL DEFAULT 'PARTIAL',
      FOREIGN KEY (target_id) REFERENCES monitored_targets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      alert_type TEXT NOT NULL,
      metric_name TEXT,
      old_val REAL DEFAULT 0,
      new_val REAL DEFAULT 0,
      delta REAL DEFAULT 0,
      threshold REAL DEFAULT 0,
      severity TEXT NOT NULL DEFAULT 'INFO',
      message TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      FOREIGN KEY (target_id) REFERENCES monitored_targets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS target_alert_configs (
      target_id INTEGER PRIMARY KEY,
      reaction_spike_threshold INTEGER DEFAULT 50,
      comment_surge_threshold INTEGER DEFAULT 20,
      share_burst_threshold INTEGER DEFAULT 10,
      stall_timeout_min INTEGER DEFAULT 30,
      FOREIGN KEY (target_id) REFERENCES monitored_targets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_target_time ON snapshots(target_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interacted_target ON accounts_interacted(target_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_targets_status ON monitored_targets(status, last_checked_at);
  `);
}

module.exports = {
  getDb
};
