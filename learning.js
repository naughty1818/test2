'use strict';

const crypto = require('crypto');
const {
  PutObjectCommand, DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = function registerLearningFeatures({
  app, pool, withTransaction, s3, bucket, requireAuth, requireActive,
  requireValidId, getVideo, canView, loadSession, safeText, sha, objectHead
}) {
  const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
  const REASONS = new Set(['spam','harassment','harmful','copyright','misinformation','other']);
  const fail = (res, status, error) => res.status(status).json({ error });
  const isOwner = (video, req) => Boolean(video?.owner_sub && video.owner_sub === req.auth?.session?.sub);
  const safeNumber = (value, max = 604800) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  function normalizedLanguage(value) {
    const language = safeText(String(value || '').toLowerCase(), 35);
    return LANG_RE.test(language) ? language : null;
  }
  function normalizeCourse(body = {}) {
    const classLevel = safeText(body.classLevel, 40);
    const subject = safeText(body.subject, 80);
    const sourceTags = Array.isArray(body.syllabusTags) ? body.syllabusTags : String(body.syllabusTags || '').split(',');
    const syllabusTags = [...new Set(sourceTags.map(tag => safeText(tag, 60)).filter(Boolean))].slice(0, 12);
    return { classLevel, subject, syllabusTags };
  }
  function vttTranscript(vtt) {
    return String(vtt || '')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter(line => !/^\s*(?:WEBVTT|NOTE\b|STYLE\b|REGION\b|\d+\s*$|(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->.*)$/i.test(line))
      .map(line => line.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join(' ').slice(0, 500000);
  }
  function validVtt(vtt) {
    if (typeof vtt !== 'string' || vtt.length < 6 || vtt.length > 2000000 || !/^\uFEFF?WEBVTT(?:\s|$)/.test(vtt)) return false;
    const cues = vtt.match(/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/g) || [];
    return cues.length > 0 && cues.length <= 10000 && vttTranscript(vtt).length <= 500000;
  }
  async function visibleVideo(req, res) {
    const video = await getVideo(req.params.id);
    if (!video) { fail(res, 404, 'ভিডিও পাওয়া যায়নি।'); return null; }
    req.auth = req.auth || await loadSession(req);
    if (!await canView(video, req.auth?.session?.sub)) { fail(res, 403, 'এই ভিডিও দেখার অনুমতি নেই।'); return null; }
    return video;
  }
  async function ownedVideo(req, res) {
    const video = await getVideo(req.params.id);
    if (!video) { fail(res, 404, 'ভিডিও পাওয়া যায়নি।'); return null; }
    if (!isOwner(video, req)) { fail(res, 403, 'শুধু ভিডিওর নির্মাতা এটি পরিবর্তন করতে পারবেন।'); return null; }
    return video;
  }
  function mapCaption(row) {
    return { language: row.language_code, label: row.label || row.language_code, isDefault: Boolean(row.is_default), updatedAt: row.updated_at };
  }

  // Captions live in Neon as small text assets; transcript text is separately indexed for search.
  app.get('/api/videos/:id/captions', requireValidId, async (req, res, next) => {
    try {
      const video = await visibleVideo(req, res); if (!video) return;
      const result = await pool.query('SELECT language_code,label,is_default,updated_at FROM video_captions WHERE video_id=$1 ORDER BY is_default DESC,language_code', [video.id]);
      res.set('Cache-Control', video.visibility === 'Public' ? 'public, max-age=60' : 'private, no-store');
      res.json({ captions: result.rows.map(mapCaption) });
    } catch (error) { next(error); }
  });
  app.get('/api/videos/:id/captions/:language', requireValidId, async (req, res, next) => {
    try {
      const language = normalizedLanguage(req.params.language); if (!language) return fail(res, 400, 'ভাষার কোডটি সঠিক নয়।');
      const video = await visibleVideo(req, res); if (!video) return;
      const result = await pool.query('SELECT vtt_body FROM video_captions WHERE video_id=$1 AND language_code=$2', [video.id, language]);
      if (!result.rowCount) return fail(res, 404, 'এই ভাষায় caption নেই।');
      res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': video.visibility === 'Public' ? 'public, max-age=60' : 'private, no-store' });
      res.send(result.rows[0].vtt_body);
    } catch (error) { next(error); }
  });
  app.put('/api/videos/:id/captions/:language', requireAuth, requireActive, requireValidId, async (req, res, next) => {
    try {
      const language = normalizedLanguage(req.params.language); if (!language) return fail(res, 400, 'ভাষার কোডটি সঠিক নয়।');
      const video = await ownedVideo(req, res); if (!video) return;
      const vtt = typeof req.body === 'string' ? req.body : '';
      if (!validVtt(vtt)) return fail(res, 400, 'সঠিক WEBVTT ফাইল দিন (সর্বোচ্চ ২ MB, ১০,০০০ cue)।');
      const label = safeText(String(req.query.label || req.get('x-caption-label') || language), 80) || language;
      const isDefault = String(req.query.default || req.get('x-caption-default') || '') === 'true';
      await withTransaction(async client => {
        if (isDefault) await client.query('UPDATE video_captions SET is_default=FALSE WHERE video_id=$1 AND language_code<>$2', [video.id, language]);
        await client.query(`INSERT INTO video_captions(video_id,language_code,label,vtt_body,transcript_text,is_default,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(video_id,language_code) DO UPDATE SET
          label=EXCLUDED.label,vtt_body=EXCLUDED.vtt_body,transcript_text=EXCLUDED.transcript_text,
          is_default=EXCLUDED.is_default,updated_at=NOW()`, [video.id, language, label, vtt, vttTranscript(vtt), isDefault]);
      });
      res.json({ ok: true, language, label, isDefault });
    } catch (error) { next(error); }
  });
  app.delete('/api/videos/:id/captions/:language', requireAuth, requireActive, requireValidId, async (req, res, next) => {
    try {
      const language = normalizedLanguage(req.params.language); if (!language) return fail(res, 400, 'ভাষার কোডটি সঠিক নয়।');
      const video = await ownedVideo(req, res); if (!video) return;
      const result = await pool.query('DELETE FROM video_captions WHERE video_id=$1 AND language_code=$2', [video.id, language]);
      if (!result.rowCount) return fail(res, 404, 'Caption track পাওয়া যায়নি।');
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.get('/api/videos/:id/transcript', requireValidId, async (req, res, next) => {
    try {
      const video = await visibleVideo(req, res); if (!video) return;
      const language = req.query.language ? normalizedLanguage(req.query.language) : null;
      if (req.query.language && !language) return fail(res, 400, 'ভাষার কোডটি সঠিক নয়।');
      const result = await pool.query(`SELECT transcript_text,language_code FROM video_captions WHERE video_id=$1 AND ($2::text IS NULL OR language_code=$2) ORDER BY is_default DESC,language_code LIMIT 1`, [video.id, language]);
      if (!result.rowCount) return fail(res, 404, 'এই ভিডিওর transcript যোগ করা হয়নি।');
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': video.visibility === 'Public' ? 'public, max-age=60' : 'private, no-store' });
      res.send(result.rows[0].transcript_text);
    } catch (error) { next(error); }
  });

  // Creator-owned thumbnails are optional and load independently from the R2 video stream.
  app.post('/api/videos/:id/thumbnail-upload-url', requireAuth, requireActive, requireValidId, async (req, res, next) => {
    try {
      const video = await ownedVideo(req, res); if (!video) return;
      const contentType = String(req.body?.contentType || '').toLowerCase();
      const size = Number(req.body?.size);
      if (!['image/jpeg','image/png','image/webp'].includes(contentType)) return fail(res, 400, 'Thumbnail JPG, PNG অথবা WebP হতে হবে।');
      if (!Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 * 1024) return fail(res, 413, 'Thumbnail সর্বোচ্চ ৫ MB হতে পারে।');
      const ext = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' }[contentType];
      const objectName = `thumbnails/${video.id}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
      const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: objectName, ContentType: contentType }), { expiresIn: 900 });
      res.json({ uploadUrl, objectName, expiresIn: 900 });
    } catch (error) { next(error); }
  });
  app.put('/api/videos/:id/thumbnail', requireAuth, requireActive, requireValidId, async (req, res, next) => {
    try {
      const video = await ownedVideo(req, res); if (!video) return;
      const objectName = String(req.body?.objectName || '');
      if (!new RegExp(`^thumbnails/${video.id}-[a-f0-9]{24}\\.(?:jpg|png|webp)$`).test(objectName)) return fail(res, 400, 'Thumbnail upload reference সঠিক নয়।');
      const head = await objectHead(objectName);
      if (!head || Number(head.ContentLength) > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(head.ContentType)) return fail(res, 400, 'Uploaded thumbnail যাচাই করা যায়নি।');
      const old = video.thumbnail_object_name;
      await pool.query('UPDATE videos SET thumbnail_object_name=$2 WHERE id=$1 AND owner_sub=$3', [video.id, objectName, req.auth.session.sub]);
      if (old && old !== objectName) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: old })).catch(error => console.warn('Old thumbnail cleanup deferred:', error.message));
      res.json({ ok: true, thumbnailUrl: `/api/videos/${encodeURIComponent(video.id)}/thumbnail` });
    } catch (error) { next(error); }
  });
  app.get('/api/videos/:id/thumbnail', requireValidId, async (req, res, next) => {
    try {
      const video = await visibleVideo(req, res); if (!video) return;
      if (!video.thumbnail_object_name) return fail(res, 404, 'Thumbnail নেই।');
      const url = await getSignedUrl(s3, new (require('@aws-sdk/client-s3').GetObjectCommand)({ Bucket: bucket, Key: video.thumbnail_object_name }), { expiresIn: 900 });
      res.set('Cache-Control', video.visibility === 'Public' ? 'public, max-age=300' : 'private, no-store');
      res.redirect(302, url);
    } catch (error) { next(error); }
  });

  app.get('/api/videos/:id/chapters', requireValidId, async (req, res, next) => {
    try {
      const video = await visibleVideo(req, res); if (!video) return;
      const result = await pool.query('SELECT position,start_seconds,title FROM video_chapters WHERE video_id=$1 ORDER BY position', [video.id]);
      res.json({ chapters: result.rows.map(row => ({ position: Number(row.position), startSeconds: Number(row.start_seconds), title: row.title })) });
    } catch (error) { next(error); }
  });
  app.put('/api/videos/:id/chapters', requireAuth, requireActive, requireValidId, async (req, res, next) => {
    try {
      const video = await ownedVideo(req, res); if (!video) return;
      if (!Array.isArray(req.body?.chapters) || req.body.chapters.length > 100) return fail(res, 400, 'সর্বোচ্চ ১০০টি chapter দিন।');
      const chapters = req.body.chapters.map((row, index) => ({ position:index, startSeconds:Number(row?.startSeconds), title:safeText(row?.title,120) }));
      if (chapters.some(row => !Number.isInteger(row.startSeconds) || row.startSeconds < 0 || (video.duration_seconds > 0 && row.startSeconds >= video.duration_seconds) || !row.title)) return fail(res, 400, 'Chapter title/time সঠিক নয়।');
      chapters.sort((a,b) => a.startSeconds-b.startSeconds);
      if (chapters.some((row,index) => index && row.startSeconds <= chapters[index-1].startSeconds)) return fail(res, 400, 'Chapter-এর সময়গুলো আলাদা ও ক্রমানুসারে হতে হবে।');
      await withTransaction(async client => {
        await client.query('DELETE FROM video_chapters WHERE video_id=$1', [video.id]);
        for (let i=0;i<chapters.length;i++) await client.query('INSERT INTO video_chapters(video_id,position,start_seconds,title,updated_at) VALUES($1,$2,$3,$4,NOW())', [video.id,i,chapters[i].startSeconds,chapters[i].title]);
      });
      res.json({ ok:true,chapters:chapters.map((row,index)=>({...row,position:index})) });
    } catch (error) { next(error); }
  });

  app.get('/api/me/watch-progress', requireAuth, async (req, res, next) => {
    try {
      const limit=Math.min(12,Math.max(1,Number.parseInt(req.query.limit||'8',10)||8));
      const result=await pool.query(`SELECT v.id,v.title,v.description,v.category,v.visibility,v.size,v.created_at,v.object_name,v.owner_sub,
        v.thumbnail_object_name,v.duration_seconds,v.likes_count,v.views_count,v.comments_count,p.handle AS owner_handle,
        COALESCE(NULLIF(p.display_name,''),NULLIF(u.google_name,''),'Creator') AS owner_name,p.avatar_url AS owner_avatar,
        wp.current_seconds,wp.duration_seconds AS progress_duration,wp.updated_at AS progress_updated
        FROM watch_progress wp JOIN videos v ON v.id=wp.video_id LEFT JOIN profiles p ON p.sub=v.owner_sub LEFT JOIN app_users u ON u.google_sub=v.owner_sub
        WHERE wp.user_sub=$1 AND COALESCE(v.moderation_status,'active')='active' AND COALESCE(u.account_status,'active')='active'
          AND (v.visibility='Public' OR v.owner_sub=$1) AND wp.current_seconds>5
          AND (wp.duration_seconds=0 OR wp.current_seconds<wp.duration_seconds-10)
        ORDER BY wp.updated_at DESC LIMIT $2`,[req.auth.session.sub,limit]);
      res.json({ videos:result.rows.map(row=>({id:row.id,title:row.title,description:row.description,category:row.category,created:new Date(row.created_at).toISOString(),ownerHandle:row.owner_handle||null,ownerName:row.owner_name,ownerAvatar:row.owner_avatar||null,thumbnailUrl:row.thumbnail_object_name?`/api/videos/${encodeURIComponent(row.id)}/thumbnail`:null,viewsCount:Number(row.views_count)||0,likesCount:Number(row.likes_count)||0,commentsCount:Number(row.comments_count)||0,durationSeconds:Number(row.duration_seconds)||Number(row.progress_duration)||0,currentSeconds:Number(row.current_seconds)||0,progressUpdatedAt:row.progress_updated}))});
    } catch(error){next(error);}
  });
  app.get('/api/me/watch-progress/:id', requireAuth, requireValidId, async (req,res,next)=>{
    try{
      const video=await getVideo(req.params.id);if(!video)return fail(res,404,'ভিডিও পাওয়া যায়নি।');
      if(!await canView(video,req.auth.session.sub))return fail(res,403,'এই ভিডিও দেখার অনুমতি নেই।');
      const result=await pool.query('SELECT current_seconds,duration_seconds,updated_at FROM watch_progress WHERE user_sub=$1 AND video_id=$2',[req.auth.session.sub,video.id]);
      const row=result.rows[0];res.json({progress:row?{currentSeconds:Number(row.current_seconds),durationSeconds:Number(row.duration_seconds),updatedAt:row.updated_at}:null});
    }catch(error){next(error);}
  });
  app.put('/api/videos/:id/watch-progress', requireAuth, requireActive, requireValidId, async (req,res,next)=>{
    try{
      const video=await getVideo(req.params.id);if(!video)return fail(res,404,'ভিডিও পাওয়া যায়নি।');
      if(!await canView(video,req.auth.session.sub))return fail(res,403,'এই ভিডিও দেখার অনুমতি নেই।');
      const current=safeNumber(req.body?.currentSeconds);const duration=safeNumber(req.body?.durationSeconds);
      if(current===null||duration===null||current>duration+5)return fail(res,400,'Playback position সঠিক নয়।');
      if(duration>0&&current>=duration-8){await pool.query('DELETE FROM watch_progress WHERE user_sub=$1 AND video_id=$2',[req.auth.session.sub,video.id]);return res.json({ok:true,completed:true});}
      await pool.query(`INSERT INTO watch_progress(user_sub,video_id,current_seconds,duration_seconds,updated_at) VALUES($1,$2,$3,$4,NOW())
        ON CONFLICT(user_sub,video_id) DO UPDATE SET current_seconds=EXCLUDED.current_seconds,duration_seconds=EXCLUDED.duration_seconds,updated_at=NOW()`,[req.auth.session.sub,video.id,current,duration]);
      res.json({ok:true,completed:false});
    }catch(error){next(error);}
  });

  // Best-effort anonymous audience measurement: one bounded write per video/session/day, never on the playback-critical path.
  app.post('/api/videos/:id/watch-analytics', requireValidId, async (req,res,next)=>{
    try{
      const video=await visibleVideo(req,res);if(!video)return;
      const sessionId=String(req.body?.sessionId||'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))return fail(res,400,'Playback session সঠিক নয়।');
      const position=safeNumber(req.body?.positionSeconds);const elapsed=safeNumber(req.body?.elapsedSeconds,30);
      const duration=Number(video.duration_seconds)||safeNumber(req.body?.durationSeconds)||0;
      if(position===null||elapsed===null)return fail(res,400,'Playback metrics সঠিক নয়।');
      const viewerHash=sha(`${video.id}:${sessionId}`);const day=new Date().toISOString().slice(0,10);
      const previous=await pool.query('SELECT max_position_seconds,updated_at FROM video_watch_sessions WHERE video_id=$1 AND viewer_hash=$2 AND watch_day=$3',[video.id,viewerHash,day]);
      const row=previous.rows[0];const wall=row?Math.max(0,(Date.now()-new Date(row.updated_at).getTime())/1000):elapsed;
      const plausible=duration>0&&position<=duration+2&&(!row?position<=elapsed+8:position>=Number(row.max_position_seconds)-2&&position-Number(row.max_position_seconds)<=Math.min(45,wall+8));
      const seconds=Math.min(30,elapsed,row?wall:elapsed);
      const bucket=duration>0&&plausible?Math.max(0,Math.min(19,Math.floor(position/duration*20))):null;
      const result=await pool.query(`WITH tracked AS (
        INSERT INTO video_watch_sessions(video_id,viewer_hash,watch_day,watch_seconds,max_position_seconds,duration_seconds,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT(video_id,viewer_hash,watch_day) DO UPDATE SET
          watch_seconds=video_watch_sessions.watch_seconds+LEAST($4::real,GREATEST(0,EXTRACT(EPOCH FROM NOW()-video_watch_sessions.updated_at)::real),30),
          max_position_seconds=GREATEST(video_watch_sessions.max_position_seconds,$5),duration_seconds=GREATEST(video_watch_sessions.duration_seconds,$6),updated_at=NOW()
        WHERE NOW()-video_watch_sessions.updated_at>=INTERVAL '12 seconds'
        RETURNING video_id
      ), sampled AS (
        INSERT INTO video_retention_buckets(video_id,viewer_hash,watch_day,bucket)
        SELECT $1,$2,$3,$7 FROM tracked WHERE $7::smallint IS NOT NULL
        ON CONFLICT DO NOTHING RETURNING 1
      ) SELECT EXISTS(SELECT 1 FROM tracked) AS accepted`,[video.id,viewerHash,day,seconds,position,duration,bucket]);
      res.set('Cache-Control','no-store');res.status(202).json({accepted:Boolean(result.rows[0]?.accepted)});
    }catch(error){next(error);}
  });

  app.get('/api/creator/learning-analytics', requireAuth, async (req,res,next)=>{
    try{
      const daysRaw=Number.parseInt(req.query.days||'30',10);const days=[7,30,90].includes(daysRaw)?daysRaw:30;
      const videoId=req.query.videoId?String(req.query.videoId):null;
      if(videoId){
        if(!/^[0-9a-f-]{36}$/i.test(videoId))return fail(res,400,'Video id সঠিক নয়।');
        const owned=await pool.query('SELECT id,duration_seconds FROM videos WHERE id=$1 AND owner_sub=$2',[videoId,req.auth.session.sub]);
        if(!owned.rowCount)return fail(res,404,'ভিডিও পাওয়া যায়নি।');
        const [totals,curve]=await Promise.all([
          pool.query(`SELECT COALESCE(SUM(watch_seconds),0)::bigint AS watch_seconds,COUNT(DISTINCT viewer_hash)::bigint AS sessions,COALESCE(AVG(CASE WHEN duration_seconds>0 THEN max_position_seconds/duration_seconds END),0)::numeric(8,4) AS average_completion FROM video_watch_sessions WHERE video_id=$1 AND watch_day>=CURRENT_DATE-$2::int`,[videoId,days]),
          pool.query(`SELECT b.bucket,COUNT(DISTINCT b.viewer_hash)::bigint AS viewers FROM video_retention_buckets b WHERE b.video_id=$1 AND b.watch_day>=CURRENT_DATE-$2::int GROUP BY b.bucket ORDER BY b.bucket`,[videoId,days])
        ]);
        const buckets=new Map(curve.rows.map(row=>[Number(row.bucket),Number(row.viewers)]));
        const denominator=Math.max(1,Number(totals.rows[0].sessions)||0);
        return res.json({days,videoId,durationSeconds:Number(owned.rows[0].duration_seconds)||0,watchSeconds:Number(totals.rows[0].watch_seconds)||0,sessions:Number(totals.rows[0].sessions)||0,averageCompletion:Number(totals.rows[0].average_completion)||0,retention:Array.from({length:20},(_,bucket)=>({percent:bucket*5,viewers:buckets.get(bucket)||0,rate:Math.min(100,Math.round((buckets.get(bucket)||0)/denominator*100))}))});
      }
      const result=await pool.query(`SELECT v.id,v.title,v.duration_seconds,COALESCE(SUM(w.watch_seconds),0)::bigint AS watch_seconds,COUNT(DISTINCT w.viewer_hash)::bigint AS sessions,
        COALESCE(AVG(CASE WHEN w.duration_seconds>0 THEN w.max_position_seconds/w.duration_seconds END),0)::numeric(8,4) AS average_completion
        FROM videos v LEFT JOIN video_watch_sessions w ON w.video_id=v.id AND w.watch_day>=CURRENT_DATE-$2::int
        WHERE v.owner_sub=$1 GROUP BY v.id ORDER BY watch_seconds DESC,v.created_at DESC LIMIT 100`,[req.auth.session.sub,days]);
      const total=result.rows.reduce((n,row)=>n+Number(row.watch_seconds||0),0);
      res.json({days,watchSeconds:total,videos:result.rows.map(row=>({id:row.id,title:row.title,durationSeconds:Number(row.duration_seconds)||0,watchSeconds:Number(row.watch_seconds)||0,sessions:Number(row.sessions)||0,averageCompletion:Number(row.average_completion)||0}))});
    }catch(error){next(error);}
  });

  app.post('/api/reports', requireAuth, requireActive, async (req,res,next)=>{
    try{
      const type=String(req.body?.targetType||'');const targetId=String(req.body?.targetId||'');const reasonCode=String(req.body?.reasonCode||'');const details=safeText(req.body?.details,2000);
      if(!['video','channel','comment'].includes(type)||!REASONS.has(reasonCode))return fail(res,400,'Report-এর ধরন বা কারণ বেছে নিন।');
      if(details.length<10)return fail(res,400,'কমপক্ষে ১০ অক্ষরের ব্যাখ্যা লিখুন।');
      let videoId=null,channelSub=null,commentId=null;
      if(type==='video'){
        const video=await getVideo(targetId);if(!video||!await canView(video,req.auth.session.sub))return fail(res,404,'ভিডিও পাওয়া যায়নি।');videoId=video.id;
      }else if(type==='channel'){
        const channel=await pool.query('SELECT sub FROM profiles WHERE handle=$1 OR sub=$1 LIMIT 1',[targetId]);if(!channel.rowCount)return fail(res,404,'Channel পাওয়া যায়নি।');channelSub=channel.rows[0].sub;
      }else{
        if(!/^[0-9a-f-]{36}$/i.test(targetId))return fail(res,400,'Comment id সঠিক নয়.');
        const comment=await pool.query('SELECT c.id,c.video_id FROM comments c JOIN videos v ON v.id=c.video_id WHERE c.id=$1 AND v.visibility IN (\'Public\',\'Unlisted\') AND v.moderation_status=\'active\'',[targetId]);
        if(!comment.rowCount)return fail(res,404,'Comment পাওয়া যায়নি।');commentId=comment.rows[0].id;
      }
      const id=crypto.randomUUID();
      await pool.query(`INSERT INTO content_reports(id,reporter_sub,target_type,target_id,video_id,channel_sub,comment_id,reason_code,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,req.auth.session.sub,type,targetId,videoId,channelSub,commentId,reasonCode,details]);
      res.status(201).json({ok:true,id,status:'open'});
    }catch(error){if(error.code==='23505')return fail(res,409,'এই বিষয়টি নিয়ে তোমার একটি খোলা report আছে।');next(error);}
  });
  app.get('/api/me/reports', requireAuth, async (req,res,next)=>{
    try{
      const result=await pool.query(`SELECT id,target_type,target_id,reason_code,details,status,resolution,created_at,reviewed_at
        FROM content_reports WHERE reporter_sub=$1 ORDER BY created_at DESC LIMIT 100`,[req.auth.session.sub]);
      res.json({reports:result.rows.map(row=>({id:row.id,targetType:row.target_type,targetId:row.target_id,reasonCode:row.reason_code,details:row.details,status:row.status,resolution:row.resolution,createdAt:row.created_at,reviewedAt:row.reviewed_at}))});
    }catch(error){next(error);}
  });
  app.post('/api/videos/:id/appeals', requireAuth, requireActive, requireValidId, async (req,res,next)=>{
    try{
      const video=await getVideo(req.params.id);if(!video||video.owner_sub!==req.auth.session.sub)return fail(res,404,'নিজের ভিডিও পাওয়া যায়নি।');
      if(video.moderation_status!=='removed')return fail(res,409,'এই ভিডিওর বিরুদ্ধে appeal করা যাচ্ছে না।');
      const appeal=safeText(req.body?.appeal,2000);if(appeal.length<10)return fail(res,400,'Appeal-এ অন্তত ১০ অক্ষরের ব্যাখ্যা দিন।');
      const id=crypto.randomUUID();await pool.query('INSERT INTO moderation_appeals(id,video_id,appellant_sub,appeal_text) VALUES($1,$2,$3,$4)',[id,video.id,req.auth.session.sub,appeal]);
      res.status(201).json({ok:true,id,status:'pending'});
    }catch(error){if(error.code==='23505')return fail(res,409,'এই ভিডিওর একটি appeal ইতিমধ্যে review-এর অপেক্ষায় আছে।');next(error);}
  });
  app.get('/api/me/appeals', requireAuth, async (req,res,next)=>{
    try{
      const result=await pool.query(`SELECT a.id,a.video_id,v.title,a.appeal_text,a.status,a.decision_note,a.created_at,a.reviewed_at
        FROM moderation_appeals a LEFT JOIN videos v ON v.id=a.video_id WHERE a.appellant_sub=$1 ORDER BY a.created_at DESC LIMIT 100`,[req.auth.session.sub]);
      res.json({appeals:result.rows.map(row=>({id:row.id,videoId:row.video_id,title:row.title||'Removed video',appeal:row.appeal_text,status:row.status,decisionNote:row.decision_note,createdAt:row.created_at,reviewedAt:row.reviewed_at}))});
    }catch(error){next(error);}
  });
};
