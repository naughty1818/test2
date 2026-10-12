'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('./db');

module.exports = function registerConsole({ app, requireAuth, requireActive, loadSession }) {
  const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const validUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const validVideoId = value => typeof value === 'string' && (validUuid(value) || /^\d+-[0-9a-f]{8}$/i.test(value));
  const clean = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
  const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
  const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const safeUrl = value => {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return url.toString().slice(0, 2048);
    } catch (_) { return null; }
  };
  const jsonError = (res, status, error) => res.status(status).json({ error });
  const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  const fail = (res, error) => jsonError(res, 400, error);

  async function resolveRole(email) {
    const normalized = emailOf(email);
    if (!normalized) return null;
    if (OWNER_EMAIL && normalized === OWNER_EMAIL) return { email: normalized, role: 'owner' };
    const result = await pool.query('SELECT email,role FROM admin_members WHERE email=$1', [normalized]);
    return result.rows[0] || null;
  }

  function adminAuth(...allowedRoles) {
    return async (req, res, next) => {
      try {
        req.auth = req.auth || await loadSession(req);
        if (!req.auth) return jsonError(res, 401, 'লগইন আবশ্যক। / Authentication required.');
        if (req.auth.session.emailVerified !== true) return jsonError(res, 403, 'Verified Google account required.');
        const admin = await resolveRole(req.auth.session.email);
        if (!admin) return jsonError(res, 403, 'Admin access নেই। / Admin access required.');
        if (admin.role !== 'owner' && allowedRoles.length && !allowedRoles.includes(admin.role)) return jsonError(res, 403, 'এই কাজের অনুমতি নেই। / Insufficient admin permission.');
        if (admin.role !== 'owner' && !allowedRoles.length) return jsonError(res, 403, 'Owner permission required.');
        req.admin = admin;
        next();
      } catch (error) { next(error); }
    };
  }

  async function writeAudit(client, actor, action, targetType, targetId, reason = '', metadata = {}) {
    await client.query(`INSERT INTO admin_audit_logs (actor_email,actor_role,action,target_type,target_id,reason,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [actor.email, actor.role, action, targetType, targetId || null, clean(reason, 2000), JSON.stringify(metadata || {})]);
  }

  function readCookie(req, name) {
    for (const part of String(req.get('cookie') || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === name) {
        try { return decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { return ''; }
      }
    }
    return '';
  }
  function adVisitor(req, res) {
    let token = readCookie(req, 'vh_ad_visitor');
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) {
      token = crypto.randomBytes(32).toString('base64url');
      const cookie = `vh_ad_visitor=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
      res.append('Set-Cookie', cookie);
    }
    return token;
  }

  // Public ad serving is disabled until the verified owner enables it and activates campaigns.
  app.get('/api/sponsor/serve', async (req, res, next) => {
    try {
      const placement = String(req.query.placement || '');
      const channelHandle = req.query.handle ? String(req.query.handle).replace(/^@/,'').trim() : null;
      if (!['feed','watch_sidebar','channel','sticky_banner','postroll'].includes(placement)) return fail(res, 'Invalid ad placement.');
      if (placement === 'channel' && !channelHandle) return fail(res, 'Channel handle is required.');
      const settings = await pool.query('SELECT ads_enabled,ad_feed_enabled,ad_watch_sidebar_enabled,ad_channel_enabled,ad_sticky_enabled,ad_postroll_enabled FROM platform_settings WHERE id=1');
      const settingKey = {feed:'ad_feed_enabled',watch_sidebar:'ad_watch_sidebar_enabled',channel:'ad_channel_enabled',sticky_banner:'ad_sticky_enabled',postroll:'ad_postroll_enabled'}[placement];
      if (!settings.rows[0]?.ads_enabled || !settings.rows[0]?.[settingKey]) return res.json({ ad: null });
      const result = await pool.query(`SELECT c.id,c.title,c.sponsor_name,c.placement,c.creative_url,c.destination_url
        FROM ad_campaigns c WHERE c.placement=$1 AND c.status='active'
          AND (c.starts_at IS NULL OR c.starts_at<=NOW()) AND (c.ends_at IS NULL OR c.ends_at>NOW())
        ORDER BY (SELECT COUNT(*) FROM ad_events e WHERE e.campaign_id=c.id AND e.event_type='impression') ASC,
                 c.created_at ASC LIMIT 1`, [placement]);
      const row = result.rows[0];
      res.set('Cache-Control', 'no-store');
      res.json({ ad: row ? { id: row.id, title: row.title, sponsorName: row.sponsor_name, placement: row.placement, creativeUrl: row.creative_url, destinationUrl: row.destination_url } : null });
    } catch (error) { next(error); }
  });

  app.post('/api/sponsor/events', async (req, res, next) => {
    try {
      const campaignId = String(req.body?.campaignId || '');
      const eventType = String(req.body?.eventType || '');
      const videoId = req.body?.videoId ? String(req.body.videoId) : null;
      const channelHandle = req.body?.channelHandle ? String(req.body.channelHandle).replace(/^@/,'').trim() : null;
      if (!validUuid(campaignId) || !['impression','click'].includes(eventType)) return fail(res, 'Invalid ad event.');
      if (videoId && !validVideoId(videoId)) return fail(res, 'Invalid video id.');
      const campaignResult = await pool.query(`SELECT id,cpm_bdt,placement FROM ad_campaigns WHERE id=$1 AND status='active'
        AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>NOW())`, [campaignId]);
      if (!campaignResult.rowCount) return jsonError(res, 404, 'Ad campaign unavailable.');
      const placement = campaignResult.rows[0].placement;
      if ((placement === 'watch_sidebar' && !videoId) || (['feed','sticky_banner','postroll'].includes(placement) && (videoId || channelHandle)) || (placement === 'channel' && (!channelHandle || videoId))) return fail(res, 'Ad placement and context do not match.');
      let creatorSub = null;
      let creatorEligible = false;
      if (channelHandle) {
        const channel = await pool.query(`SELECT p.sub,p.monetization_status FROM profiles p WHERE lower(p.handle)=lower($1)`, [channelHandle]);
        if (!channel.rowCount) return jsonError(res, 404, 'Ad channel context unavailable.');
        creatorSub = channel.rows[0].sub || null;
        creatorEligible = channel.rows[0].monetization_status === 'enabled';
      } else if (videoId) {
        const video = await pool.query(`SELECT v.owner_sub,v.visibility,v.moderation_status,u.account_status,p.monetization_status
          FROM videos v LEFT JOIN app_users u ON u.google_sub=v.owner_sub LEFT JOIN profiles p ON p.sub=v.owner_sub WHERE v.id=$1`, [videoId]);
        const row = video.rows[0];
        if (!row || row.visibility !== 'Public' || row.moderation_status !== 'active' || row.account_status !== 'active') return jsonError(res, 404, 'Ad video context unavailable.');
        creatorSub = row.owner_sub || null;
        creatorEligible = row.monetization_status === 'enabled';
      }
      const settingsResult = await pool.query('SELECT monetization_enabled,creator_share_percent FROM platform_settings WHERE id=1');
      const settings = settingsResult.rows[0] || {};
      const grossPerImpression = Number(campaignResult.rows[0].cpm_bdt || 0) / 1000;
      const share = Number(settings.creator_share_percent || 0) / 100;
      const estimate = eventType === 'impression' && ['watch_sidebar','channel'].includes(placement) && creatorSub && creatorEligible && settings.monetization_enabled ? grossPerImpression * share : 0;
      const visitor = adVisitor(req, res);
      const dayKey = new Date().toISOString().slice(0,10);
      const dedupe = sha(`${visitor}|${campaignId}|${eventType}|${videoId || 'feed'}|${dayKey}`);
      const inserted = await pool.query(`INSERT INTO ad_events (campaign_id,video_id,creator_sub,event_type,dedupe_key,estimated_creator_earnings_bdt)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (campaign_id,event_type,dedupe_key) DO NOTHING RETURNING id`,
        [campaignId, videoId, creatorSub, eventType, dedupe, estimate]);
      res.json({ ok: true, counted: inserted.rowCount > 0 });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/me', requireAuth, async (req, res, next) => {
    try {
      const role = await resolveRole(req.auth.session.email);
      res.json({ role: role?.role || null });
    } catch (error) { next(error); }
  });

  app.get('/api/creator/analytics', requireAuth, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const daysRaw = Number.parseInt(req.query.days || '30', 10) || 30;
      const days = [7,30,90].includes(daysRaw) ? daysRaw : 30;
      const [totals, subscriberTotal, daily, videos, adStats, profile, strikes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS videos_count,COALESCE(SUM(views_count),0)::bigint AS views_count,
            COALESCE(SUM(likes_count),0)::bigint AS likes_count,COALESCE(SUM(comments_count),0)::bigint AS comments_count
          FROM videos WHERE owner_sub=$1`, [sub]),
        pool.query('SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE channel_sub=$1', [sub]),
        pool.query(`SELECT TO_CHAR(DATE_TRUNC('day',vv.created_at),'YYYY-MM-DD') AS day,COUNT(*)::bigint AS views
          FROM video_views vv JOIN videos v ON v.id=vv.video_id
          WHERE v.owner_sub=$1 AND vv.created_at>=NOW()-($2::int*INTERVAL '1 day')
          GROUP BY DATE_TRUNC('day',vv.created_at) ORDER BY DATE_TRUNC('day',vv.created_at)`, [sub, days]),
        pool.query(`SELECT v.id,v.title,v.visibility,v.moderation_status,v.created_at,v.views_count,v.likes_count,v.comments_count,
            COUNT(e.id) FILTER (WHERE e.event_type='impression')::bigint AS ad_impressions,
            COUNT(e.id) FILTER (WHERE e.event_type='click')::bigint AS ad_clicks,
            COALESCE(SUM(e.estimated_creator_earnings_bdt),0)::numeric(14,4) AS estimated_earnings_bdt
          FROM videos v LEFT JOIN ad_events e ON e.video_id=v.id AND e.created_at>=NOW()-($2::int*INTERVAL '1 day')
          WHERE v.owner_sub=$1 GROUP BY v.id ORDER BY v.views_count DESC,v.created_at DESC LIMIT 100`, [sub, days]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE event_type='impression')::bigint AS impressions,
            COUNT(*) FILTER (WHERE event_type='click')::bigint AS clicks,
            COALESCE(SUM(estimated_creator_earnings_bdt),0)::numeric(14,4) AS estimated_earnings_bdt
          FROM ad_events WHERE creator_sub=$1 AND created_at>=NOW()-($2::int*INTERVAL '1 day')`, [sub, days]),
        pool.query(`SELECT p.monetization_status,s.ads_enabled,s.monetization_enabled,s.creator_share_percent
          FROM profiles p CROSS JOIN platform_settings s WHERE p.sub=$1 AND s.id=1`, [sub]),
        pool.query("SELECT COUNT(*)::bigint AS n FROM copyright_strikes WHERE channel_sub=$1 AND status IN ('active','appealed')", [sub])
      ]);
      const total = totals.rows[0] || {};
      const monet = profile.rows[0] || {};
      const ads = adStats.rows[0] || {};
      res.json({ days, totals: { videos: Number(total.videos_count)||0, views: Number(total.views_count)||0, likes: Number(total.likes_count)||0, comments: Number(total.comments_count)||0, subscribers: Number(subscriberTotal.rows[0]?.n)||0 },
        viewsByDay: daily.rows.map(row => ({ day: row.day, views: Number(row.views)||0 })),
        videos: videos.rows.map(row => ({ id: row.id, title: row.title, visibility: row.visibility, moderationStatus: row.moderation_status, createdAt: row.created_at, views: Number(row.views_count)||0, likes: Number(row.likes_count)||0, comments: Number(row.comments_count)||0, adImpressions: Number(row.ad_impressions)||0, adClicks: Number(row.ad_clicks)||0, estimatedEarningsBdt: Number(row.estimated_earnings_bdt)||0 })),
        ads: { impressions: Number(ads.impressions)||0, clicks: Number(ads.clicks)||0, estimatedEarningsBdt: Number(ads.estimated_earnings_bdt)||0 },
        monetizationStatus: monet.monetization_status || 'pending', monetizationEnabled: Boolean(monet.monetization_enabled), adsEnabled: Boolean(monet.ads_enabled), creatorSharePercent: monet.creator_share_percent === null || monet.creator_share_percent === undefined ? null : Number(monet.creator_share_percent), activeStrikes: Number(strikes.rows[0]?.n)||0 });
    } catch (error) { next(error); }
  });

  app.get('/api/creator/strikes', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT s.id,s.video_id,v.title AS video_title,s.reason,s.status,s.appeal_text,s.created_at,s.appealed_at
        FROM copyright_strikes s LEFT JOIN videos v ON v.id=s.video_id WHERE s.channel_sub=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.auth.session.sub]);
      res.json({ strikes: result.rows.map(row => ({ id: row.id, videoId: row.video_id, videoTitle: row.video_title || 'ভিডিও আর উপলভ্য নয়', reason: row.reason, status: row.status, appealText: row.appeal_text, createdAt: row.created_at, appealedAt: row.appealed_at })) });
    } catch (error) { next(error); }
  });

  app.post('/api/creator/strikes/:id/appeal', requireAuth, async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return fail(res, 'Invalid strike id.');
      const appeal = clean(req.body?.appeal, 2000);
      if (appeal.length < 10) return fail(res, 'Appeal-এ অন্তত ১০ অক্ষরের ব্যাখ্যা লিখুন।');
      const result = await pool.query(`UPDATE copyright_strikes SET appeal_text=$3,status='appealed',appealed_at=NOW()
        WHERE id=$1 AND channel_sub=$2 AND status='active' RETURNING id`, [req.params.id, req.auth.session.sub, appeal]);
      if (!result.rowCount) return jsonError(res, 404, 'Appealable active strike পাওয়া যায়নি।');
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/overview', adminAuth('admin','moderator'), async (req, res, next) => {
    try {
      const [users,videos,channels,strikes,campaigns,adStats,settings] = await Promise.all([
        pool.query('SELECT COUNT(*)::bigint AS n FROM app_users'),
        pool.query("SELECT COUNT(*)::bigint AS n FROM videos WHERE moderation_status='active'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM app_users WHERE account_status='active'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM copyright_strikes WHERE status IN ('active','appealed')"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM ad_campaigns WHERE status='active' AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>NOW())"),
        pool.query(`SELECT COUNT(*) FILTER (WHERE event_type='impression')::bigint AS impressions,COUNT(*) FILTER (WHERE event_type='click')::bigint AS clicks,
          COALESCE(SUM(estimated_creator_earnings_bdt),0)::numeric(14,4) AS creator_estimate FROM ad_events`),
        pool.query('SELECT ads_enabled,monetization_enabled,creator_share_percent FROM platform_settings WHERE id=1')
      ]);
      const s = settings.rows[0] || {}; const ads = adStats.rows[0] || {};
      res.json({ counts: { users: Number(users.rows[0].n), videos: Number(videos.rows[0].n), activeAccounts: Number(channels.rows[0].n), openStrikes: Number(strikes.rows[0].n), activeCampaigns: Number(campaigns.rows[0].n) }, ads: { impressions: Number(ads.impressions), clicks: Number(ads.clicks), estimatedCreatorEarningsBdt: Number(ads.creator_estimate) }, settings: { adsEnabled: s.ads_enabled, monetizationEnabled: s.monetization_enabled, creatorSharePercent: s.creator_share_percent === null ? null : Number(s.creator_share_percent) } });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/content', adminAuth('admin','moderator'), async (req, res, next) => {
    try {
      const q = clean(req.query.q, 100);
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const [videos,channels,strikes] = await Promise.all([
        pool.query(`SELECT v.id,v.title,v.visibility,v.moderation_status,v.owner_sub,v.created_at,p.handle,p.display_name
          FROM videos v LEFT JOIN profiles p ON p.sub=v.owner_sub
          WHERE $1='' OR v.title ILIKE $2 OR p.handle ILIKE $2 OR p.display_name ILIKE $2
          ORDER BY v.created_at DESC LIMIT 100`, [q,pattern]),
        pool.query(`SELECT u.google_sub,u.email,u.account_status,u.created_at,p.handle,p.display_name,p.monetization_status,
            (SELECT COUNT(*) FROM videos v WHERE v.owner_sub=u.google_sub) AS videos_count
          FROM app_users u LEFT JOIN profiles p ON p.sub=u.google_sub
          WHERE $1='' OR ($3::boolean AND u.email ILIKE $2) OR p.handle ILIKE $2 OR p.display_name ILIKE $2
          ORDER BY u.created_at DESC LIMIT 100`, [q,pattern,req.admin.role!=='moderator']),
        pool.query(`SELECT s.id,s.video_id,s.channel_sub,s.reason,s.status,s.created_at,p.handle,p.display_name,v.title
          FROM copyright_strikes s LEFT JOIN profiles p ON p.sub=s.channel_sub LEFT JOIN videos v ON v.id=s.video_id
          ORDER BY s.created_at DESC LIMIT 100`)
      ]);
      res.json({ videos: videos.rows.map(r=>({id:r.id,title:r.title,visibility:r.visibility,moderationStatus:r.moderation_status,ownerSub:r.owner_sub,createdAt:r.created_at,handle:r.handle,ownerName:r.display_name})),
        channels: channels.rows.map(r=>({userSub:r.google_sub,email:req.admin.role==='moderator'?null:r.email,status:r.account_status,createdAt:r.created_at,handle:r.handle,displayName:r.display_name,monetizationStatus:r.monetization_status,videosCount:Number(r.videos_count)})),
        strikes: strikes.rows.map(r=>({id:r.id,videoId:r.video_id,channelSub:r.channel_sub,reason:r.reason,status:r.status,createdAt:r.created_at,handle:r.handle,displayName:r.display_name,videoTitle:r.title})) });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/actions', adminAuth('admin','moderator'), async (req, res, next) => {
    try {
      const action = String(req.body?.action || '');
      const reason = clean(req.body?.reason, 2000);
      if (reason.length < 5) return fail(res, 'Action-এর কারণ অন্তত ৫ অক্ষরের হতে হবে।');
      const actor = req.admin;
      const videoId = String(req.body?.videoId || '');
      const userSub = clean(req.body?.userSub, 255);
      const strikeId = String(req.body?.strikeId || '');
      const evidenceUrl = req.body?.evidenceUrl ? safeUrl(req.body.evidenceUrl) : null;
      if (req.body?.evidenceUrl && !evidenceUrl) return fail(res, 'Evidence link অবশ্যই নিরাপদ HTTPS URL হতে হবে।');
      if (['remove_video','restore_video','copyright_strike'].includes(action)) {
        if (!validVideoId(videoId)) return fail(res, 'Valid video নির্বাচন করুন।');
        const video = await pool.query('SELECT id,owner_sub,title FROM videos WHERE id=$1', [videoId]);
        if (!video.rowCount) return jsonError(res, 404, 'ভিডিও পাওয়া যায়নি।');
        await withTransaction(async client => {
          if (action === 'remove_video') await client.query("UPDATE videos SET moderation_status='removed' WHERE id=$1", [videoId]);
          if (action === 'restore_video') await client.query("UPDATE videos SET moderation_status='active' WHERE id=$1", [videoId]);
          if (action === 'copyright_strike') {
            if (!video.rows[0].owner_sub) throw Object.assign(new Error('এই ভিডিওর channel owner নির্ধারিত নয়।'), { status: 409 });
            await client.query("UPDATE videos SET moderation_status='removed' WHERE id=$1", [videoId]);
            await client.query(`INSERT INTO copyright_strikes (id,video_id,channel_sub,reason,evidence_url,issued_by_email)
              VALUES ($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(),videoId,video.rows[0].owner_sub,reason,evidenceUrl,actor.email]);
          }
          await writeAudit(client, actor, action, 'video', videoId, reason, { title: video.rows[0].title, evidenceUrl });
        });
      } else if (['suspend_channel','ban_channel','unban_channel'].includes(action)) {
        if (!userSub || userSub.length > 255) return fail(res, 'Channel নির্বাচন করুন।');
        if (userSub === req.auth.session.sub && action !== 'unban_channel') return fail(res, 'নিজের account-এ এই action দেওয়া যাবে না।');
        const status = action === 'unban_channel' ? 'active' : action === 'ban_channel' ? 'banned' : 'suspended';
        const target = await pool.query('SELECT google_sub FROM app_users WHERE google_sub=$1', [userSub]);
        if (!target.rowCount) return jsonError(res, 404, 'Channel account পাওয়া যায়নি।');
        await withTransaction(async client => {
          await client.query('UPDATE app_users SET account_status=$2,updated_at=NOW() WHERE google_sub=$1', [userSub,status]);
          await writeAudit(client, actor, action, 'channel', userSub, reason, { status });
        });
      } else if (action === 'dismiss_strike' || action === 'resolve_strike') {
        if (!validUuid(strikeId)) return fail(res, 'Strike নির্বাচন করুন।');
        const status = action === 'dismiss_strike' ? 'dismissed' : 'resolved';
        const result = await withTransaction(async client => {
          const updated = await client.query('UPDATE copyright_strikes SET status=$2,resolved_by_email=$3,resolved_at=NOW() WHERE id=$1 AND status IN (\'active\',\'appealed\') RETURNING channel_sub,video_id', [strikeId,status,actor.email]);
          if (!updated.rowCount) return false;
          await writeAudit(client, actor, action, 'strike', strikeId, reason, { status });
          return true;
        });
        if (!result) return jsonError(res, 404, 'Open strike পাওয়া যায়নি।');
      } else {
        return fail(res, 'Action type সমর্থিত নয়।');
      }
      res.json({ ok: true });
    } catch (error) { if (error.status) return jsonError(res,error.status,error.message); next(error); }
  });

  app.post('/api/admin/creators/:sub/monetization', adminAuth(), async (req, res, next) => {
    try {
      const sub = clean(req.params.sub, 255);
      const status = String(req.body?.status || '');
      const reason = clean(req.body?.reason, 1000);
      if (!['pending','enabled','paused','rejected'].includes(status)) return fail(res, 'Invalid monetization status.');
      const result = await withTransaction(async client => {
        const update = await client.query('UPDATE profiles SET monetization_status=$2,updated_at=NOW() WHERE sub=$1 RETURNING handle', [sub,status]);
        if (!update.rowCount) return false;
        await writeAudit(client,req.admin,'creator_monetization','creator',sub,reason,{status,handle:update.rows[0].handle});
        return true;
      });
      if (!result) return jsonError(res,404,'Creator পাওয়া যায়নি।');
      res.json({ok:true,status});
    } catch (error) { next(error); }
  });

  app.get('/api/admin/campaigns', adminAuth('admin'), async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT c.id,c.title,c.sponsor_name,c.placement,c.creative_url,c.destination_url,c.cpm_bdt,c.status,c.starts_at,c.ends_at,c.created_at,
          COUNT(e.id) FILTER (WHERE e.event_type='impression')::bigint AS impressions,
          COUNT(e.id) FILTER (WHERE e.event_type='click')::bigint AS clicks
        FROM ad_campaigns c LEFT JOIN ad_events e ON e.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`);
      res.json({ campaigns: result.rows.map(r=>({id:r.id,title:r.title,sponsorName:r.sponsor_name,placement:r.placement,creativeUrl:r.creative_url,destinationUrl:r.destination_url,cpmBdt:Number(r.cpm_bdt),status:r.status,startsAt:r.starts_at,endsAt:r.ends_at,createdAt:r.created_at,impressions:Number(r.impressions),clicks:Number(r.clicks)})) });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/campaigns', adminAuth('admin'), async (req, res, next) => {
    try {
      const title = clean(req.body?.title,120), sponsor = clean(req.body?.sponsorName,120);
      const placement = String(req.body?.placement || ''), creativeUrl = safeUrl(req.body?.creativeUrl), destinationUrl = safeUrl(req.body?.destinationUrl);
      const cpm = Number(req.body?.cpmBdt);
      const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
      const endsAt = req.body?.endsAt ? new Date(req.body.endsAt) : null;
      if (!title || !sponsor || !['feed','watch_sidebar','channel','sticky_banner','postroll'].includes(placement) || !creativeUrl || !destinationUrl || !Number.isFinite(cpm) || cpm < 0 || cpm > 1000000) return fail(res, 'Campaign-এর title, sponsor, HTTPS creative/landing URL, placement ও valid CPM দিন।');
      if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) return fail(res, 'Campaign date range ঠিক নয়।');
      const id = crypto.randomUUID();
      await withTransaction(async client => {
        await client.query(`INSERT INTO ad_campaigns (id,title,sponsor_name,placement,creative_url,destination_url,cpm_bdt,status,starts_at,ends_at,created_by_email)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'paused',$8,$9,$10)`, [id,title,sponsor,placement,creativeUrl,destinationUrl,cpm,startsAt,endsAt,req.admin.email]);
        await writeAudit(client,req.admin,'create_campaign','ad_campaign',id,'Campaign created paused.',{title,sponsor,placement,cpmBdt:cpm});
      });
      res.status(201).json({ok:true,id,status:'paused'});
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/campaigns/:id/status', adminAuth('admin'), async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return fail(res,'Invalid campaign id.');
      const status = String(req.body?.status || '');
      if (!['draft','active','paused'].includes(status)) return fail(res,'Invalid campaign status.');
      const result = await withTransaction(async client => {
        const changed = await client.query('UPDATE ad_campaigns SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING title', [req.params.id,status]);
        if (!changed.rowCount) return false;
        await writeAudit(client,req.admin,'campaign_status','ad_campaign',req.params.id,'',{status,title:changed.rows[0].title});
        return true;
      });
      if (!result) return jsonError(res,404,'Campaign পাওয়া যায়নি।');
      res.json({ok:true,status});
    } catch (error) { next(error); }
  });

  app.get('/api/admin/settings', adminAuth(), async (req, res, next) => {
    try {
      const result = await pool.query('SELECT ads_enabled,monetization_enabled,creator_share_percent,ad_feed_enabled,ad_watch_sidebar_enabled,ad_channel_enabled,ad_sticky_enabled,ad_postroll_enabled,updated_at FROM platform_settings WHERE id=1');
      const row = result.rows[0] || {};
      res.json({adsEnabled:Boolean(row.ads_enabled),monetizationEnabled:Boolean(row.monetization_enabled),creatorSharePercent:row.creator_share_percent===null||row.creator_share_percent===undefined?null:Number(row.creator_share_percent),adToggles:{feed:Boolean(row.ad_feed_enabled),watchSidebar:Boolean(row.ad_watch_sidebar_enabled),channel:Boolean(row.ad_channel_enabled),sticky:Boolean(row.ad_sticky_enabled),postroll:Boolean(row.ad_postroll_enabled)},updatedAt:row.updated_at});
    } catch (error) { next(error); }
  });

  app.put('/api/admin/settings', adminAuth(), async (req, res, next) => {
    try {
      const adsEnabled = req.body?.adsEnabled;
      const monetizationEnabled = req.body?.monetizationEnabled;
      const shareRaw = req.body?.creatorSharePercent;
      const toggles = req.body?.adToggles || {};
      const adFeed = toggles.feed !== false, adWatchSidebar = toggles.watchSidebar !== false, adChannel = toggles.channel !== false, adSticky = toggles.sticky === true, adPostroll = toggles.postroll === true;
      const share = shareRaw === null || shareRaw === '' || shareRaw === undefined ? null : Number(shareRaw);
      if (typeof adsEnabled !== 'boolean' || typeof monetizationEnabled !== 'boolean' || (share !== null && (!Number.isFinite(share) || share < 0 || share > 100))) return fail(res,'Settings values invalid.');
      if (monetizationEnabled && (share === null || share <= 0)) return fail(res,'Monetization চালু করতে 0-এর বেশি creator share percentage সেট করুন।');
      await withTransaction(async client => {
        await client.query(`UPDATE platform_settings SET ads_enabled=$1,monetization_enabled=$2,creator_share_percent=$3,ad_feed_enabled=$4,ad_watch_sidebar_enabled=$5,ad_channel_enabled=$6,ad_sticky_enabled=$7,ad_postroll_enabled=$8,updated_by_email=$9,updated_at=NOW() WHERE id=1`, [adsEnabled,monetizationEnabled,share,adFeed,adWatchSidebar,adChannel,adSticky,adPostroll,req.admin.email]);
        await writeAudit(client,req.admin,'platform_settings','settings','1','', {adsEnabled,monetizationEnabled,creatorSharePercent:share,adToggles:{feed:adFeed,watchSidebar:adWatchSidebar,channel:adChannel,sticky:adSticky,postroll:adPostroll}});
      });
      res.json({ok:true,adsEnabled,monetizationEnabled,creatorSharePercent:share,adToggles:{feed:adFeed,watchSidebar:adWatchSidebar,channel:adChannel,sticky:adSticky,postroll:adPostroll}});
    } catch (error) { next(error); }
  });

  app.get('/api/admin/members', adminAuth(), async (req, res, next) => {
    try {
      const result = await pool.query('SELECT email,role,added_by_email,created_at FROM admin_members ORDER BY created_at ASC');
      const members = result.rows.map(r=>({email:r.email,role:r.role,addedBy:r.added_by_email,createdAt:r.created_at}));
      if (OWNER_EMAIL) members.unshift({email:OWNER_EMAIL,role:'owner',addedBy:'bootstrap',createdAt:null,protected:true});
      res.json({members});
    } catch (error) { next(error); }
  });

  app.post('/api/admin/members', adminAuth(), async (req, res, next) => {
    try {
      const email = emailOf(req.body?.email), role = String(req.body?.role || '');
      if (!validEmail(email) || !['admin','moderator'].includes(role)) return fail(res,'সঠিক email ও Admin/Moderator role দিন।');
      if (email === OWNER_EMAIL) return fail(res,'Bootstrap owner-কে পরিবর্তন করা যাবে না।');
      await withTransaction(async client => {
        await client.query(`INSERT INTO admin_members (email,role,added_by_email) VALUES ($1,$2,$3)
          ON CONFLICT (email) DO UPDATE SET role=EXCLUDED.role,added_by_email=EXCLUDED.added_by_email,updated_at=NOW()`, [email,role,req.admin.email]);
        await writeAudit(client,req.admin,'grant_admin_role','admin_member',email,'',{role});
      });
      res.status(201).json({ok:true,email,role});
    } catch (error) { next(error); }
  });

  app.delete('/api/admin/members/:email', adminAuth(), async (req, res, next) => {
    try {
      const email = emailOf(decodeURIComponent(req.params.email || ''));
      if (!validEmail(email) || email === OWNER_EMAIL) return fail(res,'এই Owner account সরানো যাবে না।');
      const result = await withTransaction(async client => {
        const deleted = await client.query('DELETE FROM admin_members WHERE email=$1 RETURNING role', [email]);
        if (!deleted.rowCount) return false;
        await writeAudit(client,req.admin,'revoke_admin_role','admin_member',email,'',{role:deleted.rows[0].role});
        return true;
      });
      if (!result) return jsonError(res,404,'Admin member পাওয়া যায়নি।');
      res.json({ok:true});
    } catch (error) { next(error); }
  });

  app.get('/api/admin/audit', adminAuth('admin'), async (req, res, next) => {
    try {
      const limit = Math.min(200,Math.max(1,Number.parseInt(req.query.limit||'50',10)||50));
      const result = await pool.query('SELECT actor_email,actor_role,action,target_type,target_id,reason,metadata,created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT $1',[limit]);
      res.json({events:result.rows.map(r=>({actorEmail:r.actor_email,actorRole:r.actor_role,action:r.action,targetType:r.target_type,targetId:r.target_id,reason:r.reason,metadata:r.metadata,createdAt:r.created_at}))});
    } catch (error) { next(error); }
  });

  app.get('/api/admin/reports', adminAuth('admin','moderator'), async (req,res,next)=>{
    try{
      const allowed=['open','reviewing','action_taken','dismissed','all'];
      const status=allowed.includes(String(req.query.status||''))?String(req.query.status):'open';
      const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'50',10)||50));
      const result=await pool.query(`SELECT r.id,r.target_type,r.target_id,r.reason_code,r.details,r.status,r.resolution,r.created_at,r.reviewed_at,
        COALESCE(v.title,p.display_name,LEFT(c.body,160),r.target_id) AS target_label,rp.handle AS reporter_handle
        FROM content_reports r LEFT JOIN videos v ON v.id=r.video_id LEFT JOIN app_users u ON u.google_sub=r.channel_sub
        LEFT JOIN profiles p ON p.sub=u.google_sub LEFT JOIN comments c ON c.id=r.comment_id
        LEFT JOIN profiles rp ON rp.sub=r.reporter_sub WHERE ($1='all' OR r.status=$1)
        ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,r.created_at DESC LIMIT $2`,[status,limit]);
      res.json({reports:result.rows.map(r=>({id:r.id,targetType:r.target_type,targetId:r.target_id,targetLabel:r.target_label,reasonCode:r.reason_code,details:r.details,status:r.status,resolution:r.resolution,reporterHandle:r.reporter_handle||null,createdAt:r.created_at,reviewedAt:r.reviewed_at}))});
    }catch(error){next(error);}
  });
  app.post('/api/admin/reports/:id/status', adminAuth('admin','moderator'), async (req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Report id সঠিক নয়।');
      const status=String(req.body?.status||'');const resolution=clean(req.body?.resolution,2000);
      if(!['reviewing','action_taken','dismissed'].includes(status))return fail(res,'Report status সঠিক নয়।');
      if(status!=='reviewing'&&resolution.length<5)return fail(res,'Final decision-এর কারণ অন্তত ৫ অক্ষরের হতে হবে।');
      const updated=await withTransaction(async client=>{
        const row=await client.query(`UPDATE content_reports SET status=$2,resolution=CASE WHEN $3='' THEN resolution ELSE $3 END,
          reviewed_by_email=$4,reviewed_at=NOW() WHERE id=$1 RETURNING target_type,target_id`,[req.params.id,status,resolution,req.admin.email]);
        if(!row.rowCount)return null;
        await writeAudit(client,req.admin,'content_report_'+status,row.rows[0].target_type,row.rows[0].target_id,resolution,{reportId:req.params.id});
        return row.rows[0];
      });
      if(!updated)return jsonError(res,404,'Report পাওয়া যায়নি।');
      res.json({ok:true,status});
    }catch(error){next(error);}
  });
  app.get('/api/admin/appeals', adminAuth('admin'), async (req,res,next)=>{
    try{
      const status=['pending','approved','rejected','all'].includes(String(req.query.status||''))?String(req.query.status):'pending';
      const result=await pool.query(`SELECT a.id,a.video_id,a.appellant_sub,a.appeal_text,a.status,a.decision_note,a.created_at,a.reviewed_at,
        v.title,p.handle,p.display_name FROM moderation_appeals a LEFT JOIN videos v ON v.id=a.video_id
        LEFT JOIN profiles p ON p.sub=a.appellant_sub WHERE ($1='all' OR a.status=$1)
        ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,a.created_at DESC LIMIT 100`,[status]);
      res.json({appeals:result.rows.map(r=>({id:r.id,videoId:r.video_id,appellantSub:r.appellant_sub,title:r.title||'Removed video',handle:r.handle||null,displayName:r.display_name||'Creator',appeal:r.appeal_text,status:r.status,decisionNote:r.decision_note,createdAt:r.created_at,reviewedAt:r.reviewed_at}))});
    }catch(error){next(error);}
  });
  app.post('/api/admin/appeals/:id/decision', adminAuth('admin'), async (req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Appeal id সঠিক নয়।');
      const decision=String(req.body?.decision||'');const note=clean(req.body?.note,1000);
      if(!['approved','rejected'].includes(decision)||note.length<5)return fail(res,'Decision ও অন্তত ৫ অক্ষরের কারণ দিন।');
      const result=await withTransaction(async client=>{
        const existing=await client.query('SELECT video_id FROM moderation_appeals WHERE id=$1 AND status=\'pending\' FOR UPDATE',[req.params.id]);
        if(!existing.rowCount)return false;
        const videoId=existing.rows[0].video_id;
        await client.query('UPDATE moderation_appeals SET status=$2,decision_note=$3,reviewed_by_email=$4,reviewed_at=NOW() WHERE id=$1',[req.params.id,decision,note,req.admin.email]);
        if(decision==='approved')await client.query("UPDATE videos SET moderation_status='active' WHERE id=$1",[videoId]);
        await writeAudit(client,req.admin,'moderation_appeal_'+decision,'video',videoId,note,{appealId:req.params.id});
        return true;
      });
      if(!result)return jsonError(res,404,'Pending appeal পাওয়া যায়নি।');
      res.json({ok:true,status:decision,videoRestored:decision==='approved'});
    }catch(error){next(error);}
  });
};
