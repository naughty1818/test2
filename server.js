'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs/promises');
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
const { normalizeViewerType, normalizeCreatorType, resolveIslamicFlag, isIslamicEligible } = require('./content-policy');

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
const requestLimits = require('./request-limits');
requestLimits.attachRequestLimits(app);
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  if (req.method === 'PUT' && /^\/api\/videos\/[^/]+\/captions\/[a-z0-9-]+$/.test(req.path)) {
    return express.text({ type: ['text/vtt', 'text/plain'], limit: '2mb' })(req, res, next);
  }
  next();
});
app.use(express.json({ limit: '32kb' }));
app.get('/assets/atharo-logo-reveal-007670.mp4', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  next();
});
app.get('/sitemap.xml', async (req, res) => {
  const staticSitemapPath = path.join(__dirname, 'public', 'sitemap.xml');
  let sitemap = await fs.readFile(staticSitemapPath, 'utf8');
  try {
    const result = await pool.query(`
      SELECT path, lastmod FROM (
        SELECT '/watch/' || v.id::text AS path, v.created_at AS lastmod
        FROM videos v JOIN app_users u ON u.google_sub=v.owner_sub
        WHERE v.visibility='Public' AND v.moderation_status='active' AND u.account_status='active'
        UNION ALL
        SELECT '/channel/' || p.handle AS path, MAX(v.created_at) AS lastmod
        FROM profiles p JOIN app_users u ON u.google_sub=p.sub
        JOIN videos v ON v.owner_sub=p.sub
        WHERE u.account_status='active' AND v.visibility='Public' AND v.moderation_status='active'
        GROUP BY p.handle
      ) public_pages
      ORDER BY lastmod DESC NULLS LAST LIMIT 49000
    `);
    const entries = result.rows.map(row => `  <url>\n    <loc>https://www.atharo.online${row.path}</loc>${row.lastmod ? `\n    <lastmod>${new Date(row.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}\n  </url>`).join('\n');
    sitemap = sitemap.replace('</urlset>', `${entries ? `\n${entries}\n` : ''}</urlset>`);
  } catch (error) {
    console.error('Dynamic sitemap entries could not be loaded:', error.message);
  }
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(sitemap);
});
app.use(express.static(path.join(__dirname, 'public')));

const VIDEO_SELECT = `
  SELECT v.id, v.object_name, v.owner_sub, v.title, v.description, v.category,
         v.visibility, v.size, v.created_at, v.legacy, v.likes_count,
         v.views_count, v.comments_count, v.moderation_status,v.scheduled_at,v.comments_enabled,
         v.is_premium,v.price_bdt,
         v.thumbnail_object_name, v.class_level, v.subject, v.syllabus_tags, v.duration_seconds,
         v.is_islamic, v.islamic_certification_status,
         EXISTS(SELECT 1 FROM video_captions vc WHERE vc.video_id=v.id) AS has_captions,
         p.handle AS owner_handle,
         COALESCE(NULLIF(p.display_name,''), NULLIF(u.google_name,''), 'Atharo নির্মাতা') AS owner_name,
         p.avatar_url AS owner_avatar, COALESCE(p.is_verified,FALSE) AS owner_verified, u.account_status AS owner_status
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
function normalizeSyllabusTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(tag => safeText(tag, 60)).filter(Boolean))].slice(0, 12);
}
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
  return { displayName: profile.display_name || profile.displayName || 'Creator', handle: profile.handle || null, bio: profile.bio || '', avatarUrl: profile.avatar_url || profile.avatarUrl || null, coverUrl: profile.cover_url || profile.coverUrl || null, isVerified: Boolean(profile.is_verified ?? profile.isVerified), channelType: profile.channel_type || profile.channelType || 'general', creatorType: profile.creator_type || profile.creatorType || 'normal' };
}
function toISO(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function videoCard(row) {
  return {
    id: row.id, title: row.title, description: row.description, category: row.category,
    visibility: row.visibility, size: Number(row.size) || 0, created: toISO(row.created_at),
    isPremium: Boolean(row.is_premium), priceBdt: Number(row.price_bdt) || 0,
    ownerHandle: row.owner_handle || null, ownerName: row.owner_name || 'Atharo নির্মাতা',
    ownerAvatar: row.owner_avatar || null, ownerVerified: Boolean(row.owner_verified), likesCount: Number(row.likes_count) || 0,
    viewsCount: Number(row.views_count) || 0, commentsCount: Number(row.comments_count) || 0,
    thumbnailUrl: row.thumbnail_object_name ? `/api/videos/${encodeURIComponent(row.id)}/thumbnail` : null,
    classLevel: row.class_level || '', subject: row.subject || '', syllabusTags: row.syllabus_tags || [],
    durationSeconds: Number(row.duration_seconds) || 0, isIslamic: Boolean(row.is_islamic), islamicCertificationStatus: row.islamic_certification_status || 'not_applicable',
    hasCaptions: Boolean(row.has_captions), scheduledAt:row.scheduled_at||null, commentsEnabled:row.comments_enabled!==false,
    liked: Boolean(row.liked), watchLater: Boolean(row.watch_later), feedback: row.feedback || null
  };
}
function requireValidId(req, res, next) {
  if (!validVideoId(req.params.id)) return jsonError(res, 400, 'Invalid video id.');
  next();
}
async function loadProfile(sub, client = pool) {
  const result = await client.query('SELECT sub,handle,display_name,bio,avatar_url,cover_url,channel_type,creator_type,is_verified,created_at,updated_at FROM profiles WHERE sub=$1', [sub]);
  return result.rows[0] || null;
}
async function loadSession(req) {
  const raw = verifyValue(parseCookies(req).vh_session);
  if (!raw || raw.length < 32) return null;
  const result = await pool.query(`
    SELECT s.sub, s.expires_at, u.email, u.google_name, u.google_picture, u.account_status, u.viewer_type,
           p.handle, p.display_name, p.bio, p.avatar_url, p.cover_url, p.channel_type, p.creator_type, p.is_verified
    FROM sessions s JOIN app_users u ON u.google_sub=s.sub
    LEFT JOIN profiles p ON p.sub=s.sub
    WHERE s.token_hash=$1 AND s.expires_at>NOW()
  `, [sha(raw)]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const session = { sub: row.sub, email: row.email, name: row.google_name || '', picture: row.google_picture || null, accountStatus: row.account_status || 'active', viewerType: row.viewer_type || 'normal', emailVerified: true, expiresAt: toISO(row.expires_at) };
  const profile = row.handle ? { sub: row.sub, handle: row.handle, display_name: row.display_name, bio: row.bio, avatar_url: row.avatar_url, cover_url: row.cover_url, channel_type: row.channel_type, creator_type: row.creator_type || 'normal', is_verified: row.is_verified } : null;
  return { token: raw, session, profile };
}
async function requireAuth(req, res, next) {
  try {
    req.auth = await loadSession(req);
    if (!req.auth) return jsonError(res, 401, 'Authentication required / লগইন আবশ্যক।');
    next();
  } catch (error) { next(error); }
}
function requireActive(req, res, next) {
  if (req.auth?.session?.accountStatus !== 'active') return jsonError(res, 403, 'এই account-টি বর্তমানে সীমাবদ্ধ। / This account is currently restricted.');
  next();
}
async function requireChannel(req, res, next) {
  try {
    req.auth = req.auth || await loadSession(req);
    if (!req.auth) return jsonError(res, 401, 'Authentication required / লগইন আবশ্যক।');
    if (req.auth.session.accountStatus !== 'active') return jsonError(res,403,'This account is restricted.',{code:'account_restricted'});
    if (!req.auth.profile) return jsonError(res,403,'An approved channel is required before you can upload or use Creator Studio.',{code:'channel_required'});
    next();
  } catch (error) { next(error); }
}
async function saveSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await withTransaction(async client => {
    await client.query(`INSERT INTO app_users (google_sub,email,google_name,google_picture) VALUES ($1,$2,$3,$4)
      ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email, google_name=EXCLUDED.google_name, google_picture=EXCLUDED.google_picture, updated_at=NOW()`, [user.sub, user.email, user.name || '', user.picture || null]);
    // A Google account is a viewer by default. Channel profiles are created only after Admin approval.
    await client.query('DELETE FROM sessions WHERE expires_at < NOW()');
    await client.query('INSERT INTO sessions (token_hash,sub,expires_at) VALUES ($1,$2,$3)', [sha(token), user.sub, new Date(Date.now() + SESSION_TTL_SECONDS * 1000)]);
  });
  setCookie(res, req, 'vh_session', signValue(token), { maxAge: SESSION_TTL_SECONDS });
}
function sessionUser(session) { return { email: session.email, name: session.name, picture: session.picture || null, accountStatus: session.accountStatus || 'active', viewerType: session.viewerType || 'normal', emailVerified: true }; }
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
async function canView(video, sub, viewerType = 'normal', allowPrivatePurchase = false) {
  if (video.moderation_status && video.moderation_status !== 'active') return false;
  if (video.owner_status && video.owner_status !== 'active') return false;
  if (!isIslamicEligible(video, viewerType)) return false;
  if (video.scheduled_at && new Date(video.scheduled_at).getTime() > Date.now() && video.owner_sub !== sub) return false;
  return video.visibility !== 'Private' || Boolean(allowPrivatePurchase || (sub && video.owner_sub === sub));
}
async function loadCards({ category = '', query = '', limit = 24, offset = 0, userSub = null, viewerType = 'normal', ownerSub = null, subscriptions = false, playlistId = null, history = false, classLevel = '', subject = '', syllabusTag = '', durationMin = 0, durationMax = 0, captionsOnly = false, sort = '' } = {}) {
  const safeLimit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(limit, 10) || 24));
  const safeOffset = Math.min(100000, Math.max(0, Number.parseInt(offset, 10) || 0));
  const params = [];
  let from = `${VIDEO_SELECT}`;
  let where = ["COALESCE(v.moderation_status,'active')='active'", "COALESCE(u.account_status,'active')='active'"];
  if (viewerType === 'islamic') where.push("v.is_islamic=TRUE", "v.islamic_certification_status='approved'");
  if(userSub){params.push(userSub);where.push(`(v.scheduled_at IS NULL OR v.scheduled_at<=NOW() OR v.owner_sub=$${params.length})`);}
  else where.push('(v.scheduled_at IS NULL OR v.scheduled_at<=NOW())');
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
  if (query) {
    params.push(query); const q = `$${params.length}`;
    where.push(`(to_tsvector('simple',v.title || ' ' || v.description) @@ plainto_tsquery('simple',${q})
      OR EXISTS(SELECT 1 FROM video_captions vc WHERE vc.video_id=v.id AND to_tsvector('simple',vc.transcript_text) @@ plainto_tsquery('simple',${q}))
      OR LOWER(p.handle)=LOWER(${q}) OR LOWER(p.display_name)=LOWER(${q}))`);
  }
  if (classLevel) { params.push(classLevel); where.push(`v.class_level=$${params.length}`); }
  if (subject) { params.push(subject); where.push(`LOWER(v.subject)=LOWER($${params.length})`); }
  if (syllabusTag) { params.push([syllabusTag]); where.push(`v.syllabus_tags @> $${params.length}::text[]`); }
  if (durationMin > 0) { params.push(durationMin); where.push(`v.duration_seconds >= $${params.length}`); }
  if (durationMax > 0) { params.push(durationMax); where.push(`v.duration_seconds <= $${params.length}`); }
  if (captionsOnly) where.push('EXISTS(SELECT 1 FROM video_captions vc WHERE vc.video_id=v.id)');
  if (userSub && !ownerSub && !playlistId && !history && !subscriptions) { params.push(userSub); where.push(`NOT EXISTS(SELECT 1 FROM video_feedback vf WHERE vf.video_id=v.id AND vf.user_sub=$${params.length} AND vf.feedback='not_interested')`); }
  let order = history ? 'wh.last_watched_at DESC' : playlistId ? 'pi.position ASC, pi.added_at DESC' : 'v.created_at DESC';
  if (subscriptions) order = 'v.created_at DESC';
  if (!history && !playlistId && !subscriptions) {
    const orders = { newest: 'v.created_at DESC', views: 'v.views_count DESC,v.created_at DESC', popular: 'v.likes_count DESC,v.views_count DESC,v.created_at DESC', duration: 'v.duration_seconds DESC,v.created_at DESC' };
    if (orders[sort]) order = orders[sort];
  }
  const filterSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (userSub) {
    params.push(userSub);
    const userPosition = params.length;
    from += ` LEFT JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM video_likes l WHERE l.video_id=v.id AND l.user_sub=$${userPosition}) AS liked) ul ON TRUE`;
    from += ` LEFT JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM playlists pl JOIN playlist_items pi2 ON pi2.playlist_id=pl.id WHERE pl.owner_sub=$${userPosition} AND pl.is_watch_later=TRUE AND pi2.video_id=v.id) AS watch_later) uw ON TRUE`;
    from += ` LEFT JOIN LATERAL (SELECT vf.feedback FROM video_feedback vf WHERE vf.video_id=v.id AND vf.user_sub=$${userPosition}) uf ON TRUE`;
  } else {
    from += ' LEFT JOIN LATERAL (SELECT FALSE AS liked) ul ON TRUE LEFT JOIN LATERAL (SELECT FALSE AS watch_later) uw ON TRUE LEFT JOIN LATERAL (SELECT NULL::text AS feedback) uf ON TRUE';
  }
  // VIDEO_SELECT already contains the profile/user joins; append interaction states to the select list.
  const selectSql = from.replace('SELECT v.id,', 'SELECT COALESCE(ul.liked,FALSE) AS liked, COALESCE(uw.watch_later,FALSE) AS watch_later, uf.feedback, v.id,');
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
async function sendNotification(recipientSub, actorSub, kind, title, detail = '', href = '/', client = pool) {
  if (!recipientSub || recipientSub === actorSub) return null;
  const id = crypto.randomUUID();
  const result = await client.query(`INSERT INTO user_notifications(id,recipient_sub,actor_sub,kind,title,detail,href) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,title,detail,href,created_at,read_at`, [id,recipientSub,actorSub||null,kind,safeText(title,160),safeText(detail,500),String(href||'/').startsWith('/')?String(href).slice(0,500):'/']);
  const row = result.rows[0];
  const item = { id:row.id,kind:row.kind,title:row.title,detail:row.detail,href:row.href,createdAt:toISO(row.created_at),readAt:row.read_at };
  io.to(`user:${recipientSub}`).emit('notification:new', item);
  return item;
}
async function signedVideoUrl(objectName) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectName }), { expiresIn: 60 * 60 });
}
async function objectHead(key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
  catch (error) { if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null; throw error; }
}
async function deleteStorageObjects(keys) {
  const failures = [];
  for (const key of [...new Set(keys.filter(Boolean))]) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
    catch (error) { failures.push({ key, error: error.message }); console.error('R2 delete failed:', key, error.message); }
  }
  return failures;
}
async function premiumVideoAccess(video, userSub) {
  if (!video) return { allowed:false, paid:false };
  if (!userSub) return { allowed:!video.is_premium, paid:false };
  if (video.owner_sub === userSub) return { allowed:true, paid:true };
  const result = await pool.query(`SELECT
    (EXISTS(SELECT 1 FROM premium_video_entitlements WHERE video_id=$1 AND buyer_sub=$2)
      OR EXISTS(SELECT 1 FROM premium_playlist_entitlements e JOIN playlist_items i ON i.playlist_id=e.playlist_id WHERE i.video_id=$1 AND e.buyer_sub=$2)) AS paid,
    EXISTS(SELECT 1 FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id JOIN videos pv ON pv.id=i.video_id
      WHERE i.video_id=$1 AND i.is_preview=TRUE AND p.is_premium=TRUE AND p.is_public=TRUE AND pv.visibility='Public') AS preview`, [video.id, userSub]);
  const paid=Boolean(result.rows[0]?.paid),preview=Boolean(result.rows[0]?.preview);
  return { allowed:!video.is_premium||paid||preview, paid };
}
async function accessVideo(req, res, next) {
  try {
    req.auth = req.auth || await loadSession(req);
    if (req.auth && req.auth.session.accountStatus !== 'active') return jsonError(res,403,'This account is currently restricted.');
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    req.video = video;
    req.auth = req.auth || await loadSession(req);
    const access=await premiumVideoAccess(video,req.auth?.session.sub);
    if (!await canView(video, req.auth?.session.sub, req.auth?.session.viewerType || 'normal',access.paid)) return jsonError(res, 403, 'This video is private / ভিডিওটি private or unavailable in this viewing mode.');
    if (!access.allowed) return jsonError(res, 403, 'এই premium video দেখতে আগে purchase করুন।', { code: 'premium_required', itemType: 'video', itemId: video.id, priceBdt: Number(video.price_bdt) || 0 });
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
app.delete('/api/me/creator', requireAuth, async (req, res, next) => {
  try {
    const sub = req.auth.session.sub;
    const result = await withTransaction(async client => {
      const profile = await client.query('SELECT sub,handle FROM profiles WHERE sub=$1 FOR UPDATE', [sub]);
      if (!profile.rowCount) return null;
      const financial=await client.query(`SELECT EXISTS(SELECT 1 FROM premium_playlist_orders WHERE buyer_sub=$1 OR playlist_id IN(SELECT id FROM playlists WHERE owner_sub=$1) OR video_id IN(SELECT id FROM videos WHERE owner_sub=$1)) OR EXISTS(SELECT 1 FROM creator_wallet_ledger WHERE creator_sub=$1) OR EXISTS(SELECT 1 FROM creator_withdrawal_requests WHERE creator_sub=$1) AS protected`,[sub]);
      if(financial.rows[0]?.protected)throw Object.assign(new Error('This creator has premium sales, purchases, or wallet records. Resolve financial records before deleting the channel.'),{status:409});
      const media = await client.query('SELECT object_name,thumbnail_object_name FROM videos WHERE owner_sub=$1', [sub]);
      const uploads = await client.query('SELECT object_name FROM upload_intents WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM videos WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM upload_intents WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM playlists WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM subscriptions WHERE channel_sub=$1 OR subscriber_sub=$1', [sub]);
      await client.query('DELETE FROM channel_applications WHERE user_sub=$1', [sub]);
      await client.query('DELETE FROM channel_verification_requests WHERE user_sub=$1', [sub]);
      await client.query('DELETE FROM profiles WHERE sub=$1', [sub]);
      return { handle: profile.rows[0].handle, keys: [...media.rows.flatMap(row => [row.object_name, row.thumbnail_object_name]), ...uploads.rows.map(row => row.object_name)] };
    });
    if (!result) return jsonError(res, 404, 'Creator channel not found.');
    const storageFailures = await deleteStorageObjects(result.keys);
    res.json({ ok: true, deleted: 'creator', storageFailures });
  } catch (error) { next(error); }
});
app.delete('/api/me/account', requireAuth, async (req, res, next) => {
  try {
    const sub = req.auth.session.sub;
    const result = await withTransaction(async client => {
      const user = await client.query('SELECT google_sub FROM app_users WHERE google_sub=$1 FOR UPDATE', [sub]);
      if (!user.rowCount) return null;
      const financial=await client.query(`SELECT EXISTS(SELECT 1 FROM premium_playlist_orders WHERE buyer_sub=$1 OR playlist_id IN(SELECT id FROM playlists WHERE owner_sub=$1) OR video_id IN(SELECT id FROM videos WHERE owner_sub=$1)) OR EXISTS(SELECT 1 FROM creator_wallet_ledger WHERE creator_sub=$1) OR EXISTS(SELECT 1 FROM creator_withdrawal_requests WHERE creator_sub=$1) AS protected`,[sub]);
      if(financial.rows[0]?.protected)throw Object.assign(new Error('This account has premium sales, purchases, or wallet records. Resolve financial records before deleting the account.'),{status:409});
      const media = await client.query('SELECT object_name,thumbnail_object_name FROM videos WHERE owner_sub=$1', [sub]);
      const uploads = await client.query('SELECT object_name FROM upload_intents WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM videos WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM upload_intents WHERE owner_sub=$1', [sub]);
      await client.query('DELETE FROM app_users WHERE google_sub=$1', [sub]);
      return { keys: [...media.rows.flatMap(row => [row.object_name, row.thumbnail_object_name]), ...uploads.rows.map(row => row.object_name)] };
    });
    if (!result) return jsonError(res, 404, 'Account not found.');
    const storageFailures = await deleteStorageObjects(result.keys);
    clearCookie(res, req, 'vh_session');
    res.json({ ok: true, deleted: 'account', storageFailures });
  } catch (error) { next(error); }
});
app.patch('/api/me/preferences', requireAuth, requireActive, async (req, res, next) => {
  try {
    const viewerType = normalizeViewerType(req.body?.viewerType);
    if (!viewerType) return jsonError(res, 400, 'Choose Islamic or Normal viewer mode.');
    await pool.query('UPDATE app_users SET viewer_type=$2,updated_at=NOW() WHERE google_sub=$1', [req.auth.session.sub, viewerType]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ ok: true, viewerType });
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

app.get('/api/me/channel-application', requireAuth, async (req,res,next)=>{
  try {
    const sub=req.auth.session.sub;
    const [profile,appRow]=await Promise.all([
      pool.query('SELECT handle,display_name,channel_type,creator_type,is_verified FROM profiles WHERE sub=$1',[sub]),
      pool.query(`SELECT id,channel_name,channel_type,creator_type,other_platform_name,other_platform_url,status,decision_note,created_at,reviewed_at FROM channel_applications WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 1`,[sub])
    ]);
    res.set('Cache-Control','private, no-store');
    res.json({channel:profile.rows[0]||null,application:appRow.rows[0]||null});
  } catch(error){next(error);}
});
app.post('/api/me/channel-application', requireAuth, requireActive, async (req,res,next)=>{
  try {
    const sub=req.auth.session.sub,name=safeText(req.body?.channelName,120),type=String(req.body?.channelType||''),creatorType=normalizeCreatorType(String(req.body?.creatorType||'normal')),platform=safeText(req.body?.otherPlatformName,80),rawUrl=safeText(req.body?.otherPlatformUrl,2048),hasOther=Boolean(req.body?.hasOtherPlatform);
    if(name.length<2)return jsonError(res,400,'Channel name must contain at least 2 characters.');
    if(!['personal','education','business','organization','other'].includes(type))return jsonError(res,400,'Choose a valid channel type.');
    if(!creatorType)return jsonError(res,400,'Choose Islamic, Normal, or Mixed creator type.');
    let platformUrl=null;
    if(hasOther){if(!platform||!rawUrl)return jsonError(res,400,'Provide both the platform name and channel link.');try{const parsed=new URL(rawUrl);if(parsed.protocol!=='https:'||parsed.username||parsed.password)return jsonError(res,400,'Other platform link must be a valid HTTPS URL.');platformUrl=parsed.toString().slice(0,2048);}catch(_){return jsonError(res,400,'Add a valid HTTPS link for the other platform.');}}
    else if(platform||rawUrl)return jsonError(res,400,'Uncheck other-platform presence or provide both its name and link.');
    if((await pool.query('SELECT 1 FROM profiles WHERE sub=$1',[sub])).rowCount)return jsonError(res,409,'This account already has an approved channel.');
    const existing=await pool.query(`SELECT id,status,decision_note,created_at FROM channel_applications WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 1`,[sub]);
    if(existing.rows[0]?.status==='pending')return jsonError(res,409,'You already have a pending channel application.',{application:existing.rows[0]});
    const id=crypto.randomUUID();
    const saved=await pool.query(`INSERT INTO channel_applications(id,user_sub,channel_name,channel_type,creator_type,other_platform_name,other_platform_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,channel_name,channel_type,creator_type,other_platform_name,other_platform_url,status,decision_note,created_at`,[id,sub,name,type,creatorType,platform,platformUrl]);
    res.status(201).json({application:saved.rows[0]});
  } catch(error){if(error.code==='23505')return jsonError(res,409,'You already have a pending channel application.');next(error);}
});

app.post('/api/me/profile', requireAuth, requireActive, requireChannel, async (req, res, next) => {
  try {
    const requestedHandle = safeHandle(req.body?.handle);
    const displayName = safeText(req.body?.displayName, 120);
    const bio = safeText(req.body?.bio, 1000);
    const avatarUrl = req.body?.avatarUrl === undefined ? null : safeText(req.body.avatarUrl, 1000);
    const coverUrl = req.body?.coverUrl === undefined ? null : safeText(req.body.coverUrl, 1000);
    for (const url of [avatarUrl,coverUrl].filter(Boolean)) { try { const parsed=new URL(url); if(parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password) throw new Error(); } catch (_) { return jsonError(res,400,'Avatar ও cover-এর জন্য valid HTTPS image URL দিন।'); } }
    if (!displayName) return jsonError(res, 400, 'displayName is required / নাম আবশ্যক।');
    if (!requestedHandle || requestedHandle.length < 3) return jsonError(res, 400, 'handle must be 3-30 letters, numbers, dots, dashes or underscores.');
    const existing = await loadProfile(req.auth.session.sub);
    const conflict = await pool.query('SELECT sub FROM profiles WHERE handle=$1 AND sub<>$2', [requestedHandle, req.auth.session.sub]);
    if (conflict.rowCount) return jsonError(res, 409, 'That handle is already taken / এই handle নেওয়া আছে।', { suggestedHandle: `${requestedHandle.slice(0, 24)}-${crypto.randomBytes(2).toString('hex')}` });
    if (!existing) return jsonError(res,403,'Channel approval is required before creating a channel profile.',{code:'channel_required'});
    const profile = await withTransaction(async client => {
      const result = await client.query(`UPDATE profiles SET handle=$2,display_name=$3,bio=$4,avatar_url=COALESCE($5,avatar_url),cover_url=COALESCE($6,cover_url),updated_at=NOW() WHERE sub=$1 RETURNING sub,handle,display_name,bio,avatar_url,cover_url,channel_type,creator_type,is_verified`,
        [req.auth.session.sub, requestedHandle, displayName, bio, avatarUrl, coverUrl]);
      return result.rows[0];
    });
    res.json({ profile: publicProfile(profile) });
  } catch (error) { next(error); }
});

app.get('/api/channels', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const result = await pool.query(`SELECT p.handle,p.display_name,p.bio,p.avatar_url,p.cover_url,p.is_verified,p.channel_type,p.creator_type,
      (SELECT COUNT(*) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public' AND v.moderation_status='active')::bigint AS videos_count,
      (SELECT COALESCE(SUM(v.views_count),0) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public' AND v.moderation_status='active')::bigint AS views_count,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_sub=p.sub)::bigint AS subscribers_count,
      (SELECT MAX(v.created_at) FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public' AND v.moderation_status='active') AS latest_video
      FROM profiles p JOIN app_users u ON u.google_sub=p.sub WHERE u.account_status='active' AND EXISTS(SELECT 1 FROM videos v WHERE v.owner_sub=p.sub AND v.visibility='Public' AND v.moderation_status='active')
      ORDER BY latest_video DESC LIMIT $1`, [limit]);
    res.json({ channels: result.rows.map(row => ({ handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, isVerified:Boolean(row.is_verified), channelType:row.channel_type, creatorType:row.creator_type||'normal', videosCount: Number(row.videos_count), viewsCount: Number(row.views_count), subscribersCount: Number(row.subscribers_count) })) });
  } catch (error) { next(error); }
});
app.get('/api/channels/:handle', async (req, res, next) => {
  try {
    const handle = safeHandle(decodeURIComponent(req.params.handle || ''));
    if (!handle || handle !== req.params.handle.toLowerCase()) return jsonError(res, 400, 'Invalid handle.');
    const found = await pool.query(`SELECT p.sub,p.handle,p.display_name,p.bio,p.avatar_url,p.cover_url,p.channel_type,p.creator_type,p.is_verified,p.created_at,COUNT(DISTINCT s.subscriber_sub)::bigint AS subscribers_count
      FROM profiles p JOIN app_users u ON u.google_sub=p.sub LEFT JOIN subscriptions s ON s.channel_sub=p.sub WHERE p.handle=$1 AND u.account_status='active' GROUP BY p.sub`, [handle]);
    if (!found.rowCount) return jsonError(res, 404, 'Channel not found / চ্যানেল পাওয়া যায়নি।');
    const row = found.rows[0];
    const auth = await loadSession(req);
    const [feed, subResult, playlistResult] = await Promise.all([
      loadCards({ ownerSub: row.sub, userSub: auth?.session.sub, viewerType: auth?.session.viewerType || 'normal', limit: MAX_LIST }),
      auth ? pool.query('SELECT 1 FROM subscriptions WHERE subscriber_sub=$1 AND channel_sub=$2', [auth.session.sub, row.sub]) : Promise.resolve({ rowCount: 0 }),
      pool.query(`SELECT p.id,p.name,p.description,COUNT(i.video_id)::bigint AS videos_count FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.owner_sub=$1 AND p.is_creator_playlist=TRUE AND p.is_public=TRUE GROUP BY p.id ORDER BY p.updated_at DESC`,[row.sub])
    ]);
    res.json({ profile: publicProfile(row), videos: feed.videos.filter(video => video.visibility === 'Public'), creatorPlaylists:playlistResult.rows.map(p=>({id:p.id,name:p.name,description:p.description,videosCount:Number(p.videos_count)})), subscribersCount: Number(row.subscribers_count), subscribed: subResult.rowCount > 0, isOwner: auth?.session.sub === row.sub });
  } catch (error) { next(error); }
});
app.post('/api/channels/:handle/subscribe', requireAuth, requireActive, async (req, res, next) => {
  try {
    const handle = safeHandle(req.params.handle);
    const found = await pool.query("SELECT p.sub,p.handle FROM profiles p JOIN app_users u ON u.google_sub=p.sub WHERE p.handle=$1 AND u.account_status='active'", [handle]);
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
    if(result.subscribed)await sendNotification(channel.sub,req.auth.session.sub,'subscriber','New subscriber',`${req.auth.session.name||req.auth.session.email} subscribed to your channel.`,`/studio?tab=audience`);
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/videos', async (req, res, next) => {
  try {
    const query = safeText(req.query.query, 100);
    const category = req.query.category ? normalizeCategory(String(req.query.category)) : '';
    if (req.query.category && !category) return jsonError(res, 400, 'Invalid category / category সঠিক নয়।');
    const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(req.query.limit || '24', 10) || 24));
    const offset = Math.min(100000, Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0));
    const classLevel = safeText(req.query.classLevel, 40);
    const subject = safeText(req.query.subject, 80);
    const syllabusTag = safeText(req.query.syllabusTag, 60);
    const durationMin = Math.max(0, Number.parseInt(req.query.durationMin || '0', 10) || 0);
    const durationMax = Math.max(0, Number.parseInt(req.query.durationMax || '0', 10) || 0);
    const captionsOnly = String(req.query.captions || '') === 'true';
    const sort = ['newest','views','popular','duration'].includes(String(req.query.sort || '')) ? String(req.query.sort) : '';
    if (durationMin > 604800 || durationMax > 604800 || (durationMin && durationMax && durationMin > durationMax)) return jsonError(res, 400, 'ভিডিওর সময়সীমা সঠিক নয়।');
    const auth = await loadSession(req);
    const data = await loadCards({ query, category, classLevel, subject, syllabusTag, durationMin, durationMax, captionsOnly, sort, limit, offset, userSub: auth?.session.sub, viewerType: auth?.session.viewerType || 'normal' });
    res.json(data);
  } catch (error) { next(error); }
});
app.get('/api/videos/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(req.query.limit || '48', 10) || 48));
    res.json(await loadCards({ subscriptions: true, userSub: req.auth.session.sub, viewerType: req.auth.session.viewerType, limit }));
  } catch (error) { next(error); }
});
app.get('/api/videos/:id', requireValidId, async (req, res, next) => {
  try {
    const auth = await loadSession(req);
    if (auth && auth.session.accountStatus !== 'active') return jsonError(res, 403, 'This account is currently restricted.');
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found / ভিডিও পাওয়া যায়নি।');
    const viewerSub = auth?.session.sub || null;
    const access=await premiumVideoAccess(video,viewerSub);
    if (!await canView(video, viewerSub, auth?.session.viewerType || 'normal',access.paid)) return jsonError(res, 403, 'This video is private / ভিডিওটি private or unavailable in this viewing mode.');
    if (!access.allowed) return jsonError(res, 403, 'এই premium video দেখতে আগে purchase করুন।', { code: 'premium_required', itemType: 'video', itemId: video.id, priceBdt: Number(video.price_bdt) || 0 });
    // Sign the R2 URL directly; do not make a serial R2 HEAD request before playback starts.
    const state = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM video_likes WHERE video_id=$1 AND user_sub=$2) AS liked,
      EXISTS(SELECT 1 FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id WHERE p.owner_sub=$2 AND p.is_watch_later=TRUE AND pi.video_id=$1) AS watch_later,
      (SELECT COUNT(*)::bigint FROM subscriptions WHERE channel_sub=$3) AS subscribers_count,
      EXISTS(SELECT 1 FROM subscriptions WHERE subscriber_sub=$2 AND channel_sub=$3) AS subscribed,
      (SELECT feedback FROM video_feedback WHERE video_id=$1 AND user_sub=$2) AS feedback`, [video.id, viewerSub, video.owner_sub || null]);
    const stateRow = state.rows[0] || {};
    const profile = video.owner_handle ? { handle: video.owner_handle, display_name: video.owner_name, bio: '', avatar_url: video.owner_avatar } : null;
    const card = videoCard({ ...video, liked: stateRow.liked, watch_later: stateRow.watch_later, feedback:stateRow.feedback });
    card.url = await signedVideoUrl(video.object_name);
    card.profile = publicProfile(profile);
    card.channel = profile ? { handle: profile.handle, displayName: profile.display_name, isVerified:Boolean(video.owner_verified) } : null;
    card.subscribersCount = Number(stateRow.subscribers_count || 0);
    card.subscribed = Boolean(stateRow.subscribed);
    res.set('Cache-Control', 'private, no-store');
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
app.post('/api/videos/:id/like', requireAuth, requireActive, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!await canView(video, req.auth.session.sub, req.auth.session.viewerType || 'normal')) return jsonError(res, 403, 'This video is private.');
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

app.post('/api/videos/:id/feedback', requireAuth, requireActive, requireValidId, async(req,res,next)=>{
  try{
    const video=await getVideo(req.params.id);
    if(!video||!await canView(video,req.auth.session.sub,req.auth.session.viewerType||'normal'))return jsonError(res,404,'Video not found.');
    const feedback=String(req.body?.feedback||'');
    if(!['interested','not_interested','clear'].includes(feedback))return jsonError(res,400,'Choose interested, not interested, or clear.');
    if(feedback==='clear')await pool.query('DELETE FROM video_feedback WHERE video_id=$1 AND user_sub=$2',[video.id,req.auth.session.sub]);
    else await pool.query(`INSERT INTO video_feedback(video_id,user_sub,feedback) VALUES($1,$2,$3) ON CONFLICT(video_id,user_sub) DO UPDATE SET feedback=EXCLUDED.feedback,updated_at=NOW()`,[video.id,req.auth.session.sub,feedback]);
    res.json({ok:true,feedback:feedback==='clear'?null:feedback});
  }catch(error){next(error);}
});

app.get('/api/videos/:id/comments', requireValidId, accessVideo, async (req, res, next) => {
  try {
    if (req.video.comments_enabled === false) return res.json({ comments: [], commentsEnabled: false });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const result = await pool.query(`SELECT c.id,c.video_id,c.parent_id,c.body,c.created_at,c.author_sub,
      p.handle,p.display_name,p.avatar_url,p.is_verified,u.google_name
      FROM comments c JOIN app_users u ON u.google_sub=c.author_sub
      LEFT JOIN profiles p ON p.sub=c.author_sub
      WHERE c.video_id=$1 AND c.creator_hidden=FALSE AND (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM comments parent WHERE parent.id=c.parent_id AND parent.creator_hidden=FALSE)) ORDER BY c.creator_pinned DESC,c.created_at ASC LIMIT $2`, [req.video.id, limit]);
    const comments = result.rows.map(row => ({ id: row.id, videoId: row.video_id, parentId: row.parent_id, body: row.body, createdAt: toISO(row.created_at), author: { handle: row.handle || null, displayName: row.display_name || row.google_name || 'Creator', avatarUrl: row.avatar_url || null, isVerified:Boolean(row.is_verified) } }));
    res.json({ comments });
  } catch (error) { next(error); }
});
app.post('/api/videos/:id/comments', requireAuth, requireActive, requireValidId, accessVideo, async (req, res, next) => {
  try {
    if (req.video.comments_enabled === false) return jsonError(res, 403, 'এই ভিডিওতে creator comments বন্ধ রেখেছেন।');
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
    const author = await pool.query('SELECT p.handle,p.display_name,p.avatar_url,p.is_verified,u.google_name FROM app_users u LEFT JOIN profiles p ON p.sub=u.google_sub WHERE u.google_sub=$1', [req.auth.session.sub]);
    const row = author.rows[0];
    const comment = { id, videoId: req.video.id, parentId, body, createdAt: new Date().toISOString(), author: { handle: row.handle || null, displayName: row.display_name || row.google_name || 'Creator', avatarUrl: row.avatar_url || null, isVerified:Boolean(row.is_verified) } };
    io.to(`video:${req.video.id}`).emit('comment:new', comment);
    await sendNotification(req.video.owner_sub,req.auth.session.sub,'comment','New comment',`${row.display_name||row.google_name||'A viewer'} commented on ${req.video.title||'your video'}.`,`/watch/${encodeURIComponent(req.video.id)}`);
    const counts = await getCounts(req.video.id);
    emitVideoStats(req.video.id, counts);
    res.status(201).json({ comment, commentsCount: counts.commentsCount });
  } catch (error) { next(error); }
});

app.get('/api/notifications', requireAuth, async(req,res,next)=>{
  try{
    const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'30',10)||30));
    const result=await pool.query(`SELECT id,kind,title,detail,href,created_at,read_at FROM user_notifications WHERE recipient_sub=$1 ORDER BY created_at DESC LIMIT $2`,[req.auth.session.sub,limit]);
    const unread=await pool.query('SELECT COUNT(*)::bigint AS n FROM user_notifications WHERE recipient_sub=$1 AND read_at IS NULL',[req.auth.session.sub]);
    res.set('Cache-Control','private, no-store');res.json({notifications:result.rows.map(n=>({id:n.id,kind:n.kind,title:n.title,detail:n.detail,href:n.href,createdAt:n.created_at,readAt:n.read_at})),unreadCount:Number(unread.rows[0].n)});
  }catch(error){next(error);}
});
app.patch('/api/notifications/:id/read', requireAuth, requireActive, async(req,res,next)=>{
  try{if(!validUuid(req.params.id))return jsonError(res,400,'Notification id is invalid.');const r=await pool.query('UPDATE user_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND recipient_sub=$2 RETURNING id',[req.params.id,req.auth.session.sub]);if(!r.rowCount)return jsonError(res,404,'Notification not found.');res.json({ok:true});}catch(error){next(error);}
});
app.post('/api/notifications/read-all', requireAuth, requireActive, async(req,res,next)=>{
  try{await pool.query('UPDATE user_notifications SET read_at=NOW() WHERE recipient_sub=$1 AND read_at IS NULL',[req.auth.session.sub]);res.json({ok:true});}catch(error){next(error);}
});

app.get('/api/history', requireAuth, async (req, res, next) => {
  try { res.json(await loadCards({ history: true, userSub: req.auth.session.sub, viewerType: req.auth.session.viewerType, limit: Math.min(MAX_LIST, Number(req.query.limit) || 48) })); }
  catch (error) { next(error); }
});
app.delete('/api/me/history', requireAuth, requireActive, async (req, res, next) => {
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
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.owner_sub=$1 AND p.is_creator_playlist=FALSE GROUP BY p.id ORDER BY p.is_watch_later DESC,p.updated_at DESC`, [req.auth.session.sub]);
    res.json({ playlists: result.rows.map(row => ({ id: row.id, name: row.name, description: row.description, isPublic: row.is_public, isWatchLater: row.is_watch_later, videosCount: Number(row.videos_count), createdAt: toISO(row.created_at) })) });
  } catch (error) { next(error); }
});
app.post('/api/me/playlists', requireAuth, requireActive, async (req, res, next) => {
  try {
    const name = safeText(req.body?.name, 80);
    const description = safeText(req.body?.description, 500);
    if (!name) return jsonError(res, 400, 'Playlist name is required.');
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO playlists (id,owner_sub,name,description,is_public,is_creator_playlist) VALUES ($1,$2,$3,$4,$5,FALSE)', [id, req.auth.session.sub, name, description, Boolean(req.body?.isPublic)]);
    res.status(201).json({ playlist: { id, name, description, isPublic: Boolean(req.body?.isPublic), isWatchLater: false, videosCount: 0 } });
  } catch (error) { next(error); }
});
app.put('/api/me/playlists/:id', requireAuth, requireActive, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const name = safeText(req.body?.name, 80), description = safeText(req.body?.description, 1000);
    if (!name) return jsonError(res, 400, 'Playlist-এর নাম দিন।');
    const result = await pool.query(`UPDATE playlists SET name=$3,description=$4,is_public=$5,updated_at=NOW()
      WHERE id=$1 AND owner_sub=$2 AND is_watch_later=FALSE RETURNING id,name,description,is_public`,
      [req.params.id, req.auth.session.sub, name, description, Boolean(req.body?.isPublic)]);
    if (!result.rowCount) return jsonError(res, 404, 'Playlist পাওয়া যায়নি।');
    const p = result.rows[0]; res.json({ playlist: { id:p.id,name:p.name,description:p.description,isPublic:p.is_public } });
  } catch (error) { next(error); }
});
app.get('/api/playlists/:id', async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const auth = await loadSession(req);
    const result = await pool.query('SELECT * FROM playlists WHERE id=$1', [req.params.id]);
    const playlist = result.rows[0];
    if (!playlist || (!playlist.is_public && playlist.owner_sub !== auth?.session.sub)) return jsonError(res, 404, 'Playlist not found.');
    if (playlist.is_premium && playlist.owner_sub !== auth?.session.sub) {
      const entitlement = auth ? await pool.query("SELECT 1 FROM premium_playlist_entitlements WHERE playlist_id=$1 AND buyer_sub=$2", [playlist.id, auth.session.sub]) : { rowCount: 0 };
      if (!entitlement.rowCount) return jsonError(res, 403, 'এই premium playlist দেখতে আগে purchase করুন।');
    }
    const videos = await loadCards({ playlistId: playlist.id, ownerSub: playlist.owner_sub === auth?.session.sub ? playlist.owner_sub : null, userSub: auth?.session.sub, viewerType: auth?.session.viewerType || 'normal', limit: MAX_LIST });
    res.json({ playlist: { id: playlist.id, name: playlist.name, description: playlist.description, isPublic: playlist.is_public, isWatchLater: playlist.is_watch_later, isCreatorPlaylist:Boolean(playlist.is_creator_playlist) }, videos: videos.videos });
  } catch (error) { next(error); }
});
app.post('/api/me/watch-later/:id', requireAuth, requireActive, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!await canView(video, req.auth.session.sub, req.auth.session.viewerType || 'normal')) return jsonError(res, 403, 'This video is private.');
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
app.post('/api/playlists/:id/videos', requireAuth, requireActive, requireValidId, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const playlistResult = await pool.query('SELECT id,owner_sub FROM playlists WHERE id=$1', [req.params.id]);
    const playlist = playlistResult.rows[0];
    const actualVideo = await getVideo(req.body?.videoId);
    if (!playlist || playlist.owner_sub !== req.auth.session.sub) return jsonError(res, 404, 'Playlist not found.');
    if (!actualVideo) return jsonError(res, 404, 'Video not found.');
    if (!await canView(actualVideo, req.auth.session.sub, req.auth.session.viewerType || 'normal')) return jsonError(res, 403, 'This video is private.');
    await pool.query('INSERT INTO playlist_items (playlist_id,video_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [playlist.id, actualVideo.id]);
    await pool.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [playlist.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.put('/api/playlists/:id/order', requireAuth, requireActive, async (req,res,next)=>{
  try {
    if(!validUuid(req.params.id))return jsonError(res,400,'Invalid playlist id.');
    const ids=req.body?.videoIds;
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!validVideoId(id))||new Set(ids).size!==ids.length)return jsonError(res,400,'Playlist order সঠিক নয়।');
    await withTransaction(async client=>{
      const owner=await client.query('SELECT id FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_watch_later=FALSE FOR UPDATE',[req.params.id,req.auth.session.sub]);
      if(!owner.rowCount)throw Object.assign(new Error('Playlist পাওয়া যায়নি।'),{status:404});
      const existing=await client.query('SELECT video_id FROM playlist_items WHERE playlist_id=$1',[req.params.id]);
      const existingIds=new Set(existing.rows.map(row=>row.video_id));
      if(ids.length!==existingIds.size||ids.some(id=>!existingIds.has(id)))throw Object.assign(new Error('Playlist items-এর তালিকা বদলে গেছে; refresh করে আবার চেষ্টা করুন।'),{status:409});
      for(let i=0;i<ids.length;i++)await client.query('UPDATE playlist_items SET position=$3 WHERE playlist_id=$1 AND video_id=$2',[req.params.id,ids[i],i]);
      await client.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1',[req.params.id]);
    });
    res.json({ok:true});
  }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
});
app.delete('/api/playlists/:id/videos/:videoId', requireAuth, requireActive, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id) || !validVideoId(req.params.videoId)) return jsonError(res, 400, 'Invalid playlist or video id.');
    const result = await pool.query('DELETE FROM playlist_items i USING playlists p WHERE i.playlist_id=p.id AND p.id=$1 AND p.owner_sub=$2 AND i.video_id=$3 RETURNING i.video_id', [req.params.id, req.auth.session.sub, req.params.videoId]);
    if (!result.rowCount) return jsonError(res, 404, 'Playlist item not found.');
    await pool.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete('/api/playlists/:id', requireAuth, requireActive, async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return jsonError(res, 400, 'Invalid playlist id.');
    const result = await pool.query('DELETE FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_watch_later=FALSE RETURNING id', [req.params.id, req.auth.session.sub]);
    if (!result.rowCount) return jsonError(res, 404, 'Playlist not found or system playlist cannot be deleted.');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/upload-url', requireAuth, requireActive, requireChannel, async (req, res, next) => {
  try {
    const body = req.body || {};
    const filename = safeFilename(body.filename);
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    const size = Number(body.size);
    if (!body.filename || filename === 'video') return jsonError(res, 400, 'Filename is required.');
    if (!/^video\/[a-z0-9.+-]+$/i.test(contentType) || contentType.length > 128) return jsonError(res, 400, 'Only supported video file types are allowed.');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_MB * 1024 * 1024) return jsonError(res, 413, `File must be ${MAX_FILE_MB}MB or smaller.`);
    const title = safeText(body.title, 100);
    const category = normalizeCategory(body.category);
    const visibility = normalizeVisibility(body.visibility);
    const classLevel = safeText(body.classLevel, 40);
    const subject = safeText(body.subject, 80);
    const syllabusTags = normalizeSyllabusTags(body.syllabusTags);
    const creatorPlaylistId=body.creatorPlaylistId?String(body.creatorPlaylistId):null;
    if(creatorPlaylistId){if(!validUuid(creatorPlaylistId))return jsonError(res,400,'Invalid creator playlist.');const owned=await pool.query('SELECT id FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE',[creatorPlaylistId,req.auth.session.sub]);if(!owned.rowCount)return jsonError(res,404,'Creator playlist not found.');}
    const isIslamic = resolveIslamicFlag(req.auth.profile?.creator_type || 'normal', body.isIslamic);
    if (isIslamic === null) return jsonError(res, 400, 'Choose whether this video is Islamic for a Mixed creator channel.');
    const durationSeconds = body.durationSeconds === undefined || body.durationSeconds === '' ? 0 : Number(body.durationSeconds);
    if (!title) return jsonError(res, 400, 'A video title is required.');
    if (!category) return jsonError(res, 400, 'ভিডিওর বিভাগ নির্বাচন করুন।');
    if (!visibility) return jsonError(res, 400, 'ভিডিও কে দেখতে পারবে—একটি visibility নির্বাচন করুন।');
    if (category === 'শেখা' && (!classLevel || !subject || !syllabusTags.length)) return jsonError(res, 400, 'শিক্ষা বিভাগের ভিডিওর জন্য Class / level, Subject এবং অন্তত একটি Syllabus tag আবশ্যক।');
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 604800) return jsonError(res, 400, 'Video duration is invalid.');
    const id = crypto.randomUUID();
    const objectName = `videos/${id}-${filename}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(`INSERT INTO upload_intents (id,owner_sub,object_name,content_type,expected_size,title,description,category,visibility,class_level,subject,syllabus_tags,duration_seconds,is_islamic,expires_at,creator_playlist_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [id, req.auth.session.sub, objectName, contentType, size, title, safeText(body.description, 5000), category, visibility, classLevel, subject, syllabusTags, Math.round(durationSeconds), isIslamic, expiresAt, creatorPlaylistId]);
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectName, ContentType: contentType }), { expiresIn: 30 * 60 });
    res.json({ uploadUrl, objectName, id, expiresAt: expiresAt.toISOString() });
  } catch (error) { next(error); }
});
app.post('/api/finish', requireAuth, requireActive, requireChannel, async (req, res, next) => {
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
    const visibility = req.body?.visibility === undefined ? null : normalizeVisibility(req.body.visibility);
    const classLevel = req.body?.classLevel === undefined ? (intent.class_level || '') : safeText(req.body.classLevel, 40);
    const subject = req.body?.subject === undefined ? (intent.subject || '') : safeText(req.body.subject, 80);
    const syllabusTags = req.body?.syllabusTags === undefined ? (intent.syllabus_tags || []) : normalizeSyllabusTags(req.body.syllabusTags);
    const durationSeconds = req.body?.durationSeconds === undefined ? (Number(intent.duration_seconds) || 0) : Number(req.body.durationSeconds);
    if (!title || !category || !visibility) return jsonError(res, 400, 'শিরোনাম, বিভাগ এবং visibility নির্বাচন করুন।');
    if (category === 'শেখা' && (!classLevel || !subject || !syllabusTags.length)) return jsonError(res, 400, 'শিক্ষা বিভাগের ভিডিওর জন্য Class / level, Subject এবং অন্তত একটি Syllabus tag আবশ্যক।');
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 604800) return jsonError(res, 400, 'Video duration is invalid.');
    const head = await objectHead(intent.object_name);
    if (!head) return jsonError(res, 404, 'Uploaded file not found in R2.');
    if (Number(head.ContentLength) !== Number(intent.expected_size) || Number(head.ContentLength) > MAX_FILE_MB * 1024 * 1024) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: intent.object_name })).catch(() => {});
      return jsonError(res, 413, 'Uploaded file size does not match the intent.');
    }
    if (head.ContentType && head.ContentType !== intent.content_type) return jsonError(res, 400, 'Uploaded file type does not match the intent.');
    const profile = await loadProfile(req.auth.session.sub);
    const inserted = await withTransaction(async client => {
      const result = await client.query(`INSERT INTO videos (id,object_name,owner_sub,title,description,category,visibility,size,class_level,subject,syllabus_tags,duration_seconds,is_islamic,islamic_certification_status,created_at,legacy)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),FALSE) RETURNING *`,
        [intent.id, intent.object_name, req.auth.session.sub, title, description, category, visibility, Number(head.ContentLength), classLevel, subject, syllabusTags, Math.round(durationSeconds), Boolean(intent.is_islamic), intent.is_islamic ? 'pending' : 'not_applicable']);
      if(intent.creator_playlist_id) await client.query(`INSERT INTO playlist_items(playlist_id,video_id) SELECT id,$2 FROM playlists WHERE id=$1 AND owner_sub=$3 AND is_creator_playlist=TRUE ON CONFLICT DO NOTHING`,[intent.creator_playlist_id,intent.id,req.auth.session.sub]);
      await client.query('DELETE FROM upload_intents WHERE id=$1', [intent.id]);
      return result.rows[0];
    });
    const video=videoCard({ ...inserted, owner_handle: profile?.handle, owner_name: profile?.display_name, owner_avatar: profile?.avatar_url, owner_verified:profile?.is_verified });
    const subscribers=await pool.query('SELECT subscriber_sub FROM subscriptions WHERE channel_sub=$1',[req.auth.session.sub]);
    for(const row of subscribers.rows)await sendNotification(row.subscriber_sub,req.auth.session.sub,'new_video','New video from '+(profile?.display_name||'a channel'),title,'/watch/'+encodeURIComponent(intent.id));
    res.json({ ok: true, video });
  } catch (error) { next(error); }
});

app.delete('/api/videos/:id', requireAuth, requireActive, requireValidId, async (req, res, next) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return jsonError(res, 404, 'Video not found.');
    if (!video.owner_sub || video.owner_sub !== req.auth.session.sub) return jsonError(res, 403, 'Only the owner can delete this video.');
    const orders=await pool.query("SELECT 1 FROM premium_playlist_orders WHERE video_id=$1 AND status IN('pending','paid') LIMIT 1",[video.id]);
    if(orders.rowCount)return jsonError(res,409,'This video has a pending premium order or purchase; disable premium or change visibility instead of deleting the purchased media.');
    if (!video.object_name || !video.object_name.startsWith(`videos/${video.id}-`) || !/^videos\/[0-9a-f-]+-[a-zA-Z0-9._-]+$/i.test(video.object_name)) return jsonError(res, 409, 'Video object is invalid; not deleted.');
    if (video.thumbnail_object_name && !new RegExp(`^thumbnails/${video.id}-[a-f0-9]{24}\\.(?:jpg|png|webp)$`).test(video.thumbnail_object_name)) return jsonError(res, 409, 'Thumbnail object is invalid; not deleted.');
    try {
      const deletions = await Promise.allSettled([video.object_name, video.thumbnail_object_name].filter(Boolean).map(key => s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))));
      const failed = deletions.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (error) {
      console.error('Could not permanently delete all R2 objects:', error.message);
      return jsonError(res, 502, 'R2 deletion failed. Video metadata was retained; retry permanent delete.');
    }
    const deleted = await pool.query('DELETE FROM videos WHERE id=$1 AND owner_sub=$2 RETURNING id', [video.id, req.auth.session.sub]);
    if (!deleted.rowCount) return jsonError(res, 404, 'Video not found.');
    res.json({ ok: true, permanentlyDeleted: true });
  } catch (error) { next(error); }
});

require('./learning')({ app, pool, withTransaction, s3, bucket: R2_BUCKET, requireAuth, requireActive, requireValidId, getVideo, canView, loadSession, safeText, sha, objectHead });
require('./admin')({ app, requireAuth, requireActive, loadSession, notifyUser:sendNotification, getVideo, signedVideoUrl });
require('./creator-studio')({ app, pool, requireAuth, requireActive, requireChannel, requireValidId, validUuid, safeText, normalizeCategory, normalizeVisibility });
require('./premium-marketplace')({ app, pool, withTransaction, requireAuth, requireActive, requireChannel, loadSession, validUuid, safeText });
require('./shop-approval')({ app, pool, withTransaction, requireAuth, requireActive, safeText, validVideoId });
require('./talent-marketplace')({ app, pool, withTransaction, requireAuth, requireActive, requireChannel, validUuid });

io.use(async (socket, next) => {
  try {
    const raw = verifyValue(parseCookieHeader(socket.handshake.headers.cookie || '').vh_session);
    if (!raw) { socket.data.sub = null; return next(); }
    const result = await pool.query('SELECT s.sub,u.viewer_type FROM sessions s JOIN app_users u ON u.google_sub=s.sub WHERE s.token_hash=$1 AND s.expires_at>NOW()', [sha(raw)]);
    socket.data.sub = result.rows[0]?.sub || null;
    socket.data.viewerType = result.rows[0]?.viewer_type || 'normal';
    next();
  } catch (error) { next(error); }
});
io.on('connection', socket => {
  if(socket.data.sub) socket.join(`user:${socket.data.sub}`);
  socket.on('video:join', async id => {
    try {
      if (!socket.data.sub || !validVideoId(id)) return;
      const video = await getVideo(id);
      if (!video || !await canView(video, socket.data.sub, socket.data.viewerType || 'normal')) return;
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
  await requestLimits.connectRequestLimitStore();
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
  server.listen(PORT, '0.0.0.0', () => console.log(`Atharo running on port ${PORT}; Neon and Socket.IO ready.`));
}
if (require.main === module) start().catch(error => {
  console.error('Application startup failed:', error.message);
  process.exit(1);
});

module.exports = { app, server, io, start, pool };
