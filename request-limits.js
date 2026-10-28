'use strict';
const { rateLimit } = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const net = require('node:net');

const redisUrl = String(process.env.REDIS_URL || '').trim();
const redisClient = redisUrl ? createClient({ url: redisUrl }) : null;
if (redisClient) redisClient.on('error', error => console.error('Redis rate-limit store error:', error.message));
let redisConnectPromise;

function ensureRedisConnected() {
  if (!redisClient) return Promise.reject(new Error('REDIS_URL is not configured'));
  if (redisClient.isReady) return Promise.resolve();
  if (!redisConnectPromise) {
    redisConnectPromise = redisClient.connect().catch(error => {
      redisConnectPromise = undefined;
      throw error;
    });
  }
  return redisConnectPromise;
}

const RETRY_AFTER_SECONDS = windowMs => Math.max(1, Math.ceil(windowMs / 1000));
function clientIpKeyGenerator(req) {
  const cloudflareIp = req.get?.('cf-connecting-ip') || req.headers?.['cf-connecting-ip'];
  const clientIp = typeof cloudflareIp === 'string' && net.isIP(cloudflareIp) ? cloudflareIp : req.ip;
  return ipKeyGenerator(clientIp);
}
function createLimiter({ windowMs, limit, message }, store) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: clientIpKeyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store, passOnStoreError: true } : {}),
    skip: req => req.method === 'OPTIONS',
    handler: (req, res) => {
      const retryAfterSeconds = RETRY_AFTER_SECONDS(windowMs);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: message, retryAfterSeconds });
    }
  });
}
function storeFor(prefix) {
  if (!redisClient) return undefined;
  return new RedisStore({
    prefix: `atharo:rate-limit:${prefix}:`,
    sendCommand: async (...args) => {
      await ensureRedisConnected();
      return redisClient.sendCommand(args);
    }
  });
}
function attachRequestLimits(app, overrides = {}) {
  const settings = {
    api: { windowMs: 60_000, limit: 300, message: 'অনেকগুলো request হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।', ...overrides.api },
    oauth: { windowMs: 15 * 60_000, limit: 20, message: 'অনেকবার login শুরু করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।', ...overrides.oauth },
    upload: { windowMs: 15 * 60_000, limit: 20, message: 'অল্প সময়ে অনেক upload শুরু হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।', ...overrides.upload },
    checkout: { windowMs: 10 * 60_000, limit: 20, message: 'অল্প সময়ে অনেক payment request হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।', ...overrides.checkout }
  };

  app.use('/auth/google', createLimiter(settings.oauth, storeFor('oauth')));
  // A generous baseline leaves room for page loads, playback and parallel API calls.
  app.use('/api', createLimiter(settings.api, storeFor('api')));
  app.use('/api/upload-url', createLimiter(settings.upload, storeFor('upload')));
  const checkoutLimiter = createLimiter(settings.checkout, storeFor('checkout'));
  app.use('/api', (req, res, next) => {
    const checkout = req.method === 'POST' && /^\/(?:premium\/(?:videos|playlists)\/[^/]+\/purchase|me\/talent\/orders\/[^/]+\/checkout)$/.test(req.path);
    if (checkout) return checkoutLimiter(req, res, next);
    next();
  });
}
async function connectRequestLimitStore() {
  if (!redisClient) {
    console.warn('REDIS_URL is not set; rate limits use per-process memory and are not shared across instances.');
    return false;
  }
  try {
    await ensureRedisConnected();
    console.log('Shared Redis rate-limit store connected.');
    return true;
  } catch (error) {
    console.error('Could not connect to Redis; rate limits will fail open until it is available:', error.message);
    return false;
  }
}
async function closeRequestLimitStore() {
  if (redisClient?.isOpen) await redisClient.quit();
}

module.exports = { attachRequestLimits, createLimiter, clientIpKeyGenerator, connectRequestLimitStore, closeRequestLimitStore };
