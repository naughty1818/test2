'use strict';

const crypto = require('crypto');

module.exports = function attachCreatorStudio({ app, pool, requireAuth, requireActive, requireValidId, validUuid, safeText, normalizeCategory, normalizeVisibility }) {
  app.get('/api/creator/content', requireAuth, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const [videos, uploads] = await Promise.all([
        pool.query(`SELECT v.id,v.title,v.description,v.category,v.visibility,v.moderation_status,v.scheduled_at,v.comments_enabled,v.created_at,v.views_count,v.likes_count,v.comments_count,v.class_level,v.subject,v.syllabus_tags,v.duration_seconds,v.thumbnail_object_name,
          (SELECT COUNT(*)::bigint FROM video_captions c WHERE c.video_id=v.id) AS captions_count
          FROM videos v WHERE v.owner_sub=$1 ORDER BY v.created_at DESC LIMIT 200`, [sub]),
        pool.query(`SELECT id,title,category,visibility,expected_size,created_at,expires_at FROM upload_intents WHERE owner_sub=$1 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 20`, [sub])
      ]);
      res.set('Cache-Control', 'private, no-store');
      res.json({ videos: videos.rows.map(v => ({ id:v.id,title:v.title,description:v.description,category:v.category,visibility:v.visibility,status:v.moderation_status,scheduledAt:v.scheduled_at,commentsEnabled:v.comments_enabled!==false,createdAt:v.created_at,views:Number(v.views_count)||0,likes:Number(v.likes_count)||0,comments:Number(v.comments_count)||0,classLevel:v.class_level||'',subject:v.subject||'',syllabusTags:v.syllabus_tags||[],durationSeconds:Number(v.duration_seconds)||0,hasThumbnail:Boolean(v.thumbnail_object_name),captions:Number(v.captions_count)||0 })), uploads: uploads.rows.map(u=>({id:u.id,title:u.title,category:u.category,visibility:u.visibility,size:Number(u.expected_size)||0,createdAt:u.created_at,expiresAt:u.expires_at})) });
    } catch (error) { next(error); }
  });

  app.patch('/api/creator/videos/:id', requireAuth, requireActive, requireValidId, async (req,res,next) => {
    try {
      const id=req.params.id, sub=req.auth.session.sub;
      const title=safeText(req.body?.title,100), description=safeText(req.body?.description,5000);
      const category=normalizeCategory(req.body?.category), visibility=normalizeVisibility(req.body?.visibility);
      const classLevel=safeText(req.body?.classLevel,40), subject=safeText(req.body?.subject,80);
      const syllabusTags=Array.isArray(req.body?.syllabusTags)?[...new Set(req.body.syllabusTags.map(x=>safeText(x,60)).filter(Boolean))].slice(0,12):String(req.body?.syllabusTags||'').split(',').map(x=>safeText(x,60)).filter(Boolean).slice(0,12);
      const commentsEnabled=req.body?.commentsEnabled===undefined?null:Boolean(req.body.commentsEnabled);
      const scheduledAt=req.body?.scheduledAt===undefined?undefined:(req.body.scheduledAt===null||req.body.scheduledAt===''?null:new Date(req.body.scheduledAt));
      if(scheduledAt!==undefined&&scheduledAt!==null&&!Number.isFinite(scheduledAt.getTime()))return res.status(400).json({error:'প্রকাশের তারিখ সঠিক নয়।'});
      if(!title||!category||!visibility)return res.status(400).json({error:'শিরোনাম, বিভাগ ও visibility ঠিক করে দিন।'});
      const result=await pool.query(`UPDATE videos SET title=$3,description=$4,category=$5,visibility=$6,class_level=$7,subject=$8,syllabus_tags=$9,comments_enabled=COALESCE($10,comments_enabled),scheduled_at=CASE WHEN $11::boolean THEN $12::timestamptz ELSE scheduled_at END WHERE id=$1 AND owner_sub=$2 RETURNING id,title,description,category,visibility,class_level,subject,syllabus_tags,comments_enabled,scheduled_at`,[id,sub,title,description,category,visibility,classLevel,subject,syllabusTags,commentsEnabled,scheduledAt!==undefined,scheduledAt||null]);
      if(!result.rowCount)return res.status(404).json({error:'নিজের ভিডিওটি পাওয়া যায়নি।'});
      res.json({video:result.rows[0]});
    } catch(error){next(error);}
  });

  app.get('/api/creator/comments', requireAuth, async (req,res,next) => {
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

  app.get('/api/creator/audience', requireAuth, async(req,res,next)=>{
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

  app.get('/api/creator/notifications', requireAuth, async(req,res,next)=>{
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
};
