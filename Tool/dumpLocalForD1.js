import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('data/monitor.db');

const accounts = db.prepare("SELECT * FROM accounts WHERE status = 'ACTIVE'").all();
const targets = db.prepare("SELECT * FROM monitored_targets WHERE id = 13").all();
const alertConfigs = db.prepare("SELECT * FROM target_alert_configs WHERE target_id = 13").all();

let sql = '-- Seed data exported from local environment\n';

for (const acc of accounts) {
  const cols = Object.keys(acc);
  const vals = cols.map(c => acc[c] === null ? 'NULL' : `'${String(acc[c]).replace(/'/g, "''")}'`);
  sql += `INSERT OR REPLACE INTO accounts (${cols.join(', ')}) VALUES (${vals.join(', ')});\n`;
}

for (const t of targets) {
  const cols = Object.keys(t);
  const vals = cols.map(c => t[c] === null ? 'NULL' : `'${String(t[c]).replace(/'/g, "''")}'`);
  sql += `INSERT OR REPLACE INTO monitored_targets (${cols.join(', ')}) VALUES (${vals.join(', ')});\n`;
}

for (const cfg of alertConfigs) {
  const cols = Object.keys(cfg);
  const vals = cols.map(c => cfg[c] === null ? 'NULL' : `'${String(cfg[c]).replace(/'/g, "''")}'`);
  sql += `INSERT OR REPLACE INTO target_alert_configs (${cols.join(', ')}) VALUES (${vals.join(', ')});\n`;
}

fs.writeFileSync('migrations/seed_data.sql', sql, 'utf8');
console.log('Exported seed_data.sql successfully.');
