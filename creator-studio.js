'use strict';

const crypto = require('crypto');

module.exports = function attachCreatorStudio({ app, pool, requireAuth, requireActive, requireChannel, requireValidId, validUuid, safeText, normalizeCategory, normalizeVisibility }) {
  const { resolveIslamicFlag } = require('./content-policy');
  app.get('/api/creator/content', requireAuth, requireChannel, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const [videos, uploads] = await Promise.all([
        pool.query(`SELECT v.id,v.title,v.description,v.category,v.visibility,v.is_premium,v.price_bdt,v.moderation_status,v.scheduled_at,v.comments_enabled,v.created_at,v.views_count,v.likes_count,v.comments_count,v.class_level,v.subject,v.syllabus_tags,v.duration_seconds,v.thumbnail_object_name,v.is_islamic,v.islamic_certification_status,
          (SELECT COUNT(*)::bigint FROM video_captions c WHERE c.video_id=v.id) AS captions_count
          FROM videos v WHERE v.owner_sub=$1 ORDER BY v.created_at DESC LIMIT 200`, [sub]),
        pool.query(`SELECT id,title,category,visibility,expected_size,created_at,expires_at FROM upload_intents WHERE owner_sub=$1 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 20`, [sub])
      ]);
      res.set('Cache-Control', 'private, no-store');
      res.json({ videos: videos.rows.map(v => ({ id:v.id,title:v.title,description:v.description,category:v.category,visibility:v.visibility,isPremium:Boolean(v.is_premium),priceBdt:Number(v.price_bdt)||0,status:v.moderation_status,scheduledAt:v.scheduled_at,commentsEnabled:v.comments_enabled!==false,createdAt:v.created_at,views:Number(v.views_count)||0,likes:Number(v.likes_count)||0,comments:Number(v.comments_count)||0,classLevel:v.class_level||'',subject:v.subject||'',syllabusTags:v.syllabus_tags||[],durationSeconds:Number(v.duration_seconds)||0,isIslamic:Boolean(v.is_islamic),islamicCertificationStatus:v.islamic_certification_status||'not_applicable',hasThumbnail:Boolean(v.thumbnail_object_name),captions:Number(v.captions_count)||0 })), uploads: uploads.rows.map(u=>({id:u.id,title:u.title,category:u.category,visibility:u.visibility,size:Number(u.expected_size)||0,createdAt:u.created_at,expiresAt:u.expires_at})) });
    } catch (error) { next(error); }
  });

  app.patch('/api/creator/videos/:id', requireAuth, requireActive, requireChannel, requireValidId, async (req,res,next) => {
    try {
      const id=req.params.id, sub=req.auth.session.sub;
      const title=safeText(req.body?.title,100), description=safeText(req.body?.description,5000);
      const category=normalizeCategory(req.body?.category), visibility=normalizeVisibility(req.body?.visibility);
      const classLevel=safeText(req.body?.classLevel,40), subject=safeText(req.body?.subject,80);
      const syllabusTags=Array.isArray(req.body?.syllabusTags)?[...new Set(req.body.syllabusTags.map(x=>safeText(x,60)).filter(Boolean))].slice(0,12):String(req.body?.syllabusTags||'').split(',').map(x=>safeText(x,60)).filter(Boolean).slice(0,12);
      if(category==='শেখা'&&(!classLevel||!subject||!syllabusTags.length))return res.status(400).json({error:'শিক্ষা বিভাগের ভিডিওর জন্য Class / level, Subject এবং অন্তত একটি Syllabus tag আবশ্যক।'});
      const commentsEnabled=req.body?.commentsEnabled===undefined?null:Boolean(req.body.commentsEnabled);
      const current=await pool.query('SELECT is_islamic FROM videos WHERE id=$1 AND owner_sub=$2',[id,sub]);
      if(!current.rowCount)return res.status(404).json({error:'নিজের ভিডিওটি পাওয়া যায়নি।'});
      const isIslamic=resolveIslamicFlag(req.auth.profile?.creator_type||'normal',req.body?.isIslamic===undefined?Boolean(current.rows[0].is_islamic):req.body.isIslamic);
      if(isIslamic===null)return res.status(400).json({error:'Mixed creator channel-এর জন্য ভিডিওটি Islamic কি না বেছে নিন।'});
      const scheduledAt=req.body?.scheduledAt===undefined?undefined:(req.body?.scheduledAt===null||req.body?.scheduledAt===''?null:new Date(req.body.scheduledAt));
      if(scheduledAt!==undefined&&scheduledAt!==null&&!Number.isFinite(scheduledAt.getTime()))return res.status(400).json({error:'প্রকাশের তারিখ সঠিক নয়।'});
      if(!title||!category||!visibility)return res.status(400).json({error:'শিরোনাম, বিভাগ ও visibility ঠিক করে দিন।'});
      const result=await pool.query(`UPDATE videos SET title=$3,description=$4,category=$5,visibility=$6,class_level=$7,subject=$8,syllabus_tags=$9,comments_enabled=COALESCE($10,comments_enabled),scheduled_at=CASE WHEN $11::boolean THEN $12::timestamptz ELSE scheduled_at END,is_islamic=$13,islamic_certification_status=CASE WHEN $13 THEN 'pending' ELSE 'not_applicable' END,islamic_reviewed_by_email=NULL,islamic_review_note='',islamic_reviewed_at=NULL WHERE id=$1 AND owner_sub=$2 RETURNING id,title,description,category,visibility,class_level,subject,syllabus_tags,comments_enabled,scheduled_at,is_islamic,islamic_certification_status`,[id,sub,title,description,category,visibility,classLevel,subject,syllabusTags,commentsEnabled,scheduledAt!==undefined,scheduledAt||null,isIslamic]);
      if(!result.rowCount)return res.status(404).json({error:'নিজের ভিডিওটি পাওয়া যায়নি।'});
      res.json({video:result.rows[0]});
    } catch(error){next(error);}
  });

  app.get('/api/creator/comments', requireAuth, requireChannel, async (req,res,next) => {
    try {
      const term=safeText(req.query.q,100), sub=req.auth.session.sub;
      const result=await pool.query(`SELECT c.id,c.video_id,c.parent_id,c.body,c.created_at,c.creator_pinned,c.creator_hidden,v.title AS video_title,
        p.handle,p.display_name,COALESCE(NULLIF(p.display_name,''),NULLIF(u.google_name,''),'Atharo দর্শক') AS author_name
        FROM comments c JOIN videos v ON v.id=c.video_id JOIN app_users u ON u.google_sub=c.author_sub LEFT JOIN profiles p ON p.sub=c.author_sub
        WHERE v.owner_sub=$1 AND ($2='' OR c.body ILIKE '%'||$2||'%' OR v.title ILIKE '%'||$2||'%')
        ORDER BY c.creator_pinned DESC,c.created_at DESC LIMIT 200`,[sub,term]);
      res.json({comments:result.rows.map(c=>({id:c.id,videoId:c.video_id,parentId:c.parent_id,body:c.body,createdAt:c.created_at,videoTitle:c.video_title,authorName:c.author_name,handle:c.handle,pinned:Boolean(c.creator_pinned),hidden:Boolean(c.creator_hidden)}))});
    }catch(error){next(error);}
  });

  app.patch('/api/creator/comments/:id', requireAuth, requireActive, async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return res.status(400).json({error:'Comment id সঠিক নয়।'});
      const {action}=req.body||{}; if(!['pin','unpin','hide','show'].includes(action))return res.status(400).json({error:'Comment action সঠিক নয়।'});
      const field=action==='pin'||action==='unpin'?'creator_pinned':'creator_hidden', value=action==='pin'||action==='hide';
      const result=await pool.query(`UPDATE comments c SET ${field}=$3 FROM videos v WHERE c.id=$1 AND c.video_id=v.id AND v.owner_sub=$2 AND ($4::boolean=FALSE OR c.parent_id IS NULL) RETURNING c.id,c.creator_pinned,c.creator_hidden`,[req.params.id,req.auth.session.sub,value,field==='creator_pinned']);
      if(!result.rowCount)return res.status(404).json({error:'Comment পাওয়া যায়নি।'});
      res.json({comment:{id:result.rows[0].id,pinned:Boolean(result.rows[0].creator_pinned),hidden:Boolean(result.rows[0].creator_hidden)}});
    }catch(error){next(error);}
  });

  app.post('/api/creator/comments/:id/reply', requireAuth, requireActive, async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return res.status(400).json({error:'Comment id সঠিক নয়।'});
      const body=safeText(req.body?.body,2000); if(body.length<1)return res.status(400).json({error:'উত্তর লিখুন।'});
      const parent=await pool.query(`SELECT c.id,c.video_id FROM comments c JOIN videos v ON v.id=c.video_id WHERE c.id=$1 AND c.parent_id IS NULL AND v.owner_sub=$2 AND v.comments_enabled=TRUE`,[req.params.id,req.auth.session.sub]);
      if(!parent.rowCount)return res.status(404).json({error:'নিজের ভিডিওর মূল comment পাওয়া যায়নি।'});
      const id=crypto.randomUUID();
      const result=await pool.query(`INSERT INTO comments(id,video_id,author_sub,parent_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,video_id,parent_id,body,created_at`,[id,parent.rows[0].video_id,req.auth.session.sub,parent.rows[0].id,body]);
      await pool.query('UPDATE videos SET comments_count=comments_count+1 WHERE id=$1',[parent.rows[0].video_id]);
      res.status(201).json({comment:result.rows[0]});
    }catch(error){next(error);}
  });

  app.get('/api/creator/audience', requireAuth, requireChannel, async(req,res,next)=>{
    try{
      const days=[7,30,90].includes(Number(req.query.days))?Number(req.query.days):30, sub=req.auth.session.sub;
      const [daily,viewers,top]=await Promise.all([
        pool.query(`SELECT TO_CHAR(DATE_TRUNC('day',vv.created_at),'YYYY-MM-DD') AS day,COUNT(*)::bigint AS views,COUNT(DISTINCT vv.viewer_hash)::bigint AS viewers FROM video_views vv JOIN videos v ON v.id=vv.video_id WHERE v.owner_sub=$1 AND vv.created_at>=NOW()-($2::int*INTERVAL '1 day') GROUP BY DATE_TRUNC('day',vv.created_at) ORDER BY DATE_TRUNC('day',vv.created_at)`,[sub,days]),
        pool.query(`SELECT COUNT(*)::bigint AS viewer_video_pairs,COUNT(DISTINCT vv.viewer_hash)::bigint AS sampled_viewers FROM video_views vv JOIN videos v ON v.id=vv.video_id WHERE v.owner_sub=$1 AND vv.created_at>=NOW()-($2::int*INTERVAL '1 day')`,[sub,days]),
        pool.query(`SELECT v.id,v.title,v.views_count,COUNT(DISTINCT vv.viewer_hash)::bigint AS sampled_viewers FROM videos v LEFT JOIN video_views vv ON vv.video_id=v.id AND vv.created_at>=NOW()-($2::int*INTERVAL '1 day') WHERE v.owner_sub=$1 GROUP BY v.id ORDER BY sampled_viewers DESC,v.views_count DESC LIMIT 8`,[sub,days])
      ]);
      res.json({days,summary:{sampledViewers:Number(viewers.rows[0]?.sampled_viewers)||0,viewerVideoPairs:Number(viewers.rows[0]?.viewer_video_pairs)||0},daily:daily.rows.map(x=>({day:x.day,views:Number(x.views)||0,viewers:Number(x.viewers)||0})),topVideos:top.rows.map(x=>({id:x.id,title:x.title,views:Number(x.views_count)||0,sampledViewers:Number(x.sampled_viewers)||0}))});
    }catch(error){next(error);}
  });

  app.get('/api/creator/notifications', requireAuth, requireChannel, async(req,res,next)=>{
    try{
      const sub=req.auth.session.sub;
      const [comments,strikes,subscribers]=await Promise.all([
        pool.query(`SELECT c.id,c.body,c.created_at,v.id AS video_id,v.title,p.handle,COALESCE(NULLIF(p.display_name,''),NULLIF(u.google_name,''),'দর্শক') AS author_name FROM comments c JOIN videos v ON v.id=c.video_id JOIN app_users u ON u.google_sub=c.author_sub LEFT JOIN profiles p ON p.sub=c.author_sub WHERE v.owner_sub=$1 AND c.parent_id IS NULL ORDER BY c.created_at DESC LIMIT 15`,[sub]),
        pool.query(`SELECT s.id,s.reason,s.status,s.created_at,v.title AS video_title FROM copyright_strikes s LEFT JOIN videos v ON v.id=s.video_id WHERE s.channel_sub=$1 ORDER BY s.created_at DESC LIMIT 10`,[sub]),
        pool.query(`SELECT u.google_name,p.display_name,p.handle,s.created_at FROM subscriptions s JOIN app_users u ON u.google_sub=s.subscriber_sub LEFT JOIN profiles p ON p.sub=s.subscriber_sub WHERE s.channel_sub=$1 ORDER BY s.created_at DESC LIMIT 15`,[sub])
      ]);
      const items=[...comments.rows.map(x=>({kind:'comment',createdAt:x.created_at,title:'নতুন comment',detail:`${x.author_name} · ${x.title}`,body:x.body,href:`/watch/${encodeURIComponent(x.video_id)}`})),...strikes.rows.map(x=>({kind:'copyright',createdAt:x.created_at,title:'Copyright notice',detail:x.video_title||'ভিডিও',body:x.reason,href:'/studio?tab=copyright'})),...subscribers.rows.map(x=>({kind:'subscriber',createdAt:x.created_at,title:'নতুন subscriber',detail:`${x.display_name||x.google_name||x.handle||'দর্শক'} তোমার channel-এ subscribe করেছেন`,href:'/studio?tab=audience'}))].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,25);
      res.set('Cache-Control','private, no-store');res.json({notifications:items});
    }catch(error){next(error);}
  });

  app.get('/api/creator/playlists', requireAuth, requireChannel, async(req,res,next)=>{
    try{
      const result=await pool.query(`SELECT p.id,p.name,p.description,p.is_public,p.is_premium,p.price_bdt,p.updated_at,COUNT(i.video_id)::bigint AS videos_count FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.owner_sub=$1 AND p.is_creator_playlist=TRUE GROUP BY p.id ORDER BY p.updated_at DESC`,[req.auth.session.sub]);
      res.set('Cache-Control','private, no-store');res.json({playlists:result.rows.map(p=>({id:p.id,name:p.name,description:p.description,isPublic:Boolean(p.is_public),isPremium:Boolean(p.is_premium),priceBdt:Number(p.price_bdt)||0,videosCount:Number(p.videos_count)}))});
    }catch(error){next(error);}
  });
  app.post('/api/creator/playlists', requireAuth, requireActive, requireChannel, async(req,res,next)=>{
    try{
      const name=safeText(req.body?.name,80),description=safeText(req.body?.description,500);
      if(!name)return res.status(400).json({error:'Playlist name is required.'});
      const id=crypto.randomUUID(),isPublic=req.body?.isPublic!==false;
      await pool.query(`INSERT INTO playlists(id,owner_sub,name,description,is_public,is_creator_playlist) VALUES($1,$2,$3,$4,$5,TRUE)`,[id,req.auth.session.sub,name,description,isPublic]);
      res.status(201).json({playlist:{id,name,description,isPublic,videosCount:0}});
    }catch(error){next(error);}
  });
  app.put('/api/creator/playlists/:id', requireAuth, requireActive, requireChannel, async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return res.status(400).json({error:'Invalid playlist id.'});
      const name=safeText(req.body?.name,80),description=safeText(req.body?.description,500);
      if(!name)return res.status(400).json({error:'Playlist name is required.'});
      const result=await pool.query(`UPDATE playlists SET name=$3,description=$4,is_public=$5,updated_at=NOW() WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE RETURNING id,name,description,is_public`,[req.params.id,req.auth.session.sub,name,description,req.body?.isPublic!==false]);
      if(!result.rowCount)return res.status(404).json({error:'Creator playlist not found.'});
      const p=result.rows[0];res.json({playlist:{id:p.id,name:p.name,description:p.description,isPublic:Boolean(p.is_public)}});
    }catch(error){next(error);}
  });
  app.delete('/api/creator/playlists/:id', requireAuth, requireActive, requireChannel, async(req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return res.status(400).json({error:'Invalid playlist id.'});
      const paid=await pool.query("SELECT 1 FROM premium_playlist_orders WHERE playlist_id=$1 AND status IN('pending','paid') LIMIT 1",[req.params.id]);
      if(paid.rowCount)return res.status(409).json({error:'This playlist has premium orders or purchases; archive it by making it private instead of deleting it.'});
      const result=await pool.query('DELETE FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE RETURNING id',[req.params.id,req.auth.session.sub]);
      if(!result.rowCount)return res.status(404).json({error:'Creator playlist not found.'});
      res.json({ok:true});
    }catch(error){next(error);}
  });
  app.get('/api/creator/verification', requireAuth, requireChannel, async(req,res,next)=>{
    try{
      const result=await pool.query(`SELECT id,reason,proof_url,status,decision_note,created_at,reviewed_at FROM channel_verification_requests WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 1`,[req.auth.session.sub]);
      res.set('Cache-Control','private, no-store');res.json({isVerified:Boolean(req.auth.profile?.is_verified),application:result.rows[0]||null});
    }catch(error){next(error);}
  });
  app.post('/api/creator/verification', requireAuth, requireActive, requireChannel, async(req,res,next)=>{
    try{
      if(req.auth.profile?.is_verified)return res.status(409).json({error:'This channel is already verified.'});
      const reason=safeText(req.body?.reason,2000),rawUrl=safeText(req.body?.proofUrl,2048);let proofUrl=null;
      if(reason.length<20)return res.status(400).json({error:'Explain why the channel should be verified (at least 20 characters).'});
      if(rawUrl){try{const url=new URL(rawUrl);if(url.protocol!=='https:'||url.username||url.password)return res.status(400).json({error:'Proof link must use HTTPS.'});proofUrl=url.toString().slice(0,2048);}catch(_){return res.status(400).json({error:'Enter a valid HTTPS proof link.'});}}
      const pending=await pool.query(`SELECT id FROM channel_verification_requests WHERE user_sub=$1 AND status='pending'`,[req.auth.session.sub]);
      if(pending.rowCount)return res.status(409).json({error:'A verification request is already pending.'});
      const id=crypto.randomUUID(),result=await pool.query(`INSERT INTO channel_verification_requests(id,user_sub,reason,proof_url) VALUES($1,$2,$3,$4) RETURNING id,reason,proof_url,status,decision_note,created_at`,[id,req.auth.session.sub,reason,proofUrl]);
      res.status(201).json({application:result.rows[0]});
    }catch(error){if(error.code==='23505')return res.status(409).json({error:'A verification request is already pending.'});next(error);}
  });

};
