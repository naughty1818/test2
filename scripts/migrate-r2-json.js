'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { pool, initializeDatabase } = require('../db');

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
const categories = new Set(['ভ্রমণ', 'রান্না', 'ক্রিয়েটর', 'গল্প', 'শেখা', 'অন্যান্য']);
const visibilityValues = new Set(['Public', 'Unlisted', 'Private']);
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeText(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''; }
function safeHandle(value) {
  return safeText(value, 30).toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30);
}
function validDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}
async function listKeys(prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken }));
    for (const object of page.Contents || []) if (object.Key) keys.push(object.Key);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}
async function readJson(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return JSON.parse(await response.Body.transformToString());
}
async function ensureUser(sub, identity = {}) {
  if (!sub || typeof sub !== 'string') return;
  await pool.query(`
    INSERT INTO app_users (google_sub, email, google_name, google_picture)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (google_sub) DO UPDATE SET
      email = COALESCE(EXCLUDED.email, app_users.email),
      google_name = CASE WHEN EXCLUDED.google_name <> '' THEN EXCLUDED.google_name ELSE app_users.google_name END,
      google_picture = COALESCE(EXCLUDED.google_picture, app_users.google_picture),
      updated_at = NOW()
  `, [sub, identity.email || null, safeText(identity.name, 120), identity.picture || null]);
}
async function main() {
  const missing = ['DATABASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  await initializeDatabase();
  const prior = await pool.query('SELECT completed_at, summary FROM storage_migrations WHERE name = $1', ['r2-json-v1']);
  if (prior.rowCount) {
    console.log('R2 JSON migration was already completed at', prior.rows[0].completed_at.toISOString());
    console.log('Previous import summary:', prior.rows[0].summary);
    console.log('Nothing changed. Pass no flags; old R2 JSON files remain untouched.');
    return;
  }

  const totals = { users: 0, profiles: 0, videos: 0, sessions: 0, likes: 0, views: 0, skipped: 0 };
  const userSeen = new Set();
  const ensure = async (sub, identity) => {
    if (!sub || userSeen.has(sub)) return;
    await ensureUser(sub, identity);
    userSeen.add(sub);
    totals.users++;
  };

  // Sessions provide verified account emails and identity data for the imported users.
  for (const key of await listKeys('sessions/')) {
    try {
      const item = await readJson(key);
      await ensure(item.sub, { email: item.email, name: item.name, picture: item.picture });
    } catch (error) { console.warn('Could not read a legacy session:', key, error.message); totals.skipped++; }
  }
  // Profiles and video owners may outlive their old login session.
  for (const key of await listKeys('profiles/')) {
    try {
      const item = await readJson(key);
      await ensure(item.sub, { name: item.displayName, picture: item.avatarUrl });
    } catch (error) { console.warn('Could not read a legacy profile:', key, error.message); totals.skipped++; }
  }
  const videoKeys = await listKeys('meta/');
  for (const key of videoKeys) {
    const id = /^meta\/([^/]+)\.json$/.exec(key)?.[1];
    if (!id) { totals.skipped++; continue; }
    try {
      const meta = await readJson(key);
      if (!meta || !meta.objectName) { totals.skipped++; continue; }
      await ensure(meta.ownerSub, { name: meta.ownerName });
      const created = validDate(meta.created, new Date(0));
      const category = categories.has(meta.category) ? meta.category : 'অন্যান্য';
      const visibility = visibilityValues.has(meta.visibility) ? meta.visibility : 'Public';
      const legacy = !meta.id || !meta.visibility || !meta.ownerSub;
      await pool.query(`
        INSERT INTO videos (id, object_name, owner_sub, title, description, category, visibility, size, created_at, legacy, likes_count, views_count, comments_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,0)
        ON CONFLICT (id) DO UPDATE SET
          object_name = EXCLUDED.object_name,
          owner_sub = COALESCE(EXCLUDED.owner_sub, videos.owner_sub),
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          visibility = EXCLUDED.visibility,
          size = EXCLUDED.size,
          created_at = EXCLUDED.created_at,
          legacy = videos.legacy OR EXCLUDED.legacy
      `, [id, meta.objectName, meta.ownerSub || null, safeText(meta.title, 100) || 'Untitled video', safeText(meta.description, 5000), category, visibility, Math.max(0, Number(meta.size) || 0), created, legacy]);
      totals.videos++;
    } catch (error) { console.warn('Could not import legacy video metadata:', key, error.message); totals.skipped++; }
  }

  // Preserve public handles while ensuring each migrated profile has a valid unique handle.
  const profileHandles = new Map();
  for (const key of await listKeys('profiles/')) {
    try {
      const profile = await readJson(key);
      if (!profile?.sub) { totals.skipped++; continue; }
      await ensure(profile.sub, { name: profile.displayName, picture: profile.avatarUrl });
      let handle = safeHandle(profile.handle) || `creator-${sha(profile.sub).slice(0, 6)}`;
      const conflict = await pool.query('SELECT sub FROM profiles WHERE handle = $1 AND sub <> $2', [handle, profile.sub]);
      if (conflict.rowCount) handle = `${handle.slice(0, 22)}-${sha(profile.sub).slice(0, 6)}`;
      await pool.query(`
        INSERT INTO profiles (sub, handle, display_name, bio, avatar_url, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (sub) DO UPDATE SET handle=EXCLUDED.handle, display_name=EXCLUDED.display_name, bio=EXCLUDED.bio, avatar_url=COALESCE(EXCLUDED.avatar_url,profiles.avatar_url), updated_at=EXCLUDED.updated_at
      `, [profile.sub, handle, safeText(profile.displayName, 120) || 'Creator', safeText(profile.bio, 1000), profile.avatarUrl || null, validDate(profile.createdAt, new Date(0)), validDate(profile.updatedAt, new Date(0))]);
      profileHandles.set(profile.sub, handle);
      totals.profiles++;
    } catch (error) { console.warn('Could not import a legacy profile:', key, error.message); totals.skipped++; }
  }

  // Old sessions are migrated by token hash, so a still-valid browser cookie keeps working.
  for (const key of await listKeys('sessions/')) {
    try {
      const tokenHash = /^sessions\/([a-f0-9]{64})\.json$/i.exec(key)?.[1];
      const session = await readJson(key);
      if (!tokenHash || !session.sub || !session.expiresAt || validDate(session.expiresAt, new Date(0)) <= new Date()) continue;
      await ensure(session.sub, { email: session.email, name: session.name, picture: session.picture });
      await pool.query(`INSERT INTO sessions (token_hash,sub,created_at,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token_hash) DO NOTHING`, [tokenHash, session.sub, validDate(session.createdAt), validDate(session.expiresAt)]);
      totals.sessions++;
    } catch (error) { console.warn('Could not import a legacy session:', key, error.message); totals.skipped++; }
  }

  for (const key of await listKeys('likes/')) {
    try {
      const match = /^likes\/([^/]+)\/([^/]+)\.json$/.exec(key);
      if (!match) continue;
      const value = await readJson(key);
      if (!value?.sub) continue;
      await ensure(value.sub);
      const result = await pool.query('INSERT INTO video_likes (video_id,user_sub,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING video_id', [match[1], value.sub, validDate(value.createdAt)]);
      if (result.rowCount) totals.likes++;
    } catch (error) { console.warn('Could not import a legacy like:', key, error.message); totals.skipped++; }
  }
  for (const key of await listKeys('views/')) {
    try {
      const match = /^views\/([^/]+)\/([^/]+)\.json$/.exec(key);
      if (!match) continue;
      const value = await readJson(key);
      const result = await pool.query('INSERT INTO video_views (video_id,viewer_hash,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING video_id', [match[1], match[2], validDate(value.createdAt)]);
      if (result.rowCount) totals.views++;
    } catch (error) { console.warn('Could not import a legacy view:', key, error.message); totals.skipped++; }
  }

  // Rebuild denormalized counters from the imported relation rows.
  await pool.query(`UPDATE videos v SET likes_count=(SELECT COUNT(*) FROM video_likes l WHERE l.video_id=v.id), views_count=(SELECT COUNT(*) FROM video_views w WHERE w.video_id=v.id)`);
  const summary = { ...totals, importedFrom: 'Cloudflare R2 JSON objects', note: 'Original R2 JSON objects were not deleted.' };
  await pool.query('INSERT INTO storage_migrations (name, summary) VALUES ($1,$2::jsonb)', ['r2-json-v1', JSON.stringify(summary)]);
  console.log('R2 JSON migration completed:', summary);
  console.log('Video binary objects were not copied or deleted; they remain in R2.');
}

main().catch(error => {
  console.error('R2-to-Neon migration failed. Source R2 data remains untouched.', error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end().catch(() => {});
  await s3.destroy();
});
