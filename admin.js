'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('./db');
const {
  DEFAULT_AD_LAYOUTS,
  normalizeAdLayouts,
  normalizeMonthlyImpressionCap,
  normalizeFeedAdEveryRows
} = require('./ad-layouts');

module.exports = function registerConsole({ app, requireAuth, requireActive, loadSession, notifyUser, getVideo, signedVideoUrl }) {
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
  const adSettingsPayload = row => {
    let adLayoutSettings = DEFAULT_AD_LAYOUTS;
    try { adLayoutSettings = normalizeAdLayouts(row?.ad_layout_settings); } catch (_) {}
    return {
      adLayoutSettings,
      feedAdEveryRows: Number(row?.feed_ad_every_rows) || 4,
      lBannerDurationSeconds: Number(row?.l_banner_duration_seconds) || 10,
      lBannerSkippable: row?.l_banner_skippable !== false
    };
  };

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


  const makeHandle=(value)=>{let h=String(value||'').toLowerCase().replace(/@.*/,'').replace(/[^a-z0-9._-]/g,'').replace(/^[._-]+|[._-]+$/g,'').slice(0,22);if(h.length<3)h=(h+'creator').slice(0,22);return h;};
  app.get('/api/admin/channel-applications',adminAuth('admin'),async(req,res,next)=>{
    try{
      const status=['pending','approved','rejected','all'].includes(String(req.query.status||''))?String(req.query.status):'pending';
      const result=await pool.query(`SELECT a.id,a.user_sub,a.channel_name,a.channel_type,a.creator_type,a.other_platform_name,a.other_platform_url,a.status,a.decision_note,a.created_at,a.reviewed_at,u.email,u.google_name,u.google_picture FROM channel_applications a JOIN app_users u ON u.google_sub=a.user_sub WHERE ($1='all' OR a.status=$1) ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,a.created_at ASC LIMIT 100`,[status]);
      res.json({applications:result.rows.map(a=>({id:a.id,userSub:a.user_sub,channelName:a.channel_name,channelType:a.channel_type,creatorType:a.creator_type||'normal',otherPlatformName:a.other_platform_name,otherPlatformUrl:a.other_platform_url,status:a.status,decisionNote:a.decision_note,createdAt:a.created_at,reviewedAt:a.reviewed_at,email:a.email,name:a.google_name,picture:a.google_picture}))});
    }catch(error){next(error);}
  });
  app.post('/api/admin/channel-applications/:id/decision',adminAuth('admin'),async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Invalid application id.');
      const decision=String(req.body?.decision||''),note=clean(req.body?.note,2000);
      if(!['approved','rejected'].includes(decision))return fail(res,'Choose approve or reject.');
      if(note.length<5)return fail(res,'Add a decision note of at least 5 characters.');
      const result=await withTransaction(async client=>{
        const locked=await client.query('SELECT * FROM channel_applications WHERE id=$1 FOR UPDATE',[req.params.id]);
        if(!locked.rowCount)return null;
        const a=locked.rows[0];if(a.status!=='pending')throw Object.assign(new Error('This application has already been decided.'),{status:409});
        let handle=null;
        if(decision==='approved'){
          const user=await client.query('SELECT email,google_name,google_picture FROM app_users WHERE google_sub=$1 FOR UPDATE',[a.user_sub]);
          if(!user.rowCount)throw Object.assign(new Error('Applicant account was not found.'),{status:404});
          const base=makeHandle(user.rows[0].email||a.channel_name);
          for(let i=0;i<12;i++){
            const candidate=i===0?base:`${base.slice(0,18)}-${crypto.randomBytes(2).toString('hex')}`;
            const inserted=await client.query(`INSERT INTO profiles(sub,handle,display_name,bio,avatar_url,channel_type,creator_type) VALUES($1,$2,$3,'',$4,$5,$6) ON CONFLICT(handle) DO NOTHING RETURNING handle`,[a.user_sub,candidate,a.channel_name,user.rows[0].google_picture||null,a.channel_type,a.creator_type||'normal']);
            if(inserted.rowCount){handle=inserted.rows[0].handle;break;}
          }
          if(!handle)throw new Error('Could not allocate a unique channel handle.');
        }
        await client.query('UPDATE channel_applications SET status=$2,decision_note=$3,reviewed_by_email=$4,reviewed_at=NOW() WHERE id=$1',[a.id,decision,note,req.admin.email]);
        await writeAudit(client,req.admin,'channel_application_'+decision,'channel_application',a.id,note,{channelName:a.channel_name,userSub:a.user_sub,handle});
        return {userSub:a.user_sub,channelName:a.channel_name,handle};
      });
      if(!result)return jsonError(res,404,'Application not found.');
      if(notifyUser)await notifyUser(result.userSub,null,'channel_application_'+decision,decision==='approved'?'Channel approved':'Channel application update',decision==='approved'?`Your channel “${result.channelName}” is approved. You can now upload videos.`:`Your channel application was not approved. Note: ${note}`,'/');
      res.json({ok:true,decision,handle:result.handle||null});
    }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
  });
  app.get('/api/admin/verification-requests',adminAuth('admin'),async(req,res,next)=>{
    try{
      const status=['pending','approved','rejected','all'].includes(String(req.query.status||''))?String(req.query.status):'pending';
      const result=await pool.query(`SELECT r.id,r.user_sub,r.reason,r.proof_url,r.status,r.decision_note,r.created_at,r.reviewed_at,p.handle,p.display_name,p.avatar_url,u.email FROM channel_verification_requests r JOIN profiles p ON p.sub=r.user_sub JOIN app_users u ON u.google_sub=r.user_sub WHERE ($1='all' OR r.status=$1) ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at ASC LIMIT 100`,[status]);
      res.json({requests:result.rows.map(r=>({id:r.id,userSub:r.user_sub,reason:r.reason,proofUrl:r.proof_url,status:r.status,decisionNote:r.decision_note,createdAt:r.created_at,reviewedAt:r.reviewed_at,handle:r.handle,displayName:r.display_name,avatarUrl:r.avatar_url,email:r.email}))});
    }catch(error){next(error);}
  });
  app.post('/api/admin/verification-requests/:id/decision',adminAuth('admin'),async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Invalid verification request id.');
      const decision=String(req.body?.decision||''),note=clean(req.body?.note,2000);
      if(!['approved','rejected'].includes(decision))return fail(res,'Choose approve or reject.');
      if(note.length<5)return fail(res,'Add a decision note of at least 5 characters.');
      const result=await withTransaction(async client=>{
        const locked=await client.query('SELECT * FROM channel_verification_requests WHERE id=$1 FOR UPDATE',[req.params.id]);
        if(!locked.rowCount)return null;
        const r=locked.rows[0];if(r.status!=='pending')throw Object.assign(new Error('This verification request has already been decided.'),{status:409});
        if(decision==='approved'){
          const changed=await client.query('UPDATE profiles SET is_verified=TRUE,updated_at=NOW() WHERE sub=$1 RETURNING handle',[r.user_sub]);
          if(!changed.rowCount)throw Object.assign(new Error('The creator channel is no longer available.'),{status:409});
        }
        await client.query('UPDATE channel_verification_requests SET status=$2,decision_note=$3,reviewed_by_email=$4,reviewed_at=NOW() WHERE id=$1',[r.id,decision,note,req.admin.email]);
        await writeAudit(client,req.admin,'verification_'+decision,'verification_request',r.id,note,{userSub:r.user_sub});
        return {userSub:r.user_sub};
      });
      if(!result)return jsonError(res,404,'Verification request not found.');
      if(notifyUser)await notifyUser(result.userSub,null,'verification_'+decision,decision==='approved'?'Channel verified':'Verification request update',decision==='approved'?`Your channel is now verified. Note: ${note}`:`Your verification request was not approved. Note: ${note}`,'/studio?tab=verification');
      res.json({ok:true,decision});
    }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
  });

  app.get('/api/admin/islamic-review',adminAuth('admin','moderator'),async(req,res,next)=>{
    try{
      const status=['pending','approved','rejected','all'].includes(String(req.query.status||''))?String(req.query.status):'pending';
      const result=await pool.query(`SELECT v.id,v.title,v.description,v.islamic_certification_status,v.islamic_review_note,v.created_at,v.islamic_reviewed_at,p.handle,p.display_name,u.email
        FROM videos v LEFT JOIN profiles p ON p.sub=v.owner_sub LEFT JOIN app_users u ON u.google_sub=v.owner_sub
        WHERE v.is_islamic=TRUE AND ($1='all' OR v.islamic_certification_status=$1)
        ORDER BY CASE v.islamic_certification_status WHEN 'pending' THEN 0 ELSE 1 END,v.created_at ASC LIMIT 200`,[status]);
      res.json({videos:result.rows.map(v=>({id:v.id,title:v.title,description:v.description,status:v.islamic_certification_status,reviewNote:v.islamic_review_note,createdAt:v.created_at,reviewedAt:v.islamic_reviewed_at,handle:v.handle,creatorName:v.display_name,email:v.email}))});
    }catch(error){next(error);}
  });
  app.get('/api/admin/islamic-review/:id/preview',adminAuth('admin','moderator'),async(req,res,next)=>{
    try{
      if(!validVideoId(req.params.id))return jsonError(res,400,'Invalid video id.');
      const video=await getVideo(req.params.id);
      if(!video||!video.is_islamic)return jsonError(res,404,'Islamic video not found.');
      res.set('Cache-Control','private, no-store');
      res.json({url:await signedVideoUrl(video.object_name)});
    }catch(error){next(error);}
  });
  app.post('/api/admin/islamic-review/:id/decision',adminAuth('admin','moderator'),async(req,res,next)=>{
    try{
      if(!validVideoId(req.params.id))return fail(res,'Invalid video id.');
      const decision=String(req.body?.decision||''),note=clean(req.body?.note,2000);
      if(!['approved','rejected'].includes(decision))return fail(res,'Choose approve or reject.');
      if(note.length<5)return fail(res,'Add a review note of at least 5 characters.');
      const result=await withTransaction(async client=>{
        const locked=await client.query('SELECT id,owner_sub,title,is_islamic,islamic_certification_status FROM videos WHERE id=$1 FOR UPDATE',[req.params.id]);
        if(!locked.rowCount)return null;
        const video=locked.rows[0];
        if(!video.is_islamic)throw Object.assign(new Error('This video is no longer marked Islamic.'),{status:409});
        if(video.islamic_certification_status!=='pending')throw Object.assign(new Error('This video is not awaiting certification review.'),{status:409});
        await client.query('UPDATE videos SET islamic_certification_status=$2,islamic_reviewed_by_email=$3,islamic_review_note=$4,islamic_reviewed_at=NOW() WHERE id=$1',[video.id,decision,req.admin.email,note]);
        await writeAudit(client,req.admin,'islamic_certification_'+decision,'video',video.id,note,{videoTitle:video.title,ownerSub:video.owner_sub});
        return {ownerSub:video.owner_sub,title:video.title};
      });
      if(!result)return jsonError(res,404,'Video not found.');
      if(result.ownerSub&&notifyUser)await notifyUser(result.ownerSub,null,'islamic_certification_'+decision,'Islamic video review update',decision==='approved'?`“${result.title}” has been approved for Islamic mode.`:`“${result.title}” was not approved for Islamic mode. Note: ${note}`,'/studio?tab=content');
      res.json({ok:true,decision});
    }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
  });

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

  app.get('/api/sponsor/settings', async (req, res, next) => {
    try {
      const result = await pool.query('SELECT ad_layout_settings,feed_ad_every_rows,l_banner_duration_seconds,l_banner_skippable FROM platform_settings WHERE id=1');
      res.set('Cache-Control', 'no-store');
      res.json(adSettingsPayload(result.rows[0] || {}));
    } catch (error) { next(error); }
  });

  // Public ad serving is disabled until the verified owner enables it and activates campaigns.
  app.get('/api/sponsor/serve', async (req, res, next) => {
    try {
      const placement = String(req.query.placement || '');
      const channelHandle = req.query.handle ? String(req.query.handle).replace(/^@/,'').trim() : null;
      if (!['feed','watch_sidebar','channel','sticky_banner','postroll','l_banner'].includes(placement)) return fail(res, 'Invalid ad placement.');
      if (placement === 'channel' && !channelHandle) return fail(res, 'Channel handle is required.');
      const settings = await pool.query('SELECT ads_enabled,ad_feed_enabled,ad_watch_sidebar_enabled,ad_channel_enabled,ad_sticky_enabled,ad_postroll_enabled,ad_l_banner_enabled,l_banner_duration_seconds,l_banner_skippable,feed_ad_every_rows,ad_layout_settings FROM platform_settings WHERE id=1');
      const settingKey = {feed:'ad_feed_enabled',watch_sidebar:'ad_watch_sidebar_enabled',channel:'ad_channel_enabled',sticky_banner:'ad_sticky_enabled',postroll:'ad_postroll_enabled',l_banner:'ad_l_banner_enabled'}[placement];
      const settingsRow = settings.rows[0] || {};
      const publicSettings = adSettingsPayload(settingsRow);
      const responseSettings = { ...publicSettings, placement };
      if (!settingsRow.ads_enabled || !settingsRow[settingKey]) return res.json({ ad: null, settings: responseSettings });
      // Caps count UTC-month impression events; ad_monthly_serves only smooths rotation.
      const row = await withTransaction(async client => {
        const candidates = await client.query(`SELECT c.id,c.title,c.sponsor_name,c.placement,c.creative_url,c.destination_url,
            c.l_bottom_creative_url,c.l_bottom_destination_url,c.monthly_impression_cap,
            COALESCE(ms.served_count,0)::int AS monthly_served,
            COALESCE(mi.impression_count,0)::int AS monthly_impressions
          FROM ad_campaigns c
          LEFT JOIN ad_monthly_serves ms ON ms.campaign_id=c.id AND ms.month_start=DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC')::date
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS impression_count FROM ad_events e
            WHERE e.campaign_id=c.id AND e.event_type='impression'
              AND e.created_at >= (DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          ) mi ON TRUE
          WHERE c.placement=$1 AND c.status='active'
            AND (c.starts_at IS NULL OR c.starts_at<=NOW()) AND (c.ends_at IS NULL OR c.ends_at>NOW())
            AND (c.monthly_impression_cap IS NULL OR COALESCE(mi.impression_count,0)<c.monthly_impression_cap)
          ORDER BY COALESCE(ms.served_count,0) ASC,
            (SELECT COUNT(*) FROM ad_events e WHERE e.campaign_id=c.id AND e.event_type='impression') ASC,
            c.created_at ASC
          LIMIT 1 FOR UPDATE OF c SKIP LOCKED`, [placement]);
        const candidate=candidates.rows[0];
        if(!candidate)return null;
        const reserved=await client.query(`INSERT INTO ad_monthly_serves(campaign_id,month_start,served_count)
          VALUES($1,DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC')::date,1)
          ON CONFLICT(campaign_id,month_start) DO UPDATE
            SET served_count=ad_monthly_serves.served_count+1
          RETURNING served_count`, [candidate.id]);
        return { ...candidate, monthly_served_after:Number(reserved.rows[0].served_count) };
      });
      res.set('Cache-Control', 'no-store');
      res.json({ ad: row ? {
        id: row.id,
        title: row.title,
        sponsorName: row.sponsor_name,
        placement: row.placement,
        creativeUrl: row.creative_url,
        destinationUrl: row.destination_url,
        bottomCreativeUrl: row.l_bottom_creative_url || '',
        bottomDestinationUrl: row.l_bottom_destination_url || row.destination_url,
        monthlyImpressionCap: row.monthly_impression_cap === null ? null : Number(row.monthly_impression_cap),
        monthlyServed: row.monthly_served_after,
        monthlyImpressions: row.monthly_impressions,
        layoutSettings: publicSettings.adLayoutSettings[placement],
        durationSeconds: publicSettings.lBannerDurationSeconds,
        skippable: publicSettings.lBannerSkippable
      } : null, settings: responseSettings });
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
      if ((placement === 'watch_sidebar' && !videoId) || (['feed','sticky_banner','postroll','l_banner'].includes(placement) && (videoId || channelHandle)) || (placement === 'channel' && (!channelHandle || videoId))) return fail(res, 'Ad placement and context do not match.');
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
      const impressionId = typeof req.body?.impressionId === 'string' && validUuid(req.body.impressionId) ? req.body.impressionId : '';
      const dedupe = eventType === 'impression' && impressionId
        ? sha(`${visitor}|${campaignId}|impression|${impressionId}`)
        : sha(`${visitor}|${campaignId}|${eventType}|${videoId || 'feed'}|${dayKey}`);
      const recorded = await withTransaction(async client => {
        const locked = await client.query(`SELECT monthly_impression_cap FROM ad_campaigns WHERE id=$1 AND status='active'
          AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>NOW()) FOR UPDATE`, [campaignId]);
        if (!locked.rowCount) return { unavailable: true, counted: false };
        const existing = await client.query('SELECT id FROM ad_events WHERE campaign_id=$1 AND event_type=$2 AND dedupe_key=$3', [campaignId,eventType,dedupe]);
        if (existing.rowCount) return { counted: false, duplicate: true };
        if (eventType === 'impression' && locked.rows[0].monthly_impression_cap !== null) {
          const monthly = await client.query(`SELECT COUNT(*)::int AS impressions FROM ad_events
            WHERE campaign_id=$1 AND event_type='impression'
              AND created_at >= (DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, [campaignId]);
          if (Number(monthly.rows[0]?.impressions || 0) >= Number(locked.rows[0].monthly_impression_cap)) {
            return { counted: false, monthlyCapReached: true };
          }
        }
        const inserted = await client.query(`INSERT INTO ad_events (campaign_id,video_id,creator_sub,event_type,dedupe_key,estimated_creator_earnings_bdt)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (campaign_id,event_type,dedupe_key) DO NOTHING RETURNING id`,
          [campaignId, videoId, creatorSub, eventType, dedupe, estimate]);
        return { counted: inserted.rowCount > 0 };
      });
      if (recorded.unavailable) return jsonError(res,404,'Ad campaign unavailable.');
      res.json({ ok: true, ...recorded });
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
      const [totals, subscriberTotal, subscriberGrowth, daily, videos, adStats, profile, strikes, watchTime] = await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS videos_count,COALESCE(SUM(views_count),0)::bigint AS views_count,
            COALESCE(SUM(likes_count),0)::bigint AS likes_count,COALESCE(SUM(comments_count),0)::bigint AS comments_count
          FROM videos WHERE owner_sub=$1`, [sub]),
        pool.query('SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE channel_sub=$1', [sub]),
        pool.query('SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE channel_sub=$1 AND created_at>=NOW()-($2::int*INTERVAL \'1 day\')', [sub, days]),
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
        pool.query(`SELECT p.monetization_status,p.monetization_applied_at,s.ads_enabled,s.monetization_enabled,s.creator_share_percent,s.monetization_min_subscribers,s.monetization_min_watch_hours
          FROM profiles p CROSS JOIN platform_settings s WHERE p.sub=$1 AND s.id=1`, [sub]),
        pool.query("SELECT COUNT(*)::bigint AS n FROM copyright_strikes WHERE channel_sub=$1 AND status IN ('active','appealed')", [sub]),
        pool.query(`SELECT COALESCE(SUM(vws.watch_seconds),0)::numeric AS watch_seconds
          FROM video_watch_sessions vws JOIN videos v ON v.id=vws.video_id WHERE v.owner_sub=$1`, [sub])
      ]);
      const total = totals.rows[0] || {};
      const monet = profile.rows[0] || {};
      const ads = adStats.rows[0] || {};
      res.json({ days, totals: { videos: Number(total.videos_count)||0, views: Number(total.views_count)||0, likes: Number(total.likes_count)||0, comments: Number(total.comments_count)||0, subscribers: Number(subscriberTotal.rows[0]?.n)||0, subscribersGained: Number(subscriberGrowth.rows[0]?.n)||0 },
        viewsByDay: daily.rows.map(row => ({ day: row.day, views: Number(row.views)||0 })),
        videos: videos.rows.map(row => ({ id: row.id, title: row.title, visibility: row.visibility, moderationStatus: row.moderation_status, createdAt: row.created_at, views: Number(row.views_count)||0, likes: Number(row.likes_count)||0, comments: Number(row.comments_count)||0, adImpressions: Number(row.ad_impressions)||0, adClicks: Number(row.ad_clicks)||0, estimatedEarningsBdt: Number(row.estimated_earnings_bdt)||0 })),
        ads: { impressions: Number(ads.impressions)||0, clicks: Number(ads.clicks)||0, estimatedEarningsBdt: Number(ads.estimated_earnings_bdt)||0 },
        monetizationStatus: monet.monetization_status || 'pending', monetizationEnabled: Boolean(monet.monetization_enabled), adsEnabled: Boolean(monet.ads_enabled), creatorSharePercent: monet.creator_share_percent === null || monet.creator_share_percent === undefined ? null : Number(monet.creator_share_percent), activeStrikes: Number(strikes.rows[0]?.n)||0,
        monetizationMilestones: { requiredSubscribers: Number(monet.monetization_min_subscribers)||1000, currentSubscribers: Number(subscriberTotal.rows[0]?.n)||0, requiredWatchHours: Number(monet.monetization_min_watch_hours)||4000, currentWatchHours: Number(watchTime.rows[0]?.watch_seconds||0)/3600 }, monetizationAppliedAt: monet.monetization_applied_at || null });
    } catch (error) { next(error); }
  });

  app.post('/api/creator/monetization/apply', requireAuth, async (req, res, next) => {
    try {
      const result = await withTransaction(async client => {
        const check = await client.query(`SELECT p.monetization_status,p.monetization_applied_at,s.monetization_enabled,
            s.monetization_min_subscribers,s.monetization_min_watch_hours,
            (SELECT COUNT(*) FROM subscriptions WHERE channel_sub=$1) AS subscribers,
            (SELECT COALESCE(SUM(vws.watch_seconds),0) FROM video_watch_sessions vws JOIN videos v ON v.id=vws.video_id WHERE v.owner_sub=$1) AS watch_seconds
          FROM profiles p CROSS JOIN platform_settings s WHERE p.sub=$1 AND s.id=1 FOR UPDATE`, [req.auth.session.sub]);
        if (!check.rowCount) throw Object.assign(new Error('Creator channel not found.'), { status: 404 });
        const row = check.rows[0];
        if (!row.monetization_enabled) throw Object.assign(new Error('Platform monetization is not enabled yet.'), { status: 409 });
        if (row.monetization_status === 'enabled') throw Object.assign(new Error('Monetization is already approved.'), { status: 409 });
        const subscribers = Number(row.subscribers) || 0;
        const watchHours = (Number(row.watch_seconds) || 0) / 3600;
        if (subscribers < Number(row.monetization_min_subscribers) || watchHours < Number(row.monetization_min_watch_hours)) {
          throw Object.assign(new Error('দুইটি monetization milestone পূরণ করার পর apply করতে হবে।'), { status: 409 });
        }
        const updated = await client.query(`UPDATE profiles SET monetization_status='pending',monetization_applied_at=NOW(),updated_at=NOW()
          WHERE sub=$1 RETURNING monetization_status,monetization_applied_at`, [req.auth.session.sub]);
        await writeAudit(client,{email:req.auth.session.email,role:'creator'},'creator_monetization_apply','creator',req.auth.session.sub,'Creator applied after completing monetization milestones',{subscribers,watchHours});
        return { subscribers, watchHours, appliedAt: updated.rows[0].monetization_applied_at };
      });
      res.status(201).json({ ok: true, status: 'pending', ...result });
    } catch (error) { if (error.status) return jsonError(res,error.status,error.message); next(error); }
  });

  app.get('/api/creator/strikes', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT s.id,s.video_id,v.title AS video_title,s.reason,s.evidence_url,s.status,s.appeal_text,s.resolution_note,s.created_at,s.appealed_at,s.resolved_at,s.resolved_by_email
        FROM copyright_strikes s LEFT JOIN videos v ON v.id=s.video_id WHERE s.channel_sub=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.auth.session.sub]);
      res.json({ strikes: result.rows.map(row => ({ id: row.id, videoId: row.video_id, videoTitle: row.video_title || 'ভিডিও আর উপলভ্য নয়', reason: row.reason, evidenceUrl: row.evidence_url, status: row.status, appealText: row.appeal_text, resolutionNote: row.resolution_note, createdAt: row.created_at, appealedAt: row.appealed_at, resolvedAt: row.resolved_at, resolvedByEmail: row.resolved_by_email })) });
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
      const [users,videos,channels,strikes,campaigns,adStats,settings,reports,appeals,strikeAppeals,suspended] = await Promise.all([
        pool.query('SELECT COUNT(*)::bigint AS n FROM app_users'),
        pool.query("SELECT COUNT(*)::bigint AS n FROM videos WHERE moderation_status='active'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM app_users WHERE account_status='active'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM copyright_strikes WHERE status IN ('active','appealed')"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM ad_campaigns WHERE status='active' AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>NOW())"),
        pool.query(`SELECT COUNT(*) FILTER (WHERE event_type='impression')::bigint AS impressions,COUNT(*) FILTER (WHERE event_type='click')::bigint AS clicks,
          COALESCE(SUM(estimated_creator_earnings_bdt),0)::numeric(14,4) AS creator_estimate FROM ad_events WHERE created_at>=NOW()-INTERVAL '30 days'`),
        pool.query('SELECT ads_enabled,monetization_enabled,creator_share_percent FROM platform_settings WHERE id=1'),
        pool.query("SELECT COUNT(*)::bigint AS n FROM content_reports WHERE status IN ('open','reviewing')"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM moderation_appeals WHERE status='pending'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM copyright_strikes WHERE status='appealed'"),
        pool.query("SELECT COUNT(*)::bigint AS n FROM app_users WHERE account_status IN ('suspended','banned')")
      ]);
      const s = settings.rows[0] || {}; const ads = adStats.rows[0] || {};
      res.json({ counts: { users: Number(users.rows[0].n), videos: Number(videos.rows[0].n), activeAccounts: Number(channels.rows[0].n), openStrikes: Number(strikes.rows[0].n), activeCampaigns: Number(campaigns.rows[0].n), pendingReports:Number(reports.rows[0].n), pendingVideoAppeals:Number(appeals.rows[0].n), pendingStrikeAppeals:Number(strikeAppeals.rows[0].n), suspendedAccounts:Number(suspended.rows[0].n) }, ads: { impressions: Number(ads.impressions), clicks: Number(ads.clicks), estimatedCreatorEarningsBdt: Number(ads.creator_estimate) }, settings: { adsEnabled: s.ads_enabled, monetizationEnabled: s.monetization_enabled, creatorSharePercent: s.creator_share_percent === null ? null : Number(s.creator_share_percent) } });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/review-queue', adminAuth('admin','moderator'), async (req,res,next)=>{
    try{
      const type=['all','report','video_appeal','strike_appeal'].includes(String(req.query.type||''))?String(req.query.type):'all';
      const reviewStatus=['all','open','reviewing','pending','appealed'].includes(String(req.query.status||''))?String(req.query.status):'all';
      const q=clean(req.query.q,120), pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
      const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1), limit=Math.min(50,Math.max(5,Number.parseInt(req.query.limit||'20',10)||20)), offset=(page-1)*limit;
      const sql=`SELECT * FROM (
        SELECT 'report'::text AS item_type,r.id::text AS id,r.target_type AS target_type,r.target_id AS target_id,
          COALESCE(v.title,p.display_name,LEFT(c.body,160),r.target_id) AS target_label,r.reason_code AS reason,
          r.details AS details,r.status AS status,r.created_at AS created_at,rp.handle AS actor_handle,
          CASE WHEN r.target_type='video' THEN '/watch/'||r.target_id WHEN r.target_type='channel' THEN '/channel/'||COALESCE(p.handle,r.target_id) ELSE NULL END AS href
        FROM content_reports r LEFT JOIN videos v ON v.id=r.video_id LEFT JOIN app_users u ON u.google_sub=r.channel_sub
        LEFT JOIN profiles p ON p.sub=u.google_sub LEFT JOIN comments c ON c.id=r.comment_id LEFT JOIN profiles rp ON rp.sub=r.reporter_sub
        WHERE r.status IN ('open','reviewing') AND ($1 IN ('all','report')) AND ($4='all' OR r.status=$4) AND (COALESCE(v.title,p.display_name,LEFT(c.body,160),r.target_id) ILIKE $2 OR r.reason_code ILIKE $2 OR r.details ILIKE $2 OR COALESCE(rp.handle,'') ILIKE $2)
        UNION ALL
        SELECT 'video_appeal',a.id::text,'video',a.video_id,COALESCE(v.title,'Removed video'),'video_appeal',a.appeal_text,a.status,a.created_at,p.handle,'/watch/'||a.video_id
        FROM moderation_appeals a LEFT JOIN videos v ON v.id=a.video_id LEFT JOIN profiles p ON p.sub=a.appellant_sub
        WHERE $3 AND a.status='pending' AND ($1 IN ('all','video_appeal')) AND ($4='all' OR a.status=$4) AND (COALESCE(v.title,'') ILIKE $2 OR a.appeal_text ILIKE $2 OR COALESCE(p.handle,'') ILIKE $2)
        UNION ALL
        SELECT 'strike_appeal',s.id::text,'video',s.video_id,COALESCE(v.title,'Removed video'),'copyright_strike_appeal',
          'Appeal: '||COALESCE(s.appeal_text,'')||E'\nOriginal reason: '||s.reason,s.status,s.appealed_at,p.handle,'/watch/'||s.video_id
        FROM copyright_strikes s LEFT JOIN videos v ON v.id=s.video_id LEFT JOIN profiles p ON p.sub=s.channel_sub
        WHERE $3 AND s.status='appealed' AND ($1 IN ('all','strike_appeal')) AND ($4='all' OR s.status=$4) AND (COALESCE(v.title,'') ILIKE $2 OR COALESCE(s.appeal_text,'') ILIKE $2 OR s.reason ILIKE $2 OR COALESCE(p.handle,'') ILIKE $2)
      ) q ORDER BY created_at ASC LIMIT $5 OFFSET $6`;
      const countSql=`SELECT COUNT(*)::bigint AS total FROM (
        SELECT r.id FROM content_reports r LEFT JOIN videos v ON v.id=r.video_id LEFT JOIN app_users u ON u.google_sub=r.channel_sub LEFT JOIN profiles p ON p.sub=u.google_sub LEFT JOIN comments c ON c.id=r.comment_id LEFT JOIN profiles rp ON rp.sub=r.reporter_sub WHERE r.status IN ('open','reviewing') AND ($1 IN ('all','report')) AND ($4='all' OR r.status=$4) AND (COALESCE(v.title,p.display_name,LEFT(c.body,160),r.target_id) ILIKE $2 OR r.reason_code ILIKE $2 OR r.details ILIKE $2 OR COALESCE(rp.handle,'') ILIKE $2)
        UNION ALL SELECT a.id FROM moderation_appeals a LEFT JOIN videos v ON v.id=a.video_id LEFT JOIN profiles p ON p.sub=a.appellant_sub WHERE $3 AND a.status='pending' AND ($1 IN ('all','video_appeal')) AND ($4='all' OR a.status=$4) AND (COALESCE(v.title,'') ILIKE $2 OR a.appeal_text ILIKE $2 OR COALESCE(p.handle,'') ILIKE $2)
        UNION ALL SELECT s.id FROM copyright_strikes s LEFT JOIN videos v ON v.id=s.video_id LEFT JOIN profiles p ON p.sub=s.channel_sub WHERE $3 AND s.status='appealed' AND ($1 IN ('all','strike_appeal')) AND ($4='all' OR s.status=$4) AND (COALESCE(v.title,'') ILIKE $2 OR COALESCE(s.appeal_text,'') ILIKE $2 OR s.reason ILIKE $2 OR COALESCE(p.handle,'') ILIKE $2)
      ) q`;
      const canReviewAppeals=['owner','admin'].includes(req.admin.role);
      const [items,total]=await Promise.all([pool.query(sql,[type,pattern,canReviewAppeals,reviewStatus,limit,offset]),pool.query(countSql,[type,pattern,canReviewAppeals,reviewStatus])]);
      res.json({items:items.rows.map(r=>({type:r.item_type,id:r.id,targetType:r.target_type,targetId:r.target_id,targetLabel:r.target_label,reason:r.reason,details:r.details,status:r.status,createdAt:r.created_at,actorHandle:r.actor_handle||null,href:r.href})),page,limit,total:Number(total.rows[0]?.total||0),pages:Math.ceil(Number(total.rows[0]?.total||0)/limit)});
    }catch(error){next(error);}
  });

  app.get('/api/admin/content', adminAuth('admin','moderator'), async (req, res, next) => {
    try {
      const q = clean(req.query.q, 100);
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1),limit=Math.min(100,Math.max(10,Number.parseInt(req.query.limit||'50',10)||50)),offset=(page-1)*limit;
      const status=['all','active','removed','suspended','banned'].includes(String(req.query.status||''))?String(req.query.status):'all';
      const [videos,channels,strikes,videoCount,channelCount,strikeCount] = await Promise.all([
        pool.query(`SELECT v.id,v.title,v.visibility,v.moderation_status,v.owner_sub,v.created_at,p.handle,p.display_name
          FROM videos v LEFT JOIN profiles p ON p.sub=v.owner_sub
          WHERE ($1='' OR v.title ILIKE $2 OR p.handle ILIKE $2 OR p.display_name ILIKE $2) AND ($3='all' OR v.moderation_status=$3)
          ORDER BY v.created_at DESC LIMIT $4 OFFSET $5`, [q,pattern,status,limit,offset]),
        pool.query(`SELECT u.google_sub,u.email,u.account_status,u.created_at,p.handle,p.display_name,p.monetization_status,
            (SELECT COUNT(*) FROM videos v WHERE v.owner_sub=u.google_sub) AS videos_count
          FROM app_users u LEFT JOIN profiles p ON p.sub=u.google_sub
          WHERE ($1='' OR ($3::boolean AND u.email ILIKE $2) OR p.handle ILIKE $2 OR p.display_name ILIKE $2)
            AND ($4='all' OR u.account_status=$4) ORDER BY u.created_at DESC LIMIT $5 OFFSET $6`, [q,pattern,req.admin.role!=='moderator',status,limit,offset]),
        pool.query(`SELECT s.id,s.video_id,s.channel_sub,s.reason,s.status,s.created_at,p.handle,p.display_name,v.title
          FROM copyright_strikes s LEFT JOIN profiles p ON p.sub=s.channel_sub LEFT JOIN videos v ON v.id=s.video_id
          WHERE ($1='' OR v.title ILIKE $2 OR p.handle ILIKE $2 OR s.reason ILIKE $2) ORDER BY s.created_at DESC LIMIT $3 OFFSET $4`, [q,pattern,limit,offset]),
        pool.query(`SELECT COUNT(*)::bigint AS n FROM videos v LEFT JOIN profiles p ON p.sub=v.owner_sub WHERE ($1='' OR v.title ILIKE $2 OR p.handle ILIKE $2 OR p.display_name ILIKE $2) AND ($3='all' OR v.moderation_status=$3)`,[q,pattern,status]),
        pool.query(`SELECT COUNT(*)::bigint AS n FROM app_users u LEFT JOIN profiles p ON p.sub=u.google_sub WHERE ($1='' OR ($3::boolean AND u.email ILIKE $2) OR p.handle ILIKE $2 OR p.display_name ILIKE $2) AND ($4='all' OR u.account_status=$4)`,[q,pattern,req.admin.role!=='moderator',status]),
        pool.query(`SELECT COUNT(*)::bigint AS n FROM copyright_strikes s LEFT JOIN profiles p ON p.sub=s.channel_sub LEFT JOIN videos v ON v.id=s.video_id WHERE ($1='' OR v.title ILIKE $2 OR p.handle ILIKE $2 OR s.reason ILIKE $2)`,[q,pattern])
      ]);
      res.json({ page,limit,totals:{videos:Number(videoCount.rows[0].n),channels:Number(channelCount.rows[0].n),strikes:Number(strikeCount.rows[0].n)}, videos: videos.rows.map(r=>({id:r.id,title:r.title,visibility:r.visibility,moderationStatus:r.moderation_status,ownerSub:r.owner_sub,createdAt:r.created_at,handle:r.handle,ownerName:r.display_name})),
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
        const update = await client.query("UPDATE profiles SET monetization_status=$2,monetization_applied_at=CASE WHEN $2='rejected' THEN NULL ELSE monetization_applied_at END,updated_at=NOW() WHERE sub=$1 RETURNING handle", [sub,status]);
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
      const q=clean(req.query.q,120),pattern='%'+q.replace(/[\\%_]/g,'\\$&'), status=['all','draft','active','paused'].includes(String(req.query.status||''))?String(req.query.status):'all';
      const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1),limit=Math.min(50,Math.max(10,Number.parseInt(req.query.limit||'20',10)||20)),offset=(page-1)*limit;
      const result = await pool.query(`SELECT c.id,c.title,c.sponsor_name,c.placement,c.creative_url,c.destination_url,
          c.l_bottom_creative_url,c.l_bottom_destination_url,c.monthly_impression_cap,
          COALESCE(ms.served_count,0)::bigint AS monthly_served,COALESCE(mi.impression_count,0)::bigint AS monthly_impressions,
          c.cpm_bdt,c.status,c.starts_at,c.ends_at,c.created_at,
          COUNT(e.id) FILTER (WHERE e.event_type='impression')::bigint AS impressions,
          COUNT(e.id) FILTER (WHERE e.event_type='click')::bigint AS clicks
        FROM ad_campaigns c
        LEFT JOIN ad_events e ON e.campaign_id=c.id
        LEFT JOIN ad_monthly_serves ms ON ms.campaign_id=c.id AND ms.month_start=DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC')::date
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS impression_count FROM ad_events e_month
          WHERE e_month.campaign_id=c.id AND e_month.event_type='impression'
            AND e_month.created_at >= (DATE_TRUNC('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        ) mi ON TRUE
        WHERE ($1='all' OR c.status=$1) AND (c.title ILIKE $2 OR c.sponsor_name ILIKE $2)
        GROUP BY c.id,ms.served_count,mi.impression_count ORDER BY c.created_at DESC LIMIT $3 OFFSET $4`,[status,pattern,limit,offset]);
      const total=await pool.query(`SELECT COUNT(*)::bigint AS n FROM ad_campaigns c WHERE ($1='all' OR c.status=$1) AND (c.title ILIKE $2 OR c.sponsor_name ILIKE $2)`,[status,pattern]);
      res.json({page,limit,total:Number(total.rows[0].n),pages:Math.ceil(Number(total.rows[0].n)/limit),campaigns: result.rows.map(r=>({id:r.id,title:r.title,sponsorName:r.sponsor_name,placement:r.placement,creativeUrl:r.creative_url,destinationUrl:r.destination_url,bottomCreativeUrl:r.l_bottom_creative_url,bottomDestinationUrl:r.l_bottom_destination_url,monthlyImpressionCap:r.monthly_impression_cap===null?null:Number(r.monthly_impression_cap),monthlyServed:Number(r.monthly_served||0),monthlyImpressions:Number(r.monthly_impressions||0),cpmBdt:Number(r.cpm_bdt),status:r.status,startsAt:r.starts_at,endsAt:r.ends_at,createdAt:r.created_at,impressions:Number(r.impressions),clicks:Number(r.clicks)})) });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/campaigns', adminAuth('admin'), async (req, res, next) => {
    try {
      const title = clean(req.body?.title,120), sponsor = clean(req.body?.sponsorName,120);
      const placement = String(req.body?.placement || ''), creativeUrl = safeUrl(req.body?.creativeUrl), destinationUrl = safeUrl(req.body?.destinationUrl);
      const bottomCreativeUrl = placement === 'l_banner' ? safeUrl(req.body?.bottomCreativeUrl) : null;
      const bottomDestinationUrl = placement === 'l_banner' ? safeUrl(req.body?.bottomDestinationUrl) : null;
      let monthlyImpressionCap;
      try { monthlyImpressionCap = normalizeMonthlyImpressionCap(req.body?.monthlyImpressionCap); }
      catch (error) { return fail(res,error.message); }
      const cpm = Number(req.body?.cpmBdt);
      const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
      const endsAt = req.body?.endsAt ? new Date(req.body.endsAt) : null;
      if (!title || !sponsor || !['feed','watch_sidebar','channel','sticky_banner','postroll','l_banner'].includes(placement) || !creativeUrl || !destinationUrl || (placement === 'l_banner' && (!bottomCreativeUrl || !bottomDestinationUrl)) || !Number.isFinite(cpm) || cpm < 0 || cpm > 1000000) return fail(res, 'Campaign-এর title, sponsor, HTTPS creative/landing URL, placement ও valid CPM দিন। L-shape-এর জন্য নিচের image ও landing URL-ও দিন।');
      if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) return fail(res, 'Campaign date range ঠিক নয়।');
      const id = crypto.randomUUID();
      await withTransaction(async client => {
        await client.query(`INSERT INTO ad_campaigns (id,title,sponsor_name,placement,creative_url,destination_url,l_bottom_creative_url,l_bottom_destination_url,monthly_impression_cap,cpm_bdt,status,starts_at,ends_at,created_by_email)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paused',$11,$12,$13)`, [id,title,sponsor,placement,creativeUrl,destinationUrl,bottomCreativeUrl,bottomDestinationUrl,monthlyImpressionCap,cpm,startsAt,endsAt,req.admin.email]);
        await writeAudit(client,req.admin,'create_campaign','ad_campaign',id,'Campaign created paused.',{title,sponsor,placement,cpmBdt:cpm,monthlyImpressionCap});
      });
      res.status(201).json({ok:true,id,status:'paused'});
    } catch (error) { next(error); }
  });

  app.put('/api/admin/campaigns/:id', adminAuth('admin'), async (req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Invalid campaign id.');
      const title=clean(req.body?.title,120),sponsor=clean(req.body?.sponsorName,120),placement=String(req.body?.placement||''),creativeUrl=safeUrl(req.body?.creativeUrl),destinationUrl=safeUrl(req.body?.destinationUrl),bottomCreativeUrl=placement==='l_banner'?safeUrl(req.body?.bottomCreativeUrl):null,bottomDestinationUrl=placement==='l_banner'?safeUrl(req.body?.bottomDestinationUrl):null,cpm=Number(req.body?.cpmBdt),startsAt=req.body?.startsAt?new Date(req.body.startsAt):null,endsAt=req.body?.endsAt?new Date(req.body.endsAt):null;
      const monthlyCapProvided = Object.prototype.hasOwnProperty.call(req.body || {},'monthlyImpressionCap');
      let monthlyImpressionCap = null;
      try { if(monthlyCapProvided)monthlyImpressionCap=normalizeMonthlyImpressionCap(req.body.monthlyImpressionCap); }
      catch(error) { return fail(res,error.message); }
      if(!title||!sponsor||!['feed','watch_sidebar','channel','sticky_banner','postroll','l_banner'].includes(placement)||!creativeUrl||!destinationUrl||(placement==='l_banner'&&(!bottomCreativeUrl||!bottomDestinationUrl))||!Number.isFinite(cpm)||cpm<0||cpm>1000000)return fail(res,'Campaign fields এবং HTTPS URLs সঠিকভাবে দিন। L-shape-এর নিচের image ও landing URL-ও দিন।');
      if((startsAt&&Number.isNaN(startsAt.getTime()))||(endsAt&&Number.isNaN(endsAt.getTime()))||(startsAt&&endsAt&&endsAt<=startsAt))return fail(res,'Campaign date range ঠিক নয়।');
      const result=await withTransaction(async client=>{
        const changed=await client.query(`UPDATE ad_campaigns SET title=$2,sponsor_name=$3,placement=$4,creative_url=$5,destination_url=$6,l_bottom_creative_url=$7,l_bottom_destination_url=$8,monthly_impression_cap=CASE WHEN $9 THEN $10 ELSE monthly_impression_cap END,cpm_bdt=$11,starts_at=$12,ends_at=$13,updated_at=NOW() WHERE id=$1 RETURNING id`,[req.params.id,title,sponsor,placement,creativeUrl,destinationUrl,bottomCreativeUrl,bottomDestinationUrl,monthlyCapProvided,monthlyImpressionCap,cpm,startsAt,endsAt]);
        if(!changed.rowCount)return false;
        await writeAudit(client,req.admin,'edit_campaign','ad_campaign',req.params.id,'Campaign details updated.',{title,sponsor,placement,cpmBdt:cpm,monthlyImpressionCap:monthlyCapProvided?monthlyImpressionCap:undefined});
        return true;
      });
      if(!result)return jsonError(res,404,'Campaign পাওয়া যায়নি।');
      res.json({ok:true});
    }catch(error){next(error);}
  });

  app.get('/api/admin/ad-analytics', adminAuth('admin'), async (req,res,next)=>{
    try{
      const days=[7,30,90].includes(Number(req.query.days))?Number(req.query.days):30;
      const [daily,placements,totals]=await Promise.all([
        pool.query(`SELECT TO_CHAR(DATE_TRUNC('day',created_at),'YYYY-MM-DD') AS day,COUNT(*) FILTER(WHERE event_type='impression')::bigint AS impressions,COUNT(*) FILTER(WHERE event_type='click')::bigint AS clicks,COALESCE(SUM(estimated_creator_earnings_bdt),0)::numeric(14,4) AS estimate FROM ad_events WHERE created_at>=NOW()-($1::int*INTERVAL '1 day') GROUP BY DATE_TRUNC('day',created_at) ORDER BY DATE_TRUNC('day',created_at)`,[days]),
        pool.query(`SELECT c.placement,COUNT(e.id) FILTER(WHERE e.event_type='impression')::bigint AS impressions,COUNT(e.id) FILTER(WHERE e.event_type='click')::bigint AS clicks FROM ad_campaigns c LEFT JOIN ad_events e ON e.campaign_id=c.id AND e.created_at>=NOW()-($1::int*INTERVAL '1 day') GROUP BY c.placement ORDER BY c.placement`,[days]),
        pool.query(`SELECT COUNT(*) FILTER(WHERE event_type='impression')::bigint AS impressions,COUNT(*) FILTER(WHERE event_type='click')::bigint AS clicks,COALESCE(SUM(estimated_creator_earnings_bdt),0)::numeric(14,4) AS estimate FROM ad_events WHERE created_at>=NOW()-($1::int*INTERVAL '1 day')`,[days])
      ]);
      const t=totals.rows[0]||{};
      res.json({days,totals:{impressions:Number(t.impressions||0),clicks:Number(t.clicks||0),estimatedCreatorEarningsBdt:Number(t.estimate||0)},daily:daily.rows.map(r=>({day:r.day,impressions:Number(r.impressions),clicks:Number(r.clicks),estimatedCreatorEarningsBdt:Number(r.estimate)})),placements:placements.rows.map(r=>({placement:r.placement,impressions:Number(r.impressions),clicks:Number(r.clicks),ctr:Number(r.impressions)?Number(r.clicks)/Number(r.impressions)*100:0}))});
    }catch(error){next(error);}
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
      const result = await pool.query('SELECT ads_enabled,monetization_enabled,creator_share_percent,monetization_min_subscribers,monetization_min_watch_hours,ad_feed_enabled,ad_watch_sidebar_enabled,ad_channel_enabled,ad_sticky_enabled,ad_postroll_enabled,ad_l_banner_enabled,l_banner_duration_seconds,l_banner_skippable,feed_ad_every_rows,ad_layout_settings,updated_at FROM platform_settings WHERE id=1');
      const row = result.rows[0] || {};
      res.json({adsEnabled:Boolean(row.ads_enabled),monetizationEnabled:Boolean(row.monetization_enabled),creatorSharePercent:row.creator_share_percent===null||row.creator_share_percent===undefined?null:Number(row.creator_share_percent),monetizationMilestones:{requiredSubscribers:Number(row.monetization_min_subscribers)||1000,requiredWatchHours:Number(row.monetization_min_watch_hours)||4000},adToggles:{feed:Boolean(row.ad_feed_enabled),watchSidebar:Boolean(row.ad_watch_sidebar_enabled),channel:Boolean(row.ad_channel_enabled),sticky:Boolean(row.ad_sticky_enabled),postroll:Boolean(row.ad_postroll_enabled),lBanner:Boolean(row.ad_l_banner_enabled)},...adSettingsPayload(row),updatedAt:row.updated_at});
    } catch (error) { next(error); }
  });

  app.put('/api/admin/settings', adminAuth(), async (req, res, next) => {
    try {
      const adsEnabled = req.body?.adsEnabled;
      const monetizationEnabled = req.body?.monetizationEnabled;
      const shareRaw = req.body?.creatorSharePercent;
      const milestones = req.body?.monetizationMilestones || {};
      const requiredSubscribers = Number(milestones.requiredSubscribers);
      const requiredWatchHours = Number(milestones.requiredWatchHours);
      const toggles = req.body?.adToggles || {};
      const durationRaw = req.body?.lBannerDurationSeconds;
      const lBannerDurationSeconds = durationRaw === undefined || durationRaw === '' ? 10 : Number(durationRaw);
      const layoutsProvided = Object.prototype.hasOwnProperty.call(req.body || {},'adLayoutSettings');
      const feedRowsProvided = Object.prototype.hasOwnProperty.call(req.body || {},'feedAdEveryRows');
      const skipProvided = Object.prototype.hasOwnProperty.call(req.body || {},'lBannerSkippable');
      let adLayoutSettings = null, feedAdEveryRows = null, lBannerSkippable = null;
      try {
        if (layoutsProvided) adLayoutSettings = normalizeAdLayouts(req.body.adLayoutSettings);
        if (feedRowsProvided) feedAdEveryRows = normalizeFeedAdEveryRows(req.body.feedAdEveryRows);
      } catch (error) { return fail(res,error.message); }
      if (skipProvided) {
        if (typeof req.body.lBannerSkippable !== 'boolean') return fail(res,'L-shape skip setting must be on or off.');
        lBannerSkippable = req.body.lBannerSkippable;
      }
      const adFeed = toggles.feed !== false, adWatchSidebar = toggles.watchSidebar !== false, adChannel = toggles.channel !== false, adSticky = toggles.sticky === true, adPostroll = toggles.postroll === true, adLBanner = toggles.lBanner === true;
      const share = shareRaw === null || shareRaw === '' || shareRaw === undefined ? null : Number(shareRaw);
      if (typeof adsEnabled !== 'boolean' || typeof monetizationEnabled !== 'boolean' || !Number.isInteger(lBannerDurationSeconds) || lBannerDurationSeconds < 3 || lBannerDurationSeconds > 60 || !Number.isSafeInteger(requiredSubscribers) || requiredSubscribers < 1 || requiredSubscribers > 1000000000 || !Number.isFinite(requiredWatchHours) || requiredWatchHours <= 0 || requiredWatchHours > 1000000000 || (share !== null && (!Number.isFinite(share) || share < 0 || share > 100))) return fail(res,'Settings values invalid.');
      if (monetizationEnabled && (share === null || share <= 0)) return fail(res,'Monetization চালু করতে 0-এর বেশি creator share percentage সেট করুন।');
      await withTransaction(async client => {
        await client.query(`UPDATE platform_settings SET ads_enabled=$1,monetization_enabled=$2,creator_share_percent=$3,monetization_min_subscribers=$4,monetization_min_watch_hours=$5,ad_feed_enabled=$6,ad_watch_sidebar_enabled=$7,ad_channel_enabled=$8,ad_sticky_enabled=$9,ad_postroll_enabled=$10,ad_l_banner_enabled=$11,l_banner_duration_seconds=$12,l_banner_skippable=COALESCE($13,l_banner_skippable),feed_ad_every_rows=COALESCE($14,feed_ad_every_rows),ad_layout_settings=COALESCE($15::jsonb,ad_layout_settings),updated_by_email=$16,updated_at=NOW() WHERE id=1`, [adsEnabled,monetizationEnabled,share,requiredSubscribers,requiredWatchHours,adFeed,adWatchSidebar,adChannel,adSticky,adPostroll,adLBanner,lBannerDurationSeconds,lBannerSkippable,feedAdEveryRows,adLayoutSettings===null?null:JSON.stringify(adLayoutSettings),req.admin.email]);
        await writeAudit(client,req.admin,'platform_settings','settings','1','', {adsEnabled,monetizationEnabled,creatorSharePercent:share,requiredSubscribers,requiredWatchHours,adToggles:{feed:adFeed,watchSidebar:adWatchSidebar,channel:adChannel,sticky:adSticky,postroll:adPostroll,lBanner:adLBanner},lBannerDurationSeconds,lBannerSkippable,feedAdEveryRows,adLayoutSettings});
      });
      const saved=await pool.query('SELECT l_banner_skippable,feed_ad_every_rows,ad_layout_settings,l_banner_duration_seconds FROM platform_settings WHERE id=1');
      res.json({ok:true,adsEnabled,monetizationEnabled,creatorSharePercent:share,monetizationMilestones:{requiredSubscribers,requiredWatchHours},adToggles:{feed:adFeed,watchSidebar:adWatchSidebar,channel:adChannel,sticky:adSticky,postroll:adPostroll,lBanner:adLBanner},...adSettingsPayload(saved.rows[0]||{})});
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
      const limit=Math.min(100,Math.max(10,Number.parseInt(req.query.limit||'50',10)||50)),page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1),offset=(page-1)*limit,q=clean(req.query.q,120),pattern='%'+q.replace(/[\\%_]/g,'\\$&'),action=clean(req.query.action,80),from=String(req.query.from||''),to=String(req.query.to||'');
      const dateOk=x=>!x||/^\d{4}-\d{2}-\d{2}$/.test(x);
      if(!dateOk(from)||!dateOk(to))return fail(res,'Date filter format must be YYYY-MM-DD.');
      const where=`($1='' OR action ILIKE $2 OR actor_email ILIKE $2 OR target_id ILIKE $2 OR reason ILIKE $2) AND ($3='' OR action=$3) AND ($4='' OR created_at >= $4::date) AND ($5='' OR created_at < ($5::date+INTERVAL '1 day'))`;
      const [result,count]=await Promise.all([pool.query(`SELECT actor_email,actor_role,action,target_type,target_id,reason,metadata,created_at FROM admin_audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT $6 OFFSET $7`,[q,pattern,action,from,to,limit,offset]),pool.query(`SELECT COUNT(*)::bigint AS n FROM admin_audit_logs WHERE ${where}`,[q,pattern,action,from,to])]);
      const total=Number(count.rows[0].n);
      res.json({page,limit,total,pages:Math.ceil(total/limit),events:result.rows.map(r=>({actorEmail:r.actor_email,actorRole:r.actor_role,action:r.action,targetType:r.target_type,targetId:r.target_id,reason:r.reason,metadata:r.metadata,createdAt:r.created_at}))});
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
      const status=String(req.body?.status||''),resolution=clean(req.body?.resolution,2000),action=String(req.body?.action||'none'),evidenceUrl=req.body?.evidenceUrl?safeUrl(req.body.evidenceUrl):null;
      if(!['reviewing','action_taken','dismissed'].includes(status))return fail(res,'Report status সঠিক নয়.');
      if(status!=='reviewing'&&resolution.length<5)return fail(res,'Final decision-এর কারণ অন্তত ৫ অক্ষরের হতে হবে।');
      if(status==='action_taken'&&!['remove_video','restore_video','copyright_strike','suspend_channel','ban_channel','unban_channel'].includes(action))return fail(res,'Action taken চূড়ান্ত করতে একটি moderation action বেছে নিন।');
      if(req.body?.evidenceUrl&&!evidenceUrl)return fail(res,'Evidence link অবশ্যই HTTPS URL হতে হবে।');
      const updated=await withTransaction(async client=>{
        const locked=await client.query('SELECT id,target_type,target_id,video_id,channel_sub,status FROM content_reports WHERE id=$1 FOR UPDATE',[req.params.id]);
        if(!locked.rowCount)return null;
        const report=locked.rows[0];
        if(['action_taken','dismissed'].includes(report.status))throw Object.assign(new Error('এই report ইতিমধ্যে final করা হয়েছে।'),{status:409});
        if(status==='action_taken'){
          if(['remove_video','restore_video','copyright_strike'].includes(action)){
            if(report.target_type!=='video'||!report.video_id)throw Object.assign(new Error('এই report target-এর জন্য video action প্রযোজ্য নয়।'),{status:400});
            const video=await client.query('SELECT id,owner_sub,title FROM videos WHERE id=$1 FOR UPDATE',[report.video_id]);
            if(!video.rowCount)throw Object.assign(new Error('ভিডিওটি আর উপলভ্য নেই।'),{status:404});
            if(action==='remove_video')await client.query("UPDATE videos SET moderation_status='removed' WHERE id=$1",[report.video_id]);
            if(action==='restore_video')await client.query("UPDATE videos SET moderation_status='active' WHERE id=$1",[report.video_id]);
            if(action==='copyright_strike'){
              if(!video.rows[0].owner_sub)throw Object.assign(new Error('ভিডিওর channel owner পাওয়া যায়নি।'),{status:409});
              await client.query("UPDATE videos SET moderation_status='removed' WHERE id=$1",[report.video_id]);
              await client.query(`INSERT INTO copyright_strikes (id,video_id,channel_sub,reason,evidence_url,issued_by_email) VALUES ($1,$2,$3,$4,$5,$6)`,[crypto.randomUUID(),report.video_id,video.rows[0].owner_sub,resolution,evidenceUrl,req.admin.email]);
            }
            await writeAudit(client,req.admin,'report_moderation_'+action,'video',report.video_id,resolution,{reportId:req.params.id,title:video.rows[0].title,evidenceUrl});
          }else{
            if(report.target_type!=='channel'||!report.channel_sub)throw Object.assign(new Error('এই report target-এর জন্য channel action প্রযোজ্য নয়।'),{status:400});
            const accountStatus=action==='unban_channel'?'active':action==='ban_channel'?'banned':'suspended';
            await client.query('UPDATE app_users SET account_status=$2,updated_at=NOW() WHERE google_sub=$1',[report.channel_sub,accountStatus]);
            await writeAudit(client,req.admin,'report_moderation_'+action,'channel',report.channel_sub,resolution,{reportId:req.params.id,status:accountStatus});
          }
        }
        await client.query(`UPDATE content_reports SET status=$2,resolution=$3,reviewed_by_email=$4,reviewed_at=NOW() WHERE id=$1`,[req.params.id,status,resolution,req.admin.email]);
        await writeAudit(client,req.admin,'content_report_'+status,report.target_type,report.target_id,resolution,{reportId:req.params.id,moderationAction:status==='action_taken'?action:null});
        return report;
      });
      if(!updated)return jsonError(res,404,'Report পাওয়া যায়নি।');
      res.json({ok:true,status,action:status==='action_taken'?action:null});
    }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
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
  app.post('/api/admin/strikes/:id/decision', adminAuth('admin'), async (req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return fail(res,'Strike id সঠিক নয়।');
      const decision=String(req.body?.decision||''),note=clean(req.body?.note,1000),restoreVideo=req.body?.restoreVideo===true;
      if(!['upheld','dismissed'].includes(decision)||note.length<5)return fail(res,'Decision ও অন্তত ৫ অক্ষরের কারণ দিন।');
      const result=await withTransaction(async client=>{
        const row=await client.query("SELECT id,video_id FROM copyright_strikes WHERE id=$1 AND status='appealed' FOR UPDATE",[req.params.id]);
        if(!row.rowCount)return false;
        const strike=row.rows[0];
        const newStatus=decision==='dismissed'?'dismissed':'resolved';
        await client.query('UPDATE copyright_strikes SET status=$2,resolved_by_email=$3,resolved_at=NOW(),resolution_note=$4 WHERE id=$1',[strike.id,newStatus,req.admin.email,note]);
        if(decision==='dismissed'&&restoreVideo&&strike.video_id){
          const other=await client.query("SELECT COUNT(*)::int AS n FROM copyright_strikes WHERE video_id=$1 AND id<>$2 AND status IN ('active','appealed')",[strike.video_id,strike.id]);
          if(Number(other.rows[0]?.n||0)>0)throw Object.assign(new Error('এই ভিডিওতে অন্য open strike আছে; আগে সেটিও review করুন।'),{status:409});
          await client.query("UPDATE videos SET moderation_status='active' WHERE id=$1",[strike.video_id]);
        }
        await writeAudit(client,req.admin,'copyright_strike_appeal_'+decision,'strike',strike.id,note,{videoId:strike.video_id,videoRestored:decision==='dismissed'&&restoreVideo});
        return true;
      });
      if(!result)return jsonError(res,404,'Review করার মতো appealed strike পাওয়া যায়নি।');
      res.json({ok:true,status:decision==='dismissed'?'dismissed':'resolved',videoRestored:decision==='dismissed'&&restoreVideo});
    }catch(error){if(error.status)return jsonError(res,error.status,error.message);next(error);}
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
