const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96-bit IV for GCM

/**
 * Encrypt sensitive plain text (e.g. Meta OAuth token) with AES-256-GCM.
 * @param {string} text - Plain text
 * @param {string} keyHex - 32-byte master key in hex
 * @returns {string} iv:tag:ciphertext formatted string
 */
function encrypt(text, keyHex) {
  if (!text) return '';
  const key = Buffer.from(keyHex.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt AES-256-GCM encrypted string.
 * @param {string} payload - iv:tag:ciphertext string
 * @param {string} keyHex - 32-byte master key in hex
 * @returns {string} Decrypted plain text
 */
function decrypt(payload, keyHex) {
  if (!payload || !payload.includes(':')) return '';
  const [ivHex, tagHex, encryptedHex] = payload.split(':');
  if (!ivHex || !tagHex || !encryptedHex) return '';

  const key = Buffer.from(keyHex.slice(0, 64), 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Compute SHA256 hex hash
 */
function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  encrypt,
  decrypt,
  hash
};
