'use strict';
const { rateLimit } = require('express-rate-limit');

const RETRY_AFTER_SECONDS = windowMs => Math.max(1, Math.ceil(windowMs / 1000));
function createLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => req.method === 'OPTIONS',
    handler: (req, res) => {
      const retryAfterSeconds = RETRY_AFTER_SECONDS(windowMs);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: message, retryAfterSeconds });
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

  app.use('/auth/google', createLimiter(settings.oauth));
  // A generous baseline leaves room for page loads, playback and parallel API calls.
  app.use('/api', createLimiter(settings.api));
  app.use('/api/upload-url', createLimiter(settings.upload));
  const checkoutLimiter = createLimiter(settings.checkout);
  app.use('/api', (req, res, next) => {
    const checkout = req.method === 'POST' && /^\/(?:premium\/(?:videos|playlists)\/[^/]+\/purchase|me\/talent\/orders\/[^/]+\/checkout)$/.test(req.path);
    if (checkout) return checkoutLimiter(req, res, next);
    next();
  });
}

module.exports = { attachRequestLimits, createLimiter };
