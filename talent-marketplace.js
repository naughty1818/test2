'use strict';

const crypto = require('crypto');

const CATEGORIES = new Set(['software-development', 'web-design', 'tutoring', 'graphic-design', 'writing-translation', 'video-editing', 'other']);
const STATUSES = new Set(['draft', 'published', 'paused']);
const ACTIVE_PAYMENT_STATUSES = new Set(['completed', 'complete', 'paid', 'success', 'successful', 'succeeded']);
const safe = (value, max) => String(value || '').trim().slice(0, max);
const money = value => Number(Number(value || 0).toFixed(2));
const publicOrderId = id => `ATH-TAL-${id.replace(/-/g, '').slice(0, 20).toUpperCase()}`;
const paymentData = payload => payload?.data || payload?.result || payload || {};

module.exports = function attachTalentMarketplace({ app, pool, withTransaction, requireAuth, requireActive, requireChannel, validUuid }) {
  const shape = row => ({
    id: row.id, slug: row.slug, title: row.title, description: row.description, category: row.category,
    skills: row.skills || [], requirements: row.requirements || '', status: row.status,
    providerSub: row.provider_sub, providerName: row.display_name || row.google_name || 'Atharo Creator',
    handle: row.handle || '', avatarUrl: row.avatar_url || null, packages: row.packages || [],
    portfolio: row.portfolio || [], createdAt: row.created_at
  });
  function cleanPackages(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw Object.assign(new Error('১ থেকে ৩টি package যোগ করুন।'), { status: 400 });
    return input.map((p, i) => {
      const name = safe(p?.name, 40), scope = safe(p?.scope, 1000), priceBdt = money(p?.priceBdt), deliveryDays = Number(p?.deliveryDays), revisions = Number(p?.revisions);
      if (!name || !scope || !Number.isFinite(priceBdt) || priceBdt <= 0 || priceBdt > 10000000 || !Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 365 || !Number.isInteger(revisions) || revisions < 0 || revisions > 20) throw Object.assign(new Error(`Package ${i + 1}-এর নাম, scope, সঠিক মূল্য, delivery days ও revisions দিন।`), { status: 400 });
      return { name, scope, priceBdt, deliveryDays, revisions };
    });
  }
  async function listingQuery(where, params) {
    return pool.query(`SELECT l.*,u.google_name,p.display_name,p.handle,p.avatar_url,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pk.id,'name',pk.name,'scope',pk.scope,'priceBdt',pk.price_bdt,'deliveryDays',pk.delivery_days,'revisions',pk.revisions) ORDER BY pk.position) FROM talent_packages pk WHERE pk.listing_id=l.id),'[]'::jsonb) AS packages,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'thumbnailUrl',CASE WHEN v.thumbnail_object_name IS NOT NULL THEN '/api/videos/'||v.id||'/thumbnail' ELSE NULL END) ORDER BY tp.position) FROM talent_portfolio_videos tp JOIN videos v ON v.id=tp.video_id WHERE tp.listing_id=l.id),'[]'::jsonb) AS portfolio
      FROM talent_listings l JOIN app_users u ON u.google_sub=l.provider_sub LEFT JOIN profiles p ON p.sub=l.provider_sub WHERE ${where}`, params);
  }
  app.get('/api/talent/listings', async (req, res, next) => {
    try {
      const clauses = ["l.status='published'", "u.account_status='active'"];
      const params = [];
      const q = safe(req.query.q, 120);
      if (q) { params.push(q); clauses.push(`(to_tsvector('simple',l.title||' '||l.description) @@ plainto_tsquery('simple',$${params.length}) OR l.skills && string_to_array($${params.length},' ') OR l.category ILIKE '%'||$${params.length}||'%')`); }
      if (CATEGORIES.has(String(req.query.category))) { params.push(String(req.query.category)); clauses.push(`l.category=$${params.length}`); }
      const result = await listingQuery(clauses.join(' AND '), params);
      res.json({ listings: result.rows.map(shape) });
    } catch (error) { next(error); }
  });
  app.get('/api/talent/listings/:slug', async (req, res, next) => {
    try {
      const result = await listingQuery("l.slug=$1 AND l.status='published' AND u.account_status='active'", [safe(req.params.slug, 180)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Talent listing পাওয়া যায়নি।' });
      res.json({ listing: shape(result.rows[0]) });
    } catch (error) { next(error); }
  });
  app.get('/api/creator/talent/listings', requireAuth, requireChannel, async (req, res, next) => {
    try {
      const result = await listingQuery('l.provider_sub=$1', [req.auth.session.sub]);
      res.json({ listings: result.rows.map(shape) });
    } catch (error) { next(error); }
  });
  app.post('/api/creator/talent/listings', requireAuth, requireActive, requireChannel, async (req, res, next) => {
    try {
      const title = safe(req.body?.title, 120), description = safe(req.body?.description, 4000), category = safe(req.body?.category, 50), requirements = safe(req.body?.requirements, 2000);
      const skills = Array.isArray(req.body?.skills) ? [...new Set(req.body.skills.map(x => safe(x, 40)).filter(Boolean))].slice(0, 12) : [];
      const packages = cleanPackages(req.body?.packages);
      const videoIds = Array.isArray(req.body?.portfolioVideoIds) ? [...new Set(req.body.portfolioVideoIds.map(x => safe(x, 120)))].slice(0, 5) : [];
      const status = STATUSES.has(req.body?.status) ? req.body.status : 'draft';
      if (title.length < 4 || description.length < 20 || !CATEGORIES.has(category)) return res.status(400).json({ error: 'শিরোনাম (কমপক্ষে ৪ অক্ষর), বিবরণ (২০ অক্ষর) ও বৈধ category দিন।' });
      if (status === 'published' && !packages.length) return res.status(400).json({ error: 'প্রকাশের আগে package যোগ করুন।' });
      const slug = `${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 75) || 'talent'}-${crypto.randomBytes(4).toString('hex')}`;
      const id = crypto.randomUUID();
      const saved = await withTransaction(async client => {
        if (videoIds.length) {
          const owned = await client.query("SELECT id FROM videos WHERE id=ANY($1::text[]) AND owner_sub=$2 AND visibility='Public' AND moderation_status='active'", [videoIds, req.auth.session.sub]);
          if (owned.rowCount !== videoIds.length) throw Object.assign(new Error('Portfolio-তে কেবল নিজের active Public Atharo video যোগ করা যাবে।'), { status: 400 });
        }
        await client.query('INSERT INTO talent_listings(id,provider_sub,slug,title,description,category,skills,requirements,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, req.auth.session.sub, slug, title, description, category, skills, requirements, status]);
        for (const [position, p] of packages.entries()) await client.query('INSERT INTO talent_packages(listing_id,name,scope,price_bdt,delivery_days,revisions,position) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, p.name, p.scope, p.priceBdt, p.deliveryDays, p.revisions, position]);
        for (const [position, videoId] of videoIds.entries()) await client.query('INSERT INTO talent_portfolio_videos(listing_id,video_id,position) VALUES($1,$2,$3)', [id, videoId, position]);
        return { id, slug };
      });
      res.status(201).json({ listing: saved });
    } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
  });
  app.post('/api/talent/orders', requireAuth, requireActive, async (req, res, next) => {
    try {
      if (!validUuid(req.body?.packageId)) return res.status(400).json({ error: 'সঠিক package নির্বাচন করুন।' });
      const brief = safe(req.body?.brief, 4000);
      if (brief.length < 20) return res.status(400).json({ error: 'কাজের বিবরণ অন্তত ২০ অক্ষরের হতে হবে।' });
      const found = await pool.query(`SELECT l.id,l.provider_sub,l.title,l.slug,pk.id AS package_id,pk.name AS package_name,pk.scope,pk.price_bdt,pk.delivery_days,pk.revisions
        FROM talent_listings l JOIN talent_packages pk ON pk.listing_id=l.id JOIN app_users u ON u.google_sub=l.provider_sub
        WHERE pk.id=$1 AND l.status='published' AND u.account_status='active'`, [req.body.packageId]);
      if (!found.rowCount) return res.status(404).json({ error: 'প্রকাশিত Talent package পাওয়া যায়নি।' });
      const row = found.rows[0], buyer = req.auth.session.sub;
      if (row.provider_sub === buyer) return res.status(400).json({ error: 'নিজের Talent listing hire করা যাবে না।' });
      const id = crypto.randomUUID();
      await pool.query(`INSERT INTO talent_orders(id,listing_id,package_id,buyer_sub,provider_sub,amount_bdt,contract_snapshot,buyer_brief,status)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'awaiting_provider')`, [id,row.id,row.package_id,buyer,row.provider_sub,row.price_bdt,JSON.stringify({listingTitle:row.title,packageName:row.package_name,scope:row.scope,priceBdt:Number(row.price_bdt),deliveryDays:row.delivery_days,revisions:row.revisions}),brief]);
      await pool.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,$2,'created',$3)", [id,buyer,'Buyer accepted the displayed package terms; provider acceptance is pending.']);
      res.status(201).json({ order: { id, status: 'awaiting_provider', amountBdt: Number(row.price_bdt) } });
    } catch (error) { next(error); }
  });
  app.get('/api/me/talent/purchases', requireAuth, async (req,res,next) => {
    try {
      const result = await pool.query(`SELECT o.id,o.status,o.amount_bdt,o.created_at,o.updated_at,o.paid_at,
        o.provider_accepted_at,o.completed_at,o.contract_snapshot,o.buyer_brief,
        COALESCE(p.display_name,u.google_name,'Atharo Creator') AS provider_name,p.handle AS provider_handle,
        latest_activity.event_type AS latest_event_type,latest_activity.details AS latest_event_details,latest_activity.created_at AS latest_event_at,
        delivery.note AS delivery_note,delivery.delivery_url,delivery.created_at AS delivery_at
        FROM talent_orders o JOIN app_users u ON u.google_sub=o.provider_sub
        LEFT JOIN profiles p ON p.sub=o.provider_sub
        LEFT JOIN LATERAL (SELECT event_type,details,created_at FROM talent_order_events WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) latest_activity ON TRUE
        LEFT JOIN LATERAL (SELECT note,delivery_url,created_at FROM talent_deliverables WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) delivery ON TRUE
        WHERE o.buyer_sub=$1 ORDER BY o.updated_at DESC LIMIT 100`,[req.auth.session.sub]);
      res.json({ purchases:result.rows.map(r=>({id:r.id,status:r.status,amountBdt:Number(r.amount_bdt),createdAt:r.created_at,updatedAt:r.updated_at,paidAt:r.paid_at,providerAcceptedAt:r.provider_accepted_at,completedAt:r.completed_at,contract:r.contract_snapshot,brief:r.buyer_brief,providerName:r.provider_name,providerHandle:r.provider_handle||'',latestEvent:r.latest_event_type?{type:r.latest_event_type,details:r.latest_event_details,createdAt:r.latest_event_at}:null,delivery:r.delivery_at?{note:r.delivery_note,url:r.delivery_url,createdAt:r.delivery_at}:null})) });
    } catch(error) { next(error); }
  });
  app.get('/api/me/talent/orders', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT o.id,o.status,o.amount_bdt,o.created_at,o.contract_snapshot,o.buyer_brief,
        CASE WHEN o.buyer_sub=$1 THEN 'buyer' ELSE 'provider' END AS role,
        CASE WHEN o.buyer_sub=$1 THEN COALESCE(sp.display_name,su.google_name) ELSE COALESCE(bp.display_name,bu.google_name) END AS other_name,
        CASE WHEN o.provider_sub=$1 THEN bp.handle ELSE sp.handle END AS other_handle
        FROM talent_orders o LEFT JOIN app_users bu ON bu.google_sub=o.buyer_sub LEFT JOIN app_users su ON su.google_sub=o.provider_sub LEFT JOIN profiles bp ON bp.sub=o.buyer_sub LEFT JOIN profiles sp ON sp.sub=o.provider_sub
        WHERE o.buyer_sub=$1 OR o.provider_sub=$1 ORDER BY o.created_at DESC LIMIT 100`, [req.auth.session.sub]);
      res.json({ orders: result.rows.map(r => ({ id:r.id,status:r.status,amountBdt:Number(r.amount_bdt),createdAt:r.created_at,contract:r.contract_snapshot,brief:r.buyer_brief,role:r.role,otherName:r.other_name||'Atharo user',otherHandle:r.other_handle||'' })) });
    } catch (error) { next(error); }
  });
  app.post('/api/creator/talent/orders/:id/accept', requireAuth, requireActive, requireChannel, async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid order id.' });
      const changed = await withTransaction(async client => {
        const r = await client.query("UPDATE talent_orders SET status='awaiting_payment',provider_accepted_at=NOW(),updated_at=NOW() WHERE id=$1 AND provider_sub=$2 AND status='awaiting_provider' RETURNING id", [req.params.id,req.auth.session.sub]);
        if (!r.rowCount) return false;
        await client.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,$2,'provider_accepted','Provider accepted the contract snapshot.')", [req.params.id,req.auth.session.sub]);
        return true;
      });
      if (!changed) return res.status(409).json({ error: 'এই order আর গ্রহণ করা যাচ্ছে না।' });
      res.json({ ok: true, status: 'awaiting_payment' });
    } catch (error) { next(error); }
  });
  app.post('/api/me/talent/orders/:id/checkout', requireAuth, requireActive, async (req, res, next) => {
    try {
      const r = await pool.query("SELECT * FROM talent_orders WHERE id=$1 AND buyer_sub=$2", [req.params.id,req.auth.session.sub]);
      if (!r.rowCount) return res.status(404).json({ error: 'Order not found.' });
      const order = r.rows[0];
      if (order.status !== 'awaiting_payment' && order.status !== 'paid' && order.status !== 'in_progress') return res.status(409).json({ error: 'Provider acceptance না পাওয়া পর্যন্ত checkout করা যাবে না।' });
      if (order.status === 'paid' || order.status === 'in_progress') return res.json({ paid: true, orderId: order.id });
      res.status(201).json({ pending:true,manual:true,orderId:order.id,orderRef:publicOrderId(order.id),amountBdt:Number(order.amount_bdt),createdAt:order.created_at,receivers:{bkash:process.env.PAYMENT_RECEIVER_BKASH||'',nagad:process.env.PAYMENT_RECEIVER_NAGAD||''} });
    } catch (error) { if (error.status) return res.status(error.status).json({ error:error.message }); next(error); }
  });
  app.get('/api/me/talent/orders/:id/status', requireAuth, async (req,res,next) => {
    try {
      const r = await pool.query('SELECT id,status,provider_invoice_id FROM talent_orders WHERE id=$1 AND buyer_sub=$2', [req.params.id,req.auth.session.sub]);
      if (!r.rowCount) return res.status(404).json({ error:'Order not found.' });
      const latest = await pool.query('SELECT status,paid_at FROM talent_orders WHERE id=$1', [req.params.id]);
      res.json({ orderId:req.params.id,status:latest.rows[0].status,paid:Boolean(latest.rows[0].paid_at) });
    } catch (error) { next(error); }
  });
  app.post('/api/creator/talent/orders/:id/submit', requireAuth, requireActive, requireChannel, async (req,res,next) => {
    try {
      const note = safe(req.body?.note,2000), url = safe(req.body?.deliveryUrl,2048);
      if (note.length < 5 && !/^https:\/\//i.test(url)) return res.status(400).json({ error:'কাজের নোট বা HTTPS delivery link দিন।' });
      const changed = await withTransaction(async client => {
        const r = await client.query("UPDATE talent_orders SET status='submitted',updated_at=NOW() WHERE id=$1 AND provider_sub=$2 AND status IN('in_progress','revision_requested') RETURNING id",[req.params.id,req.auth.session.sub]);
        if (!r.rowCount) return false;
        await client.query('INSERT INTO talent_deliverables(order_id,note,delivery_url) VALUES($1,$2,$3)',[req.params.id,note,url||null]);
        await client.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,$2,'work_submitted',$3)",[req.params.id,req.auth.session.sub,note||url]);
        return true;
      });
      if (!changed) return res.status(409).json({ error:'এই order-এ কাজ জমা দেওয়া যাচ্ছে না।' });
      res.json({ ok:true,status:'submitted' });
    } catch (error) { next(error); }
  });
  app.post('/api/me/talent/orders/:id/accept-work', requireAuth, requireActive, async (req,res,next) => {
    try {
      const changed = await withTransaction(async client => {
        const r = await client.query("UPDATE talent_orders SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND buyer_sub=$2 AND status='submitted' RETURNING id,provider_sub,amount_bdt",[req.params.id,req.auth.session.sub]);
        if (!r.rowCount) return null;
        await client.query("INSERT INTO talent_earnings(id,order_id,provider_sub,amount_bdt,creator_net_bdt,status) VALUES($1,$2,$3,$4,$4,'pending_payout') ON CONFLICT(order_id) DO NOTHING",[crypto.randomUUID(),r.rows[0].id,r.rows[0].provider_sub,r.rows[0].amount_bdt]);
        await client.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,$2,'work_accepted','Buyer accepted the submitted work.')",[req.params.id,req.auth.session.sub]);
        return true;
      });
      if (!changed) return res.status(409).json({ error:'কাজ জমা না হলে বা order completed হলে গ্রহণ করা যাবে না।' });
      res.json({ ok:true,status:'completed',note:'সেবাদাতার আয় completed order হিসেবে Talent earning ledger-এ রেকর্ড হয়েছে; স্বয়ংক্রিয় payout চালু নয়।' });
    } catch (error) { next(error); }
  });
  app.post('/api/me/talent/orders/:id/request-revision', requireAuth, requireActive, async (req,res,next) => {
    try {
      const note = safe(req.body?.note,1000);
      if (note.length < 5) return res.status(400).json({ error:'পরিবর্তনের বিবরণ দিন।' });
      const changed = await withTransaction(async client => {
        const r = await client.query("UPDATE talent_orders SET status='revision_requested',revisions_used=revisions_used+1,updated_at=NOW() WHERE id=$1 AND buyer_sub=$2 AND status='submitted' AND revisions_used<(contract_snapshot->>'revisions')::integer RETURNING id",[req.params.id,req.auth.session.sub]);
        if (!r.rowCount) return false;
        await client.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,$2,'revision_requested',$3)",[req.params.id,req.auth.session.sub,note]);
        return true;
      });
      if (!changed) return res.status(409).json({ error:'সংশোধন আর চাওয়া যাচ্ছে না; revision limit শেষ বা order state পরিবর্তিত।' });
      res.json({ ok:true,status:'revision_requested' });
    } catch (error) { next(error); }
  });
};
