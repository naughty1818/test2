'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { attachRequestLimits } = require('../request-limits');

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
