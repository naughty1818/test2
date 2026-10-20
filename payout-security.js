'use strict';

const crypto = require('crypto');

function key() {
  const secret = process.env.PAYOUT_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (secret.length < 32) throw Object.assign(new Error('Payout encryption is not configured. Set PAYOUT_ENCRYPTION_KEY or a 32-character SESSION_SECRET.'), { status: 503 });
  return crypto.createHash('sha256').update(secret).update(':atharo-payout-details:v1').digest();
}

function encryptPayoutDetails(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decryptPayoutDetails(value) {
  if (!value) return null;
  const [ivText, tagText, dataText] = String(value).split('.');
  if (!ivText || !tagText || !dataText) throw new Error('Stored payout details could not be decrypted.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8'));
}

module.exports = { encryptPayoutDetails, decryptPayoutDetails };
