const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const rootDir = path.resolve(__dirname, '..');
const rawDbPath = process.env.DB_PATH || './data/monitor.db';
const resolvedDbPath = rawDbPath === ':memory:' 
  ? ':memory:' 
  : (path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(rootDir, rawDbPath));

if (resolvedDbPath !== ':memory:') {
  const resolvedDbDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(resolvedDbDir)) {
    fs.mkdirSync(resolvedDbDir, { recursive: true });
  }
}

module.exports = {
  rootDir,
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  encryptionKey: process.env.ENCRYPTION_MASTER_KEY || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  dbPath: resolvedDbPath,
  defaultCheckIntervalSec: parseInt(process.env.DEFAULT_CHECK_INTERVAL_SEC || '60', 10),
  maxConcurrentChecks: parseInt(process.env.MAX_CONCURRENT_CHECKS || '5', 10),
  retryMaxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
  retryBackoffBaseSec: parseInt(process.env.RETRY_BACKOFF_BASE_SEC || '15', 10),
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
  },
  enableDevSimulator: process.env.ENABLE_DEV_SIMULATOR === 'true'
};
