require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);
const MAX_LIST = 100;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const VIEWER_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;
const ALLOWED_CATEGORIES = ['ভ্রমণ', 'রান্না', 'ক্রিয়েটর', 'গল্প', 'শেখা', 'অন্যান্য'];
const ALLOWED_VISIBILITIES = ['Public', 'Unlisted', 'Private'];

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  SESSION_SECRET
} = process.env;

const googleOAuthValues = [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI];
const GOOGLE_LOGIN_ENABLED = googleOAuthValues.every(Boolean);
const GOOGLE_OAUTH_PARTIAL = googleOAuthValues.some(Boolean) && !GOOGLE_LOGIN_ENABLED;
const missing = Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  SESSION_SECRET
}).filter(([, value]) => !value).map(([key]) => key);
if (missing.length || GOOGLE_OAUTH_PARTIAL || (SESSION_SECRET && SESSION_SECRET.length < 32)) {
  const extra = SESSION_SECRET && SESSION_SECRET.length < 32 ? 'SESSION_SECRET (minimum 32 characters)' : '';
  const required = missing.concat(extra ? [extra] : [], GOOGLE_OAUTH_PARTIAL ? ['GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (set all three or leave all blank)'] : []);
  console.error('ERROR / ত্রুটি: Required environment variables are missing or weak. Set these before starting: ' + required.join(', '));
  process.exit(1);
}
if (!Number.isFinite(MAX_FILE_MB) || MAX_FILE_MB <= 0) {
  console.error('ERROR / ত্রুটি: MAX_FILE_MB must be a positive number.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});

const app = express();
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use((req, res, next) => {
  const origin = process.env.APP_ORIGIN;
  if (origin && req.get('origin') === origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function signValue(value) { return `${value}.${hmac(value)}`; }
function verifyValue(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const raw = value.slice(0, dot);
  return timingSafeEqualText(value.slice(dot + 1), hmac(raw)) ? raw : null;
}
function parseCookies(req) {
  const result = {};
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return result;
}
function secureCookie(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}
function setCookie(res, req, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${options.sameSite || 'Lax'}`, 'HttpOnly'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure !== false && secureCookie(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, req, name) {
  setCookie(res, req, name, '', { maxAge: 0, expires: new Date(0) });
}
function jsonError(res, status, error, extra) { return res.status(status).json(Object.assign({ error }, extra || {})); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function subHash(sub) { return sha(sub); }
function isNotFound(err) { return err && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata && err.$metadata.httpStatusCode === 404); }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function legacyId(value) { return typeof value === 'string' && /^\d+-[0-9a-f]{8}$/i.test(value); }
function validVideoId(value) { return uuid(value) || legacyId(value); }
function idFromMetaKey(key) {
  const match = /^meta\/([^/]+)\.json$/.exec(key || '');
  return match && validVideoId(match[1]) ? match[1] : null;
}
function safeText(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''; }
function normalizeCategory(value) { return ALLOWED_CATEGORIES.includes(value) ? value : null; }
function normalizeVisibility(value) {
  if (ALLOWED_VISIBILITIES.includes(value)) return value;
  const lower = typeof value === 'string' ? value.toLowerCase() : '';
  return lower === 'public' ? 'Public' : lower === 'unlisted' ? 'Unlisted' : lower === 'private' ? 'Private' : null;
}
function safeFilename(filename) {
  const base = path.basename(String(filename || '')).normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return base || 'video';
}
function safeHandle(value) {
  return safeText(value, 30).toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30);
}
function suggestedHandle(user) {
  let base = safeHandle((user.email || '').split('@')[0]) || 'creator';
  if (base.length < 3) base = `${base}creator`;
  return base.slice(0, 22);
}
function publicProfile(profile) {
  if (!profile) return null;
  return { displayName: profile.displayName || 'Creator', handle: profile.handle || null, bio: profile.bio || '', avatarUrl: profile.avatarUrl || null };
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: JSON.stringify(value), ContentType: 'application/json; charset=utf-8' }));
}
async function getJson(key) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return JSON.parse(await result.Body.transformToString());
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
async function deleteKey(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}
async function listKeys(prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const result = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken }));
    for (const item of result.Contents || []) if (item.Key) keys.push(item.Key);
    ContinuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}
async function listJson(prefix) {
  const records = [];
  for (const key of await listKeys(prefix)) {
    const value = await getJson(key);
    if (value) records.push({ key, value });
  }
  return records;
}
async function objectHead(key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
  catch (err) { if (isNotFound(err)) return null; throw err; }
}

async function loadProfile(sub) {
  return getJson(`profiles/${subHash(sub)}.json`);
}
async function loadSession(req) {
  const raw = verifyValue(parseCookies(req).vh_session);
  if (!raw || raw.length < 32) return null;
  const session = await getJson(`sessions/${sha(raw)}.json`);
  if (!session || !session.sub || !session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) await deleteKey(`sessions/${sha(raw)}.json`).catch(() => {});
    return null;
  }
  return { token: raw, session, profile: await loadProfile(session.sub) };
}
async function requireAuth(req, res, next) {
  try {
    req.auth = await loadSession(req);
    if (!req.auth) return jsonError(res, 401, 'Authentication required / লগইন আবশ্যক।');
    next();
  } catch (err) { next(err); }
}
async function saveSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await putJson(`sessions/${sha(token)}.json`, {
    sub: user.sub,
    email: user.email,
    name: user.name || '',
    picture: user.picture || null,
    emailVerified: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  });
  setCookie(res, req, 'vh_session', signValue(token), { maxAge: SESSION_TTL_SECONDS });
}
function sessionUser(session) {
  return { email: session.email, name: session.name, picture: session.picture || null, emailVerified: true };
}
async function currentVideo(id) {
  if (!validVideoId(id)) return null;
  const meta = await getJson(`meta/${id}.json`);
  if (!meta) return null;
  return normalizeMeta(meta, id);
}
function normalizeMeta(meta, id) {
  const legacy = !meta.id || !meta.visibility;
  return Object.assign({}, meta, {
    id: id || meta.id,
    title: safeText(meta.title, 100) || 'Untitled video',
    description: safeText(meta.description, 5000),
    category: normalizeCategory(meta.category) || 'অন্যান্য',
    visibility: normalizeVisibility(meta.visibility) || 'Public',
    size: Number.isFinite(Number(meta.size)) ? Number(meta.size) : 0,
    created: meta.created || new Date(0).toISOString(),
    ownerSub: legacy ? null : meta.ownerSub || null,
    ownerHandle: legacy ? null : meta.ownerHandle || null,
    ownerName: legacy ? 'Video Hub' : (meta.ownerName || 'Creator'),
    legacy
  });
}
function card(meta) {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    visibility: meta.visibility,
    size: meta.size,
    created: meta.created,
    ownerHandle: meta.ownerHandle || null,
    ownerName: meta.ownerName || 'Video Hub',
    likesCount: meta.likesCount || 0,
    viewsCount: meta.viewsCount || 0
  };
}
async function interactionCount(prefix) { return (await listKeys(prefix)).length; }
async function refreshCounts(meta) {
  const [likesCount, viewsCount] = await Promise.all([interactionCount(`likes/${meta.id}/`), interactionCount(`views/${meta.id}/`)]);
  meta.likesCount = likesCount;
  meta.viewsCount = viewsCount;
  return meta;
}
async function cardsWithCounts(metas) {
  const subs = [...new Set(metas.map(meta => meta.ownerSub).filter(Boolean))];
  const profiles = new Map(await Promise.all(subs.map(async sub => [sub, await loadProfile(sub)])));
  return Promise.all(metas.map(async meta => {
    const profile = meta.ownerSub && profiles.get(meta.ownerSub);
    const currentMeta = profile ? Object.assign({}, meta, { ownerName: profile.displayName, ownerHandle: profile.handle }) : meta;
    return card(await refreshCounts(currentMeta));
  }));
}
async function accessAllowed(meta, auth) {
  return meta.visibility !== 'Private' || !!(auth && auth.session.sub === meta.ownerSub);
}
async function detailResponse(meta, req) {
  const auth = req.auth;
  if (!await accessAllowed(meta, auth)) return null;
  const head = await objectHead(meta.objectName);
  if (!head) return 'missing';
  const [profile, likesCount, viewsCount] = await Promise.all([
    meta.ownerSub ? loadProfile(meta.ownerSub) : Promise.resolve(null),
    interactionCount(`likes/${meta.id}/`), interactionCount(`views/${meta.id}/`)
  ]);
  let liked = false;
  if (auth) liked = !!(await getJson(`likes/${meta.id}/${subHash(auth.session.sub)}.json`));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: meta.objectName }), { expiresIn: 60 * 60 });
  const currentMeta = profile ? Object.assign({}, meta, { ownerName: profile.displayName, ownerHandle: profile.handle }) : meta;
  const video = Object.assign(card(Object.assign(currentMeta, { likesCount, viewsCount })), {
    objectName: undefined,
    url,
    profile: publicProfile(profile),
    channel: profile ? { handle: profile.handle, displayName: profile.displayName } : null,
    liked
  });
  return { video, likesCount, viewsCount, liked };
}
async function listVideoMetas() {
  const records = [];
  for (const key of await listKeys('meta/')) {
    const id = idFromMetaKey(key);
    if (!id) continue;
    try {
      const meta = await getJson(key);
      if (meta) records.push(normalizeMeta(meta, id));
    } catch (err) { console.error('Skipping malformed metadata', key, err.message); }
  }
  return records.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

app.get('/api/config', (req, res) => res.json({ maxFileMb: MAX_FILE_MB, googleLoginEnabled: GOOGLE_LOGIN_ENABLED }));

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return jsonError(res, 503, 'Google OAuth এখনো কনফিগার করা হয়নি / Google OAuth is not configured.');
  const state = crypto.randomBytes(32).toString('base64url');
  setCookie(res, req, 'vh_oauth_state', signValue(state), { maxAge: OAUTH_STATE_TTL_SECONDS });
  const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!GOOGLE_LOGIN_ENABLED) return jsonError(res, 503, 'Google OAuth এখনো কনফিগার করা হয়নি / Google OAuth is not configured.');
    const state = String(req.query.state || '');
    const expected = verifyValue(parseCookies(req).vh_oauth_state);
    clearCookie(res, req, 'vh_oauth_state');
    if (!state || !expected || !timingSafeEqualText(state, expected)) return jsonError(res, 400, 'OAuth state invalid or expired / OAuth state ভুল বা মেয়াদোত্তীর্ণ।');
    if (req.query.error) return jsonError(res, 400, `Google login failed: ${safeText(req.query.error, 100)}`);
    if (!req.query.code) return jsonError(res, 400, 'Google authorization code missing.');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' })
    });
    if (!tokenResponse.ok) throw new Error(`Google token exchange failed (${tokenResponse.status})`);
    const token = await tokenResponse.json();
    if (!token.access_token) throw new Error('Google did not return an access token.');
    const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) throw new Error(`Google userinfo failed (${userResponse.status})`);
    const info = await userResponse.json();
    if (!info.sub || !info.email || (info.email_verified !== true && info.email_verified !== 'true')) return jsonError(res, 403, 'Google account email is not verified / Google email verified নয়।');
    await saveSession(req, res, { sub: String(info.sub), email: String(info.email).toLowerCase(), name: safeText(info.name, 120), picture: typeof info.picture === 'string' ? info.picture.slice(0, 1000) : null });
    const existing = await loadProfile(String(info.sub));
    if (!existing) {
      let handle = suggestedHandle(info);
      for (let i = 0; i < 5 && await getJson(`handles/${handle}.json`); i++) handle = `${suggestedHandle(info).slice(0, 22)}-${crypto.randomBytes(2).toString('hex')}`;
      const profile = { sub: String(info.sub), displayName: safeText(info.name, 120) || 'Creator', handle, bio: '', avatarUrl: typeof info.picture === 'string' ? info.picture.slice(0, 1000) : null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await putJson(`profiles/${subHash(info.sub)}.json`, profile);
      await putJson(`handles/${handle}.json`, { sub: String(info.sub), createdAt: profile.createdAt });
    }
    res.redirect(process.env.APP_ORIGIN || '/');
  } catch (err) { next(err); }
});

app.get('/auth/me', async (req, res, next) => {
  try {
    const auth = await loadSession(req);
    res.json(auth ? { user: sessionUser(auth.session), profile: publicProfile(auth.profile) } : { user: null, profile: null });
  } catch (err) { next(err); }
});
app.post('/auth/logout', async (req, res, next) => {
  try {
    const raw = verifyValue(parseCookies(req).vh_session);
    if (raw) await deleteKey(`sessions/${sha(raw)}.json`).catch(() => {});
    clearCookie(res, req, 'vh_session');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/me/profile', requireAuth, async (req, res, next) => {
  try {
    const requestedHandle = safeHandle(req.body && req.body.handle);
    const displayName = safeText(req.body && req.body.displayName, 120);
    const bio = safeText(req.body && req.body.bio, 1000);
    if (!displayName) return jsonError(res, 400, 'displayName is required / নাম আবশ্যক।');
    if (!requestedHandle || requestedHandle.length < 3) return jsonError(res, 400, 'handle must be 3-30 letters, numbers, dots, dashes or underscores.');
    const existing = await loadProfile(req.auth.session.sub);
    if (existing && existing.handle !== requestedHandle) {
      const owner = await getJson(`handles/${requestedHandle}.json`);
      if (owner && owner.sub !== req.auth.session.sub) return jsonError(res, 409, 'That handle is already taken / এই handle নেওয়া আছে।', { suggestedHandle: `${requestedHandle.slice(0, 24)}-${crypto.randomBytes(2).toString('hex')}` });
      if (existing.handle) await deleteKey(`handles/${existing.handle}.json`);
    } else if (!existing) {
      const owner = await getJson(`handles/${requestedHandle}.json`);
      if (owner && owner.sub !== req.auth.session.sub) return jsonError(res, 409, 'That handle is already taken / এই handle নেওয়া আছে।');
    }
    const profile = Object.assign({}, existing || {}, { sub: req.auth.session.sub, displayName, handle: requestedHandle, bio, avatarUrl: existing && existing.avatarUrl || req.auth.session.picture || null, updatedAt: new Date().toISOString() });
    await putJson(`profiles/${subHash(req.auth.session.sub)}.json`, profile);
    await putJson(`handles/${requestedHandle}.json`, { sub: req.auth.session.sub, updatedAt: profile.updatedAt });
    res.json({ profile: publicProfile(profile) });
  } catch (err) { next(err); }
});

app.get('/api/channels/:handle', async (req, res, next) => {
  try {
    const handle = safeHandle(decodeURIComponent(req.params.handle || ''));
    if (!handle || handle !== req.params.handle.toLowerCase()) return jsonError(res, 400, 'Invalid handle.');
    const marker = await getJson(`handles/${handle}.json`);
    if (!marker || !marker.sub) return jsonError(res, 404, 'Channel not found / চ্যানেল পাওয়া যায়নি।');
    const profile = await loadProfile(marker.sub);
    if (!profile) return jsonError(res, 404, 'Channel not found / চ্যানেল পাওয়া যায়নি।');
    const videos = await cardsWithCounts((await listVideoMetas()).filter(video => video.visibility === 'Public' && video.ownerSub === marker.sub));
    res.json({ profile: publicProfile(profile), videos });
  } catch (err) { next(err); }
});

app.get('/api/videos', async (req, res, next) => {
  try {
    const query = safeText(req.query.query, 100).toLowerCase();
    const category = req.query.category ? normalizeCategory(String(req.query.category)) : null;
    if (req.query.category && !category) return jsonError(res, 400, 'Invalid category / category সঠিক নয়।');
    const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(req.query.limit || '24', 10) || 24));
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
    const all = await listVideoMetas();
    const filtered = all.filter(video => video.visibility === 'Public' && (!category || video.category === category) && (!query || `${video.title} ${video.description} ${video.ownerName} ${video.ownerHandle || ''}`.toLowerCase().includes(query)));
    const page = filtered.slice(offset, offset + limit);
    res.json({ videos: await cardsWithCounts(page), hasMore: offset + page.length < filtered.length });
  } catch (err) { next(err); }
});

app.get('/api/videos/:id', async (req, res, next) => {
  try {
    const meta = await currentVideo(req.params.id);
    if (!meta) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    const auth = await loadSession(req);
    req.auth = auth;
    if (!await accessAllowed(meta, auth)) return jsonError(res, 403, 'This video is private / ভিডিওটি private।');
    const result = await detailResponse(meta, req);
    if (result === 'missing') return jsonError(res, 404, 'Video file no longer exists / ভিডিও ফাইল নেই।');
    res.json(result);
  } catch (err) { next(err); }
});

async function interactionAccess(req, res, next) {
  try {
    const meta = await currentVideo(req.params.id);
    if (!meta) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    req.video = meta;
    req.auth = await loadSession(req);
    if (!await accessAllowed(meta, req.auth)) return jsonError(res, 403, 'This video is private / ভিডিওটি private।');
    next();
  } catch (err) { next(err); }
}
app.post('/api/videos/:id/views', interactionAccess, async (req, res, next) => {
  try {
    const cookies = parseCookies(req);
    let viewer = verifyValue(cookies.vh_viewer);
    if (!viewer || viewer.length < 20) { viewer = crypto.randomBytes(24).toString('base64url'); setCookie(res, req, 'vh_viewer', signValue(viewer), { maxAge: VIEWER_COOKIE_TTL_SECONDS }); }
    const markerKey = `views/${req.video.id}/${sha(viewer)}.json`;
    if (!await getJson(markerKey)) await putJson(markerKey, { videoId: req.video.id, createdAt: new Date().toISOString() });
    const viewsCount = await interactionCount(`views/${req.video.id}/`);
    res.json({ ok: true, viewsCount });
  } catch (err) { next(err); }
});
app.post('/api/videos/:id/like', requireAuth, async (req, res, next) => {
  try {
    const meta = await currentVideo(req.params.id);
    if (!meta) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    if (meta.visibility === 'Private' && meta.ownerSub !== req.auth.session.sub) return jsonError(res, 403, 'This video is private / ভিডিওটি private।');
    const key = `likes/${meta.id}/${subHash(req.auth.session.sub)}.json`;
    const already = await getJson(key);
    if (already) await deleteKey(key); else await putJson(key, { videoId: meta.id, sub: req.auth.session.sub, createdAt: new Date().toISOString() });
    res.json({ liked: !already, likesCount: await interactionCount(`likes/${meta.id}/`) });
  } catch (err) { next(err); }
});

app.post('/api/upload-url', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const filename = safeFilename(body.filename);
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    const size = Number(body.size);
    if (!body.filename || filename === 'video') return jsonError(res, 400, 'Filename is required / ফাইলের নাম আবশ্যক।');
    if (!/^video\/[a-z0-9.+-]+$/i.test(contentType) || contentType.length > 128) return jsonError(res, 400, 'Only supported video file types are allowed / শুধু video ফাইল দেওয়া যাবে।');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_MB * 1024 * 1024) return jsonError(res, 413, `File must be ${MAX_FILE_MB}MB or smaller / ফাইল ${MAX_FILE_MB}MB-এর মধ্যে হতে হবে।`);
    const title = safeText(body.title, 100);
    const category = normalizeCategory(body.category || 'অন্যান্য');
    const visibility = normalizeVisibility(body.visibility || 'Public');
    if (body.title !== undefined && !title) return jsonError(res, 400, 'Invalid title / title সঠিক নয়।');
    if (!category) return jsonError(res, 400, 'Invalid category / category সঠিক নয়।');
    if (!visibility) return jsonError(res, 400, 'Invalid visibility / visibility সঠিক নয়।');
    const id = crypto.randomUUID();
    const objectName = `videos/${id}-${filename}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await putJson(`pending/${id}.json`, { id, objectName, contentType, expectedSize: size, title, description: safeText(body.description, 5000), category, visibility, sub: req.auth.session.sub, createdAt: new Date().toISOString(), expiresAt });
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectName, ContentType: contentType }), { expiresIn: 30 * 60 });
    res.json({ uploadUrl, objectName, id, expiresAt });
  } catch (err) { next(err); }
});

app.post('/api/finish', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const intentId = typeof body.id === 'string' ? body.id : (typeof body.intentId === 'string' ? body.intentId : '');
    if (!uuid(intentId)) return jsonError(res, 400, 'A valid upload intent id is required / upload intent id সঠিক নয়।');
    const intent = await getJson(`pending/${intentId}.json`);
    if (!intent || intent.id !== intentId || intent.sub !== req.auth.session.sub) return jsonError(res, 403, 'Upload intent not found or not yours / upload অনুমতি নেই।');
    if (Date.parse(intent.expiresAt) <= Date.now()) return jsonError(res, 410, 'Upload intent expired / upload-এর সময় শেষ।');
    if (body.objectName !== undefined && body.objectName !== intent.objectName) return jsonError(res, 400, 'Object name does not match the upload intent.');
    const title = body.title === undefined ? intent.title : safeText(body.title, 100);
    const description = body.description === undefined ? intent.description : safeText(body.description, 5000);
    const category = body.category === undefined ? intent.category : normalizeCategory(body.category);
    const visibility = body.visibility === undefined ? intent.visibility : normalizeVisibility(body.visibility);
    if (!title || !category || !visibility) return jsonError(res, 400, 'title, category and visibility are required / title, category, visibility আবশ্যক।');
    const head = await objectHead(intent.objectName);
    if (!head) return jsonError(res, 404, 'Uploaded file not found in R2 / R2-তে ফাইল পাওয়া যায়নি।');
    if (Number(head.ContentLength) !== Number(intent.expectedSize) || Number(head.ContentLength) > MAX_FILE_MB * 1024 * 1024) {
      await deleteKey(intent.objectName).catch(() => {});
      return jsonError(res, 413, 'Uploaded file size does not match the intent / ফাইলের size মেলেনি।');
    }
    if (head.ContentType && head.ContentType !== intent.contentType) return jsonError(res, 400, 'Uploaded file type does not match the intent / file type মেলেনি।');
    const profile = await loadProfile(req.auth.session.sub);
    const meta = { id: intent.id, objectName: intent.objectName, title, description, category, visibility, size: Number(head.ContentLength), created: new Date().toISOString(), ownerSub: req.auth.session.sub, ownerHandle: profile && profile.handle || null, ownerName: profile && profile.displayName || req.auth.session.name || 'Creator', ownerProfile: publicProfile(profile), likesCount: 0, viewsCount: 0 };
    await putJson(`meta/${intent.id}.json`, meta);
    await deleteKey(`pending/${intent.id}.json`);
    res.json({ ok: true, video: card(meta) });
  } catch (err) { next(err); }
});

app.delete('/api/videos/:id', requireAuth, async (req, res, next) => {
  try {
    const meta = await currentVideo(req.params.id);
    if (!meta) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    if (!meta.ownerSub || meta.ownerSub !== req.auth.session.sub) return jsonError(res, 403, 'Only the owner can delete this video / শুধু owner delete করতে পারবেন।');
    if (!meta.objectName || !/^videos\/[0-9a-f-]+-[a-zA-Z0-9._-]+$/i.test(meta.objectName)) return jsonError(res, 409, 'Video object is invalid; not deleted.');
    await deleteKey(meta.objectName);
    await deleteKey(`meta/${meta.id}.json`);
    for (const prefix of [`likes/${meta.id}/`, `views/${meta.id}/`]) for (const key of await listKeys(prefix)) await deleteKey(key);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.statusCode || 500).json({ error: 'Server error / সার্ভার ত্রুটি।', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Video Hub chalu / running on port ${PORT}`));
