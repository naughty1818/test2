'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server: SocketServer } = require('socket.io');
const {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool, initializeDatabase, withTransaction } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);
const MAX_LIST = 100;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const VIEWER_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;
const ALLOWED_CATEGORIES = ['ভ্রমণ', 'রান্না', 'ক্রিয়েটর', 'গল্প', 'শেখা', 'অন্যান্য'];
const ALLOWED_VISIBILITIES = ['Public', 'Unlisted', 'Private'];
const {
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, SESSION_SECRET
} = process.env;
const googleValues = [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI];
const GOOGLE_LOGIN_ENABLED = googleValues.every(Boolean);
const GOOGLE_OAUTH_PARTIAL = googleValues.some(Boolean) && !GOOGLE_LOGIN_ENABLED;
const requiredMissing = Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, SESSION_SECRET })
  .filter(([, value]) => !value).map(([key]) => key);
if (requiredMissing.length || GOOGLE_OAUTH_PARTIAL || (SESSION_SECRET && SESSION_SECRET.length < 32)) {
  const weak = SESSION_SECRET && SESSION_SECRET.length < 32 ? ['SESSION_SECRET (minimum 32 characters)'] : [];
  const partial = GOOGLE_OAUTH_PARTIAL ? ['GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (set all three or leave blank)'] : [];
  console.error('ERROR / ত্রুটি: Required environment variables are missing or weak: ' + [...requiredMissing, ...weak, ...partial].join(', '));
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
const server = http.createServer(app);
const io = new SocketServer(server, {
  serveClient: true,
  ...(process.env.APP_ORIGIN ? { cors: { origin: process.env.APP_ORIGIN, credentials: true } } : {})
});
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

const VIDEO_SELECT = `
  SELECT v.id, v.object_name, v.owner_sub, v.title, v.description, v.category,
         v.visibility, v.size, v.created_at, v.legacy, v.likes_count,
         v.views_count, v.comments_count,
         p.handle AS owner_handle,
         COALESCE(NULLIF(p.display_name,''), NULLIF(u.google_name,''), 'ClipNest নির্মাতা') AS owner_name,
         p.avatar_url AS owner_avatar
  FROM videos v
  LEFT JOIN profiles p ON p.sub = v.owner_sub
  LEFT JOIN app_users u ON u.google_sub = v.owner_sub
`;

function hmac(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
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
function parseCookieHeader(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch (_) { /* Ignore a malformed cookie instead of failing the request. */ }
  }
  return result;
}
function parseCookies(req) { return parseCookieHeader(req.get('cookie') || ''); }
function secureCookie(req) { return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https'; }
function setCookie(res, req, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${options.sameSite || 'Lax'}`, 'HttpOnly'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure !== false && secureCookie(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, req, name) { setCookie(res, req, name, '', { maxAge: 0, expires: new Date(0) }); }
function jsonError(res, status, error, extra) { return res.status(status).json(Object.assign({ error }, extra || {})); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function validUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validVideoId(value) { return typeof value === 'string' && (validUuid(value) || /^\d+-[0-9a-f]{8}$/i.test(value)); }
function safeText(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''; }
function normalizeCategory(value) { return ALLOWED_CATEGORIES.includes(value) ? value : null; }
function normalizeVisibility(value) {
  if (ALLOWED_VISIBILITIES.includes(value)) return value;
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return lower === 'public' ? 'Public' : lower === 'unlisted' ? 'Unlisted' : lower === 'private' ? 'Private' : null;
}
function safeFilename(filename) {
  const base = path.basename(String(filename || '')).normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return base || 'video';
}
function safeHandle(value) { return safeText(value, 30).toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30); }
function suggestedHandle(user) {
  let base = safeHandle((user.email || '').split('@')[0]) || 'creator';
  if (base.length < 3) base = `${base}creator`;
  return base.slice(0, 22);
}
function publicProfile(profile) {
  if (!profile) return null;
  return { displayName: profile.display_name || profile.displayName || 'Creator', handle: profile.handle || null, bio: profile.bio || '', avatarUrl: profile.avatar_url || profile.avatarUrl || null };
}
function toISO(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function videoCard(row) {
  return {
    id: row.id, title: row.title, description: row.description, category: row.category,
    visibility: row.visibility, size: Number(row.size) || 0, created: toISO(row.created_at),
    ownerHandle: row.owner_handle || null, ownerName: row.owner_name || 'ClipNest নির্মাতা',
    ownerAvatar: row.owner_avatar || null, likesCount: Number(row.likes_count) || 0,
    viewsCount: Number(row.views_count) || 0, commentsCount: Number(row.comments_count) || 0,
    liked: Boolean(row.liked), watchLater: Boolean(row.watch_later)
  };
}
function requireValidId(req, res, next) {
  if (!validVideoId(req.params.id)) return jsonError(res, 400, 'Invalid video id.');
  next();
}
async function loadProfile(sub, client = pool) {
  const result = await client.query('SELECT sub,handle,display_name,bio,avatar_url,created_at,updated_at FROM profiles WHERE sub=$1', [sub]);
  return result.rows[0] || null;
}
async function loadSession(req) {
  const raw = verifyValue(parseCookies(req).vh_session);
  if (!raw || raw.length < 32) return null;
  const result = await pool.query(`
    SELECT s.sub, s.expires_at, u.email, u.google_name, u.google_picture,
           p.handle, p.display_name, p.bio, p.avatar_url
    FROM sessions s JOIN app_users u ON u.google_sub=s.sub
    LEFT JOIN profiles p ON p.sub=s.sub
    WHERE s.token_hash=$1 AND s.expires_at>NOW()
  `, [sha(raw)]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const session = { sub: row.sub, email: row.email, name: row.google_name || '', picture: row.google_picture || null, emailVerified: true, expiresAt: toISO(row.expires_at) };
  const profile = row.handle ? { sub: row.sub, handle: row.handle, display_name: row.display_name, bio: row.bio, avatar_url: row.avatar_url } : null;
  return { token: raw, session, profile };
}
async function requireAuth(req, res, next) {
  try {
    req.auth = await loadSession(req);
    if (!req.auth) return jsonError(res, 401, 'Authentication required / লগইন আবশ্যক।');
    next();
  } catch (error) { next(error); }
}
async function saveSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await withTransaction(async client => {
    await client.query(`INSERT INTO app_users (google_sub,email,google_name,google_picture) VALUES ($1,$2,$3,$4)
      ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email, google_name=EXCLUDED.google_name, google_picture=EXCLUDED.google_picture, updated_at=NOW()`, [user.sub, user.email, user.name || '', user.picture || null]);
    let profile = await loadProfile(user.sub, client);
    if (!profile) {
      const base = suggestedHandle(user);
      let created = false;
      for (let attempt = 0; attempt < 8 && !created; attempt++) {
        const handle = attempt === 0 ? base : `${base.slice(0, 20)}-${crypto.randomBytes(2).toString('hex')}`;
        const inserted = await client.query(`INSERT INTO profiles (sub,handle,display_name,bio,avatar_url)
          VALUES ($1,$2,$3,'',$4) ON CONFLICT (handle) DO NOTHING RETURNING sub`, [user.sub, handle, user.name || 'Creator', user.picture || null]);
        created = inserted.rowCount === 1;
      }
      if (!created) throw new Error('Could not allocate a unique channel handle.');
    }
    await client.query('DELETE FROM sessions WHERE expires_at < NOW()');
    await client.query('INSERT INTO sessions (token_hash,sub,expires_at) VALUES ($1,$2,$3)', [sha(token), user.sub, new Date(Date.now() + SESSION_TTL_SECONDS * 1000)]);
  });
  setCookie(res, req, 'vh_session', signValue(token), { maxAge: SESSION_TTL_SECONDS });
}
function sessionUser(session) { return { email: session.email, name: session.name, picture: session.picture || null, emailVerified: true }; }
async function ensureWatchLater(sub, client = pool) {
  const found = await client.query('SELECT id FROM playlists WHERE owner_sub=$1 AND is_watch_later=TRUE', [sub]);
  if (found.rowCount) return found.rows[0].id;
  const id = crypto.randomUUID();
  await client.query(`INSERT INTO playlists (id,owner_sub,name,is_public,is_watch_later) VALUES ($1,$2,'পরে দেখব',FALSE,TRUE) ON CONFLICT DO NOTHING`, [id, sub]);
  const again = await client.query('SELECT id FROM playlists WHERE owner_sub=$1 AND is_watch_later=TRUE', [sub]);
  return again.rows[0].id;
}
async function getVideo(id) {
  if (!validVideoId(id)) return null;
  const result = await pool.query(VIDEO_SELECT + ' WHERE v.id=$1', [id]);
  return result.rows[0] || null;
}
async function canView(video, sub) { return video.visibility !== 'Private' || Boolean(sub && video.owner_sub === sub); }
async function loadCards({ category = '', query = '', limit = 24, offset = 0, userSub = null, ownerSub = null, subscriptions = false, playlistId = null, history = false } = {}) {
  const safeLimit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(limit, 10) || 24));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const params = [];
  let from = `${VIDEO_SELECT}`;
  let where = [];
  if (subscriptions) {
    params.push(userSub);
    from += ' JOIN subscriptions fs ON fs.channel_sub=v.owner_sub';
    where.push(`fs.subscriber_sub=$${params.length}`, `v.visibility='Public'`);
  } else if (history) {
    params.push(userSub);
    from += ' JOIN watch_history wh ON wh.video_id=v.id';
    where.push(`wh.user_sub=$${params.length}`, `(v.visibility='Public' OR v.owner_sub=$${params.length})`);
  } else if (playlistId) {
    params.push(playlistId);
    from += ' JOIN playlist_items pi ON pi.video_id=v.id';
    where.push(`pi.playlist_id=$${params.length}`);
    if (!ownerSub) where.push(`v.visibility='Public'`);
    else { params.push(ownerSub); where.push(`(v.visibility='Public' OR v.owner_sub=$${params.length})`); }
  } else if (ownerSub) {
    params.push(ownerSub);
    where.push(`v.owner_sub=$${params.length}`);
  } else {
    where.push(`v.visibility='Public'`);
  }
  if (category) { params.push(category); where.push(`v.category=$${params.length}`); }
  if (query) { params.push(`%${query}%`); where.push(`(v.title ILIKE $${params.length} OR v.description ILIKE $${params.length} OR p.display_name ILIKE $${params.length} OR p.handle ILIKE $${params.length})`); }
  let order = history ? 'wh.last_watched_at DESC' : playlistId ? 'pi.position ASC, pi.added_at DESC' : 'v.created_at DESC';
  if (subscriptions) order = 'v.created_at DESC';
  const filterSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (userSub) {
    params.push(userSub);
    const userPosition = params.length;
    from += ` LEFT JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM video_likes l WHERE l.video_id=v.id AND l.user_sub=$${userPosition}) AS liked) ul ON TRUE`;
    from += ` LEFT JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM playlists pl JOIN playlist_items pi2 ON pi2.playlist_id=pl.id WHERE pl.owner_sub=$${userPosition} AND pl.is_watch_later=TRUE AND pi2.video_id=v.id) AS watch_later) uw ON TRUE`;
  } else {
    from += ' LEFT JOIN LATERAL (SELECT FALSE AS liked) ul ON TRUE LEFT JOIN LATERAL (SELECT FALSE AS watch_later) uw ON TRUE';
  }
  // VIDEO_SELECT already contains the profile/user joins; append interaction states to the select list.
  const selectSql = from.replace('SELECT v.id,', 'SELECT COALESCE(ul.liked,FALSE) AS liked, COALESCE(uw.watch_later,FALSE) AS watch_later, v.id,');
  params.push(safeLimit + 1, safeOffset);
  const limitPos = params.length - 1;
  const offsetPos = params.length;
  const result = await pool.query(`${selectSql}${filterSql} ORDER BY ${order} LIMIT $${limitPos} OFFSET $${offsetPos}`, params);
  const rows = result.rows.slice(0, safeLimit);
  return { videos: rows.map(videoCard), hasMore: result.rows.length > safeLimit };
}
async function getCounts(videoId) {
  const result = await pool.query('SELECT likes_count,views_count,comments_count FROM videos WHERE id=$1', [videoId]);
  return result.rows[0] ? { likesCount: Number(result.rows[0].likes_count), viewsCount: Number(result.rows[0].views_count), commentsCount: Number(result.rows[0].comments_count) } : null;
}
function emitVideoStats(videoId, counts) {
  if (counts) io.to(`video:${videoId}`).emit('video:stats', { videoId, ...counts });
}
function emitChannelStats(handle, subscribersCount) {
  if (handle) io.to(`channel:${handle}`).emit('channel:stats', { handle, subscribersCount });
}
async function signedVideoUrl(objectName) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectName }), { expiresIn: 60 * 60 });
}
async function objectHead(key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
  catch (error) { if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null; throw error; }
}
async function accessVideo(req, res, next) {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    req.video = video;
    req.auth = req.auth || await loadSession(req);
    if (!await canView(video, req.auth?.session.sub)) return jsonError(res, 403, 'This video is private / ভিডিওটি private।');
    next();
  } catch (error) { next(error); }
}
function channelRoom(handle) { return `channel:${handle}`; }

app.get('/api/config', (req, res) => res.json({ maxFileMb: MAX_FILE_MB, googleLoginEnabled: GOOGLE_LOGIN_ENABLED, realtimeEnabled: true, database: 'Neon PostgreSQL' }));

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
    res.redirect(process.env.APP_ORIGIN || '/');
  } catch (error) { next(error); }
});
app.get('/auth/me', async (req, res, next) => {
  try {
    const auth = await loadSession(req);
    res.json(auth ? { user: sessionUser(auth.session), profile: publicProfile(auth.profile) } : { user: null, profile: null });
  } catch (error) { next(error); }
});
app.post('/auth/logout', async (req, res, next) => {
  try {
    const raw = verifyValue(parseCookies(req).vh_session);
    if (raw) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha(raw)]);
    clearCookie(res, req, 'vh_session');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/me/profile', requireAuth, async (req, res, next) => {
  try {
    const requestedHandle = safeHandle(req.body?.handle);
    const displayName = safeText(req.body?.displayName, 120);
    const bio = safeText(req.body?.bio, 1000);
    if (!displayName) return jsonError(res, 400, 'displayName is required / নাম আবশ্যক।');
    if (!requestedHandle || requestedHandle.length < 3) return jsonError(res, 400, 'handle must be 3-30 letters, numbers, dots, dashes or underscores.');
    const existing = await loadProfile(req.auth.session.sub);
    const conflict = await pool.query('SELECT sub FROM profiles WHERE handle=$1 AND sub<>$2', [requestedHandle, req.auth.session.sub]);
    if (conflict.rowCount) return jsonError(res, 409, 'That handle is already taken / এই handle নেওয়া আছে।', { suggestedHandle: `${requestedHandle.slice(0, 24)}-${crypto.randomBytes(2).toString('hex')}` });
    const profile = await withTransaction(async client => {
      const result = await client.query(`INSERT INTO profiles (sub,handle,display_name,bio,avatar_url)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sub) DO UPDATE SET handle=EXCLUDED.handle,display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,updated_at=NOW() RETURNING sub,handle,display_name,bio,avatar_url`,
        [req.auth.session.sub, requestedHandle, displayName, bio, existing?.avatar_url || req.auth.session.picture || null]);
      return result.rows[0];
    });
    res.json({ profile: publicProfile(profile) });
  } catch (error) { next(error); }
});

app.get('/api/channels', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const result = await pool.query(`SELECT p.handle,p.display_name,p.bio,p.avatar_url,
      (SELECT COUNT(*) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public')::bigint AS videos_count,
      (SELECT COALESCE(SUM(v.views_count),0) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public')::bigint AS views_count,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_sub=p.sub)::bigint AS subscribers_count,
      (SELECT MAX(v.created_at) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public') AS latest_video
      FROM profiles p WHERE EXISTS(SELECT 1 FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public')
      ORDER BY latest_video DESC LIMIT $1`, [limit]);
    res.json({ channels: result.rows.map(row => ({ handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, videosCount: Number(row.videos_count), viewsCount: Number(row.views_count), subscribersCount: Number(row.subscribers_count) })) });
  } catch (error) { next(error); }
});
app.get('/api/channels/:handle', async (req, res, next) => {
  try {
    const handle = safeHandle(decodeURIComponent(req.params.handle || ''));
    if (!handle || handle !== req.params.handle.toLowerCase()) return jsonError(res, 400, 'Invalid handle.');
    const found = await pool.query(`SELECT p.sub,p.handle,p.display_name,p.bio,p.avatar_url,p.created_at,COUNT(DISTINCT s.subscriber_sub)::bigint AS subscribers_count
      FROM profiles p LEFT JOIN subscriptions s ON s.channel_sub=p.sub WHERE p.handle=$1 GROUP BY p.sub`, [handle]);
    if (!found.rowCount) return jsonError(res, 404, 'Channel not found / চ্যানেল পাওয়া যায়নি।');
    const row = found.rows[0];
    const auth = await loadSession(req);
    const [feed, subResult] = await Promise.all([
      loadCards({ ownerSub: row.sub, userSub: auth?.session.sub, limit: MAX_LIST }),
      auth ? pool.query('SELECT 1 FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [auth.session.sub, row.sub]) : Promise.resolve({ rowCount: 0 })
    ]);
    res.json({ profile: publicProfile(row), videos: feed.videos.filter(video => video.visibility === 'Public'), subscribersCount: Number(row.subscribers_count), subscribed: subResult.rowCount > 0, isOwner: auth?.session.sub === row.sub });
  } catch (error) { next(error); }
});
app.post('/api/channels/:handle/subscribe', requireAuth, async (req, res, next) => {
  try {
    const handle = safeHandle(req.params.handle);
    const found = await pool.query('SELECT sub,handle FROM profiles WHERE handle=$1', [handle]);
    if (!found.rowCount) return jsonError(res, 404, 'Channel not found.');
    const channel = found.rows[0];
    if (channel.sub === req.auth.session.sub) return jsonError(res, 400, 'You cannot subscribe to your own channel.');
    const result = await withTransaction(async client => {
      await client.query('SELECT google_sub FROM app_users WHERE google_sub=$1 FOR UPDATE', [req.auth.session.sub]);
      const existing = await client.query('SELECT 1 FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [req.auth.session.sub, channel.sub]);
      if (existing.rowCount) await client.query('DELETE FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [req.auth.session.sub, channel.sub]);
      else await client.query('INSERT INTO subscriptions (subscriber_sub,channel_sub) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.auth.session.sub, channel.sub]);
      const count = await client.query('SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE channel_sub=$1', [channel.sub]);
      const state = await client.query('SELECT 1 FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [req.auth.session.sub, channel.sub]);
      return { subscribed: state.rowCount > 0, subscribersCount: Number(count.rows[0].n) };
    });
    emitChannelStats(channel.handle, result.subscribersCount);
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/videos', async (req, res, next) => {
  try {
    const query = safeText(req.query.query, 100);
    const category = req.query.category ? normalizeCategory(String(req.query.category)) : '';
    if (req.query.category && !category) return jsonError(res, 400, 'Invalid category / category সঠিক নয়।');
    const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(req.query.limit || '24', 10) || 24));
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
    const auth = await loadSession(req);
    const data = await loadCards({ query, category, limit, offset, userSub: auth?.session.sub });
    res.json(data);
  } catch (error) { next(error); }
});
app.get('/api/videos/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(req.query.limit || '48', 10) || 48));
    res.json(await loadCards({ subscriptions: true, userSub: req.auth.session.sub, limit }));
  } catch (error) { next(error); }
});
app.get('/api/videos/:id', requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    const auth = await loadSession(req);
    if (!await canView(video, auth?.session.sub)) return jsonError(res, 403, 'This video is private / ভিডিওটি private।');
    if (!await objectHead(video.object_name)) return jsonError(res, 404, 'Video file no longer exists / ভিডিও ফাইল নেই।');
    const [liked, watchLater, profile, subscribers, subscribed] = await Promise.all([
      auth ? pool.query('SELECT 1 FROM video_likes WHERE video_id=$1 AND user_sub=$2', [video.id, auth.session.sub]) : Promise.resolve({ rowCount: 0 }),
      auth ? pool.query(`SELECT 1 FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id WHERE p.owner_sub=$1 AND p.is_watch_later=TRUE AND pi.video_id=$2`, [auth.session.sub, video.id]) : Promise.resolve({ rowCount: 0 }),
      video.owner_sub ? loadProfile(video.owner_sub) : Promise.resolve(null),
      video.owner_sub ? pool.query('SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE channel_sub=$1', [video.owner_sub]) : Promise.resolve({ rows: [{ n: 0 }] }),
      auth && video.owner_sub ? pool.query('SELECT 1 FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [auth.session.sub, video.owner_sub]) : Promise.resolve({ rowCount: 0 })
    ]);
    const card = videoCard({ ...video, liked: liked.rowCount > 0, watch_later: watchLater.rowCount > 0 });
    card.url = await signedVideoUrl(video.object_name);
    card.profile = publicProfile(profile);
    card.channel = profile ? { handle: profile.handle, displayName: profile.display_name } : null;
    card.subscribersCount = Number(subscribers.rows[0].n);
    card.subscribed = subscribed.rowCount > 0;
    res.json({ video: card, likesCount: card.likesCount, viewsCount: card.viewsCount, commentsCount: card.commentsCount, liked: card.liked, watchLater: card.watchLater });
  } catch (error) { next(error); }
});

app.post('/api/videos/:id/views', requireValidId, accessVideo, async (req, res, next) => {
  try {
    const cookies = parseCookies(req);
    let viewer = verifyValue(cookies.vh_viewer);
    if (!viewer || viewer.length < 20) {
      viewer = crypto.randomBytes(24).toString('base64url');
      setCookie(res, req, 'vh_viewer', signValue(viewer), { maxAge: VIEWER_COOKIE_TTL_SECONDS });
    }
    const result = await withTransaction(async client => {
      const inserted = await client.query('INSERT INTO video_views (video_id,viewer_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING video_id', [req.video.id, sha(viewer)]);
      if (inserted.rowCount) await client.query('UPDATE videos SET views_count=views_count+1 WHERE id=$1', [req.video.id]);
      if (req.auth?.session.sub) await client.query(`INSERT INTO watch_history (user_sub,video_id,last_watched_at) VALUES ($1,$2,NOW()) ON CONFLICT (user_sub,video_id) DO UPDATE SET last_watched_at=NOW()`, [req.auth.session.sub, req.video.id]);
      const counts = await client.query('SELECT views_count,likes_count,comments_count FROM videos WHERE id=$1', [req.video.id]);
      return { viewsCount: Number(counts.rows[0].views_count), likesCount: Number(counts.rows[0].likes_count), commentsCount: Number(counts.rows[0].comments_count), counted: inserted.rowCount > 0 };
    });
    emitVideoStats(req.video.id, result);
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});
app.post('/api/videos/:id/like', requireAuth, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!await canView(video, req.auth.session.sub)) return jsonError(res, 403, 'This video is private.');
    const result = await withTransaction(async client => {
      await client.query('SELECT id FROM videos WHERE id=$1 FOR UPDATE', [video.id]);
      const existing = await client.query('SELECT 1 FROM video_likes WHERE video_id=$1 AND user_sub=$2', [video.id, req.auth.session.sub]);
      if (existing.rowCount) await client.query('DELETE FROM video_likes WHERE video_id=$1 AND user_sub=$2', [video.id, req.auth.session.sub]);
      else await client.query('INSERT INTO video_likes (video_id,user_sub) VALUES ($1,$2) ON CONFLICT DO NOTHING', [video.id, req.auth.session.sub]);
      await client.query('UPDATE videos SET likes_count=(SELECT COUNT(*) FROM video_likes WHERE video_id=$1) WHERE id=$1', [video.id]);
      const state = await client.query('SELECT EXISTS(SELECT 1 FROM video_likes WHERE video_id=$1 AND user_sub=$2) AS liked, likes_count, views_count, comments_count FROM videos WHERE id=$1', [video.id, req.auth.session.sub]);
      return { liked: state.rows[0].liked, likesCount: Number(state.rows[0].likes_count), viewsCount: Number(state.rows[0].views_count), commentsCount: Number(state.rows[0].comments_count) };
    });
    emitVideoStats(video.id, result);
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/videos/:id/comments', requireValidId, accessVideo, async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const result = await pool.query(`SELECT c.id,c.video_id,c.parent_id,c.body,c.created_at,c.author_sub,
      p.handle,p.display_name,p.avatar_url,u.google_name
      FROM comments c JOIN app_users u ON u.google_sub=c.author_sub
      LEFT JOIN profiles p ON p.sub=c.author_sub
      WHERE c.video_id=$1 ORDER BY c.created_at DESC LIMIT $2`, [req.video.id, limit]);
    const comments = result.rows.reverse().map(row => ({ id: row.id, videoId: row.video_id, parentId: row.parent_id, body: row.body, createdAt: toISO(row.created_at), author: { handle: row.handle || null, displayName: row.display_name || row.google_name || 'Creator', avatarUrl: row.avatar_url || null } }));
    res.json({ comments });
  } catch (error) { next(error); }
});
app.post('/api/videos/:id/comments', requireAuth, requireValidId, accessVideo, async (req, res, next) => {
  try {
    const body = safeText(req.body?.body, 2000);
    const parentId = req.body?.parentId ? String(req.body.parentId) : null;
    if (!body) return jsonError(res, 400, 'Comment cannot be empty.');
    if (parentId && !validUuid(parentId)) return jsonError(res, 400, 'Invalid reply target.');
    if (parentId) {
      const parent = await pool.query('SELECT id FROM comments WHERE id=$1 AND video_id=$2 AND parent_id IS NULL', [parentId, req.video.id]);
      if (!parent.rowCount) return jsonError(res, 400, 'Reply target not found. Replies can be one level deep.');
    }
    const id = crypto.randomUUID();
    await withTransaction(async client => {
      await client.query('INSERT INTO comments (id,video_id,author_sub,parent_id,body) VALUES ($1,$2,$3,$4,$5)', [id, req.video.id, req.auth.session.sub, parentId, body]);
      await client.query('UPDATE videos SET comments_count=comments_count+1 WHERE id=$1', [req.video.id]);
    });
    const author = await pool.query('SELECT p.handle,p.display_name,p.avatar_url,u.google_name FROM app_users u LEFT JOIN profiles p ON p.sub=u.google_sub WHERE u.google_sub=$1', [req.auth.session.sub]);
    const row = author.rows[0];
    const comment = { id, videoId: req.video.id, parentId, body, createdAt: new Date().toISOString(), author: { handle: row.handle || null, displayName: row.display_name || row.google_name || 'Creator', avatarUrl: row.avatar_url || null } };
    io.to(`video:${req.video.id}`).emit('comment:new', comment);
    const counts = await getCounts(req.video.id);
    emitVideoStats(req.video.id, counts);
    res.status(201).json({ comment, commentsCount: counts.commentsCount });
  } catch (error) { next(error); }
});

app.get('/api/me/history', requireAuth, async (req, res, next) => {
  try { res.json(await loadCards({ history: true, userSub: req.auth.session.sub, limit: Math.min(MAX_LIST, Number(req.query.limit) || 48) })); }
  catch (error) { next(error); }
});
app.delete('/api/me/history', requireAuth, async (req, res, next) => {
  try { await pool.query('DELETE FROM watch_history WHERE user_sub=$1', [req.auth.session.sub]); res.json({ ok: true }); }
  catch (error) { next(error); }
});
app.get('/api/me/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT p.handle,p.display_name,p.bio,p.avatar_url,COUNT(DISTINCT v.id)::bigint AS videos_count,COUNT(DISTINCT s2.subscriber_sub)::bigint AS subscribers_count
      FROM subscriptions s JOIN profiles p ON p.sub=s.channel_sub
      LEFT JOIN videos v ON v.owner_sub=p.sub AND v.visibility='Public'
      LEFT JOIN subscriptions s2 ON s2.channel_sub=p.sub
      WHERE s.subscriber_sub=$1 GROUP BY p.sub ORDER BY MAX(s.created_at) DESC`, [req.auth.session.sub]);
    res.json({ channels: result.rows.map(row => ({ handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, videosCount: Number(row.videos_count), subscribersCount: Number(row.subscribers_count) })) });
  } catch (error) { next(error); }
});

app.get('/api/me/playlists', requireAuth, async (req, res, next) => {
  try {
    await ensureWatchLater(req.auth.session.sub);
    const result = await pool.query(`SELECT p.id,p.name,p.description,p.is_public,p.is_watch_later,p.created_at,COUNT(i.video_id)::bigint AS videos_count
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.owner_sub=$1 GROUP BY p.id ORDER BY p.is_watch_later DESC,p.updated_at DESC`, [req.auth.session.sub]);
    res.json({ playlists: result.rows.map(row => ({ id: row.id, name: row.name, description: row.description, isPublic: row.is_public, isWatchLater: row.is_watch_later, videosCount: Number(row.videos_count), createdAt: toISO(row.created_at) })) });
  } catch (error) { next(error); }
});
app.post('/api/me/playlists', requireAuth, async (req, res, next) => {
  try {
    const name = safeText(req.body?.name, 80);
    const description = safeText(req.body?.description, 500);
    if (!name) return jsonError(res, 400, 'Playlist name is required.');
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO playlists (id,owner_sub,name,description,is_public) VALUES ($1,$2,$3,$4,$5)', [id, req.auth.session.sub, name, description, Boolean(req.body?.isPublic)]);
    res.status(201).json({ playlist: { id, name, description, isPublic: Boolean(req.body?.isPublic), isWatchLater: false, videosCount: 0 } });
  } catch (error) { next(error); }
});
app.get('/api/playlists/:id', async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const auth = await loadSession(req);
    const result = await pool.query('SELECT * FROM playlists WHERE id=$1', [req.params.id]);
    const playlist = result.rows[0];
    if (!playlist || (!playlist.is_public && playlist.owner_sub !== auth?.session.sub)) return jsonError(res, 404, 'Playlist not found.');
    const videos = await loadCards({ playlistId: playlist.id, ownerSub: playlist.owner_sub === auth?.session.sub ? playlist.owner_sub : null, userSub: auth?.session.sub, limit: MAX_LIST });
    res.json({ playlist: { id: playlist.id, name: playlist.name, description: playlist.description, isPublic: playlist.is_public, isWatchLater: playlist.is_watch_later }, videos: videos.videos });
  } catch (error) { next(error); }
});
app.post('/api/me/watch-later/:id', requireAuth, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!await canView(video, req.auth.session.sub)) return jsonError(res, 403, 'This video is private.');
    const result = await withTransaction(async client => {
      const playlistId = await ensureWatchLater(req.auth.session.sub, client);
      await client.query('SELECT id FROM playlists WHERE id=$1 FOR UPDATE', [playlistId]);
      const existing = await client.query('SELECT 1 FROM playlist_items WHERE playlist_id=$1 AND video_id=$2', [playlistId, video.id]);
      if (existing.rowCount) await client.query('DELETE FROM playlist_items WHERE playlist_id=$1 AND video_id=$2', [playlistId, video.id]);
      else await client.query('INSERT INTO playlist_items (playlist_id,video_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [playlistId, video.id]);
      await client.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [playlistId]);
      return { saved: !existing.rowCount };
    });
    res.json(result);
  } catch (error) { next(error); }
});
app.post('/api/playlists/:id/videos', requireAuth, requireValidId, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const playlistResult = await pool.query('SELECT id,owner_sub FROM playlists WHERE id=$1', [req.params.id]);
    const playlist = playlistResult.rows[0];
    const actualVideo = await getVideo(req.body?.videoId);
    if (!playlist || playlist.owner_sub !== req.auth.session.sub) return jsonError(res, 404, 'Playlist not found.');
    if (!actualVideo) return jsonError(res, 404, 'Video not found.');
    if (!await canView(actualVideo, req.auth.session.sub)) return jsonError(res, 403, 'This video is private.');
    await pool.query('INSERT INTO playlist_items (playlist_id,video_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [playlist.id, actualVideo.id]);
    await pool.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [playlist.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete('/api/playlists/:id/videos/:videoId', requireAuth, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id) || !validVideoId(req.params.videoId)) return jsonError(res, 400, 'Invalid playlist or video id.');
    const result = await pool.query('DELETE FROM playlist_items i USING playlists p WHERE i.playlist_id=p.id AND p.id=$1 AND p.owner_sub=$2 AND i.video_id=$3 RETURNING i.video_id', [req.params.id, req.auth.session.sub, req.params.videoId]);
    if (!result.rowCount) return jsonError(res, 404, 'Playlist item not found.');
    await pool.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete('/api/playlists/:id', requireAuth, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const result = await pool.query('DELETE FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_watch_later=FALSE RETURNING id', [req.params.id, req.auth.session.sub]);
    if (!result.rowCount) return jsonError(res, 404, 'Playlist not found or system playlist cannot be deleted.');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/upload-url', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const filename = safeFilename(body.filename);
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    const size = Number(body.size);
    if (!body.filename || filename === 'video') return jsonError(res, 400, 'Filename is required.');
    if (!/^video\/[a-z0-9.+-]+$/i.test(contentType) || contentType.length > 128) return jsonError(res, 400, 'Only supported video file types are allowed.');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_MB * 1024 * 1024) return jsonError(res, 413, `File must be ${MAX_FILE_MB}MB or smaller.`);
    const title = safeText(body.title, 100);
    const category = normalizeCategory(body.category || 'অন্যান্য');
    const visibility = normalizeVisibility(body.visibility || 'Private');
    if (!title) return jsonError(res, 400, 'A video title is required.');
    if (!category || !visibility) return jsonError(res, 400, 'Category or visibility is invalid.');
    const id = crypto.randomUUID();
    const objectName = `videos/${id}-${filename}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(`INSERT INTO upload_intents (id,owner_sub,object_name,content_type,expected_size,title,description,category,visibility,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, req.auth.session.sub, objectName, contentType, size, title, safeText(body.description, 5000), category, visibility, expiresAt]);
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectName, ContentType: contentType }), { expiresIn: 30 * 60 });
    res.json({ uploadUrl, objectName, id, expiresAt: expiresAt.toISOString() });
  } catch (error) { next(error); }
});
app.post('/api/finish', requireAuth, async (req, res, next) => {
  try {
    const intentId = typeof req.body?.id === 'string' ? req.body.id : (typeof req.body?.intentId === 'string' ? req.body.intentId : '');
    if (!validUuid(intentId)) return jsonError(res, 400, 'A valid upload intent id is required.');
    const found = await pool.query('SELECT * FROM upload_intents WHERE id=$1 AND owner_sub=$2', [intentId, req.auth.session.sub]);
    const intent = found.rows[0];
    if (!intent) return jsonError(res, 403, 'Upload intent not found or not yours.');
    if (new Date(intent.expires_at).getTime() <= Date.now()) return jsonError(res, 410, 'Upload intent expired.');
    if (req.body?.objectName !== undefined && req.body.objectName !== intent.object_name) return jsonError(res, 400, 'Object name does not match the upload intent.');
    const title = req.body?.title === undefined ? intent.title : safeText(req.body.title, 100);
    const description = req.body?.description === undefined ? intent.description : safeText(req.body.description, 5000);
    const category = req.body?.category === undefined ? intent.category : normalizeCategory(req.body.category);
    const visibility = req.body?.visibility === undefined ? intent.visibility : normalizeVisibility(req.body.visibility);
    if (!title || !category || !visibility) return jsonError(res, 400, 'Title, category and visibility are required.');
    const head = await objectHead(intent.object_name);
    if (!head) return jsonError(res, 404, 'Uploaded file not found in R2.');
    if (Number(head.ContentLength) !== Number(intent.expected_size) || Number(head.ContentLength) > MAX_FILE_MB * 1024 * 1024) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: intent.object_name })).catch(() => {});
      return jsonError(res, 413, 'Uploaded file size does not match the intent.');
    }
    if (head.ContentType && head.ContentType !== intent.content_type) return jsonError(res, 400, 'Uploaded file type does not match the intent.');
    const profile = await loadProfile(req.auth.session.sub);
    const inserted = await withTransaction(async client => {
      const result = await client.query(`INSERT INTO videos (id,object_name,owner_sub,title,description,category,visibility,size,created_at,legacy)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),FALSE) RETURNING id,object_name,owner_sub,title,description,category,visibility,size,created_at,legacy,likes_count,views_count,comments_count`,
        [intent.id, intent.object_name, req.auth.session.sub, title, description, category, visibility, Number(head.ContentLength)]);
      await client.query('DELETE FROM upload_intents WHERE id=$1', [intent.id]);
      return result.rows[0];
    });
    res.json({ ok: true, video: videoCard({ ...inserted, owner_handle: profile?.handle, owner_name: profile?.display_name, owner_avatar: profile?.avatar_url }) });
  } catch (error) { next(error); }
});

app.delete('/api/videos/:id', requireAuth, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!video.owner_sub || video.owner_sub !== req.auth.session.sub) return jsonError(res, 403, 'Only the owner can delete this video.');
    if (!video.object_name || !/^videos\/[0-9a-f-]+-[a-zA-Z0-9._-]+$/i.test(video.object_name)) return jsonError(res, 409, 'Video object is invalid; not deleted.');
    await pool.query('DELETE FROM videos WHERE id=$1 AND owner_sub=$2', [video.id, req.auth.session.sub]);
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: video.object_name })).catch(error => console.error('Deleted Neon metadata but could not remove R2 object:', error.message));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

io.use(async (socket, next) => {
  try {
    const raw = verifyValue(parseCookieHeader(socket.handshake.headers.cookie || '').vh_session);
    if (!raw) { socket.data.sub = null; return next(); }
    const result = await pool.query('SELECT sub FROM sessions WHERE token_hash=$1 AND expires_at>NOW()', [sha(raw)]);
    socket.data.sub = result.rows[0]?.sub || null;
    next();
  } catch (error) { next(error); }
});
io.on('connection', socket => {
  socket.on('video:join', async id => {
    try {
      if (!validVideoId(id)) return;
      const video = await getVideo(id);
      if (!video || !await canView(video, socket.data.sub)) return;
      if (socket.data.videoRoom) socket.leave(socket.data.videoRoom);
      socket.data.videoRoom = `video:${id}`;
      socket.join(socket.data.videoRoom);
      const counts = await getCounts(id);
      if (counts) socket.emit('video:stats', { videoId: id, ...counts });
    } catch (error) { console.warn('Socket video join failed:', error.message); }
  });
  socket.on('video:leave', id => {
    if (socket.data.videoRoom && (!id || socket.data.videoRoom === `video:${id}`)) {
      socket.leave(socket.data.videoRoom);
      socket.data.videoRoom = null;
    }
  });
  socket.on('channel:join', async handle => {
    try {
      const clean = safeHandle(handle);
      if (!clean) return;
      const exists = await pool.query('SELECT 1 FROM profiles WHERE handle=$1', [clean]);
      if (!exists.rowCount) return;
      if (socket.data.channelRoom) socket.leave(socket.data.channelRoom);
      socket.data.channelRoom = channelRoom(clean);
      socket.join(socket.data.channelRoom);
      const count = await pool.query('SELECT COUNT(*)::bigint AS n FROM subscriptions s JOIN profiles p ON p.sub=s.channel_sub WHERE p.handle=$1', [clean]);
      socket.emit('channel:stats', { handle: clean, subscribersCount: Number(count.rows[0].n) });
    } catch (error) { console.warn('Socket channel join failed:', error.message); }
  });
  socket.on('channel:leave', handle => {
    if (socket.data.channelRoom && (!handle || socket.data.channelRoom === channelRoom(safeHandle(handle)))) {
      socket.leave(socket.data.channelRoom);
      socket.data.channelRoom = null;
    }
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status) || 500;
  res.status(status).json({ error: status < 500 ? error.message : 'Server error / সার্ভার ত্রুটি।', detail: process.env.NODE_ENV === 'production' ? undefined : error.message });
});

async function start() {
  await initializeDatabase();
  if (process.env.MIGRATE_R2_JSON_ON_START !== 'false') {
    const migration = require('./scripts/migrate-r2-json');
    try {
      const result = await migration.migrateR2Json();
      console.log('Legacy R2 JSON migration check completed:', JSON.stringify(result));
    } catch (error) {
      console.error('Legacy R2 JSON migration deferred; application will still start:', error.message);
    } finally {
      await migration.closeMigrationClient();
    }
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`ClipNest running on port ${PORT}; Neon and Socket.IO ready.`));
}
if (require.main === module) start().catch(error => {
  console.error('Application startup failed:', error.message);
  process.exit(1);
});

module.exports = { app, server, io, start, pool };
