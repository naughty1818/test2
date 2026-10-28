'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { attachRequestLimits, clientIpKeyGenerator } = require('../request-limits');

test('rate-limit keys use valid Cloudflare visitor IP instead of changing proxy IPs', () => {
  const a = { ip: '203.0.113.10', get: name => name === 'cf-connecting-ip' ? '198.51.100.42' : undefined };
  const b = { ip: '203.0.113.11', get: name => name === 'cf-connecting-ip' ? '198.51.100.42' : undefined };
  assert.equal(clientIpKeyGenerator(a), clientIpKeyGenerator(b));
});

test('rate-limit keys ignore malformed Cloudflare IP headers and use Express IP', () => {
  const req = { ip: '198.51.100.8', get: name => name === 'cf-connecting-ip' ? 'not-an-ip' : undefined };
  assert.equal(clientIpKeyGenerator(req), '198.51.100.8');
});

test('upload and checkout limits return retry guidance after the configured request count', async t => {
  const app = express();
  attachRequestLimits(app, {
    api: { limit: 50, windowMs: 60_000 },
    upload: { limit: 2, windowMs: 60_000 },
    checkout: { limit: 2, windowMs: 60_000 },
    oauth: { limit: 2, windowMs: 60_000 }
  });
  app.all('*', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function hit(path, method='POST') { return fetch(base+path, { method }); }

  assert.equal((await hit('/api/upload-url')).status, 200);
  assert.equal((await hit('/api/upload-url')).status, 200);
  const uploadLimited = await hit('/api/upload-url');
  assert.equal(uploadLimited.status, 429);
  assert.equal(uploadLimited.headers.get('retry-after'), '60');
  assert.equal((await uploadLimited.json()).retryAfterSeconds, 60);

  assert.equal((await hit('/api/premium/videos/example/purchase')).status, 200);
  assert.equal((await hit('/api/premium/videos/example/purchase')).status, 200);
  assert.equal((await hit('/api/premium/videos/example/purchase')).status, 429);
});

test('OAuth start limit blocks repeat bursts but emits HTTP 429', async t => {
  const app = express();
  attachRequestLimits(app, { api: { limit: 50 }, oauth: { limit: 1, windowMs: 60_000 } });
  app.get('*', (_req, res) => res.send('ok'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/auth/google')).status, 200);
  assert.equal((await fetch(base+'/auth/google')).status, 429);
});
