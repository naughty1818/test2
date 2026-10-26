'use strict';

const crypto = require('crypto');
const { encryptPayoutDetails } = require('./payout-security');

const NOGORPAY_BASE = String(process.env.NOGORPAY_API_BASE || 'https://api.nogorpay.com/api/v1').replace(/\/$/, '');
const NOGORPAY_KEY = process.env.NOGORPAY_API_KEY || '';
const NOGORPAY_BRAND = process.env.NOGORPAY_BRAND_ID || '8ETVNX';
const NOGORPAY_WEBHOOK = process.env.NOGORPAY_WEBHOOK_URL || '';
const money = value => Number(Number(value || 0).toFixed(2));
function publicOrderId(id) { return `ATH-${id.replace(/-/g, '').slice(0, 20).toUpperCase()}`; }
function extractData(payload) { return payload?.data || payload?.result || payload || {}; }
function paymentStatus(payload) {
  const value = String(payload?.status || payload?.data?.status || payload?.event || payload?.data?.event || '').toLowerCase();
  return ['completed', 'complete', 'paid', 'success', 'successful', 'succeeded'].includes(value);
}
function amountFrom(payload) {
  const data = extractData(payload);
  return Number(data.amount ?? data.amount_bdt ?? data.paid_amount ?? payload?.amount ?? 0);
}
function invoiceFrom(payload) {
  const data = extractData(payload);
  return data.invoice_id || data.invoiceId || payload?.invoice_id || payload?.invoiceId || null;
}

module.exports = function attachPremiumMarketplace({ app, pool, withTransaction, requireAuth, requireActive, requireChannel, loadSession, validUuid }) {
  const productRow = row => ({
    id: row.id, name: row.name || row.title, title: row.title || row.name, description: row.description || '',
    priceBdt: Number(row.price_bdt) || 0, isPremium: Boolean(row.is_premium), isPublic: Boolean(row.is_public),
    videosCount: Number(row.videos_count) || 0, creatorName: row.display_name || row.google_name || 'Creator',
    handle: row.handle || '', avatarUrl: row.avatar_url || null, thumbnailUrl: row.thumbnail_object_name ? `/api/videos/${encodeURIComponent(row.id)}/thumbnail` : null,
    updatedAt: row.updated_at, owned: Boolean(row.owned), sold: Number(row.sold) || 0
  });
  async function nogorRequest(path, options = {}) {
    if (!NOGORPAY_KEY) throw Object.assign(new Error('NogorPay integration is not configured on the server.'), { status: 503 });
    const response = await fetch(`${NOGORPAY_BASE}${path}`, { ...options, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'NOGORPAY-API-KEY': NOGORPAY_KEY, ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw Object.assign(new Error(body.message || body.error || `NogorPay request failed (${response.status}).`), { status: 502 });
    return body;
  }
  async function verifyNogorOrder(order) {
    if (!order.provider_invoice_id) return null;
    return nogorRequest(`/charge/verify/${encodeURIComponent(order.provider_invoice_id)}`, { method: 'GET' });
  }
  async function grantEntitlement(orderId, providerPayload) {
    return withTransaction(async client => {
      const found = await client.query(`SELECT o.*,COALESCE(p.owner_sub,v.owner_sub) AS creator_sub
        FROM premium_playlist_orders o LEFT JOIN playlists p ON p.id=o.playlist_id LEFT JOIN videos v ON v.id=o.video_id
        WHERE o.id=$1 FOR UPDATE OF o`, [orderId]);
      if (!found.rowCount) return { ok: false, reason: 'order_not_found' };
      const order = found.rows[0], receivedAmount = amountFrom(providerPayload);
      if (receivedAmount && Math.abs(receivedAmount - Number(order.amount_bdt)) > 0.009) return { ok: false, reason: 'amount_mismatch' };
      if (order.status === 'paid') return { ok: true, alreadyPaid: true };
      if (!order.creator_sub) return { ok: false, reason: 'creator_not_found' };
      const settings = await client.query('SELECT video_commission_percent,playlist_commission_percent FROM platform_settings WHERE id=1');
      const settingsRow = settings.rows[0] || {};
      const feePercent = money(order.video_id ? settingsRow.video_commission_percent ?? 20 : settingsRow.playlist_commission_percent ?? 20);
      const amount = money(order.amount_bdt), fee = money(amount * feePercent / 100), creatorAmount = money(amount - fee);
      const ref = extractData(providerPayload);
      await client.query(`UPDATE premium_playlist_orders SET status='paid',paid_at=COALESCE(paid_at,NOW()),verified_at=NOW(),
        provider_reference=COALESCE($2,provider_reference),platform_fee_percent=$3,platform_fee_bdt=$4,creator_earning_bdt=$5 WHERE id=$1`,
        [orderId, String(ref.transaction_id || ref.payment_id || '') || null, feePercent, fee, creatorAmount]);
      if (order.playlist_id) {
        await client.query('INSERT INTO premium_playlist_entitlements(playlist_id,buyer_sub,order_id) VALUES($1,$2,$3) ON CONFLICT (playlist_id,buyer_sub) DO NOTHING', [order.playlist_id, order.buyer_sub, order.id]);
      } else {
        await client.query('INSERT INTO premium_video_entitlements(video_id,buyer_sub,order_id) VALUES($1,$2,$3) ON CONFLICT (video_id,buyer_sub) DO NOTHING', [order.video_id, order.buyer_sub, order.id]);
      }
      await client.query(`INSERT INTO creator_wallet_ledger(id,creator_sub,order_id,amount_bdt,entry_type,description)
        VALUES($1,$2,$3,$4,'sale','Premium content sale') ON CONFLICT(order_id) DO NOTHING`, [crypto.randomUUID(), order.creator_sub, order.id, creatorAmount]);
      return { ok: true };
    });
  }
  async function createCheckout(req, res, productType, id) {
    if (!NOGORPAY_KEY || !NOGORPAY_BRAND) return res.status(503).json({ error: 'NogorPay checkout is not configured yet.' });
    const phone = String(req.body?.customerPhone || '').replace(/[^0-9+]/g, '').slice(0, 20);
    if (phone.length < 8) return res.status(400).json({ error: 'NogorPay checkout-এর জন্য valid customer phone দিন।' });
    const buyer = req.auth.session.sub;
    const client = await pool.connect();
    let item, orderId;
    try {
      await client.query('BEGIN');
      if (productType === 'playlist') {
        const result = await client.query(`SELECT id,owner_sub,price_bdt,is_premium,is_public,name FROM playlists WHERE id=$1 AND is_creator_playlist=TRUE FOR UPDATE`, [id]);
        item = result.rows[0];
      } else {
        const result = await client.query(`SELECT id,owner_sub,price_bdt,is_premium,visibility='Public' AS is_public,title AS name FROM videos WHERE id=$1 AND moderation_status='active' FOR UPDATE`, [id]);
        item = result.rows[0];
      }
      if (!item || !item.is_premium || !item.is_public) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Premium content not found.' }); }
      if (item.owner_sub === buyer) { await client.query('COMMIT'); return res.json({ owned: true, message: 'Creator access granted.' }); }
      const itemColumn = productType === 'playlist' ? 'playlist_id' : 'video_id';
      const existing = await client.query(`SELECT id,status,checkout_url FROM premium_playlist_orders WHERE ${itemColumn}=$1 AND buyer_sub=$2 AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1`, [id, buyer]);
      if (existing.rows[0]?.status === 'paid') { await client.query('COMMIT'); return res.json({ owned: true, orderId: existing.rows[0].id, message: 'এই content আগে থেকেই কেনা আছে।' }); }
      if (existing.rows[0]?.checkout_url) { await client.query('COMMIT'); return res.json({ pending: true, orderId: existing.rows[0].id, paymentUrl: existing.rows[0].checkout_url }); }
      orderId = crypto.randomUUID();
      await client.query(`INSERT INTO premium_playlist_orders(id,playlist_id,video_id,buyer_sub,amount_bdt,status,payment_provider,provider_reference,payment_method)
        VALUES($1,$2,$3,$4,$5,'pending','nogorpay',$6,$7)`, [orderId, productType === 'playlist' ? id : null, productType === 'video' ? id : null, buyer, item.price_bdt, publicOrderId(orderId), String(req.body?.paymentMethod || '').slice(0, 40) || null]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    const origin = String(process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const itemPath = productType === 'playlist' ? `/premium/${encodeURIComponent(id)}` : `/premium/video/${encodeURIComponent(id)}`;
    const webhookUrl = NOGORPAY_WEBHOOK || `${origin}/api/nogorpay/webhook`;
    try {
      const body = await nogorRequest('/charge/create', { method: 'POST', body: JSON.stringify({
        order_id: publicOrderId(orderId), amount: Number(item.price_bdt), customer_phone: phone,
        customer_email: req.auth.session.email, customer_name: req.auth.session.name || 'Atharo viewer', brand_id: NOGORPAY_BRAND,
        payment_method: req.body?.paymentMethod || undefined, webhook_url: webhookUrl,
        redirect_url: `${origin}${itemPath}?payment=return&order_id=${encodeURIComponent(orderId)}`,
        cancel_url: `${origin}${itemPath}?payment=cancelled`
      }) });
      const data = extractData(body), paymentUrl = data.payment_url || data.paymentUrl || body.payment_url, invoiceId = data.invoice_id || data.invoiceId || body.invoice_id;
      if (!paymentUrl || !invoiceId) throw Object.assign(new Error('NogorPay did not return a checkout URL or invoice id.'), { status: 502 });
      await pool.query('UPDATE premium_playlist_orders SET provider_invoice_id=$2,checkout_url=$3 WHERE id=$1', [orderId, invoiceId, paymentUrl]);
      return res.status(201).json({ pending: true, orderId, invoiceId, paymentUrl, amountBdt: Number(item.price_bdt), paymentProvider: 'nogorpay' });
    } catch (error) {
      await pool.query("UPDATE premium_playlist_orders SET status='failed' WHERE id=$1 AND status='pending'", [orderId]).catch(() => {});
      throw error;
    }
  }

  app.get('/api/premium/playlists', async (req, res, next) => {
    try {
      const auth = req.auth || await loadSession(req), sub = auth?.session?.sub || '';
      const result = await pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,
        COUNT(i.video_id)::bigint AS videos_count,COUNT(i.video_id) FILTER(WHERE i.is_preview)::bigint AS preview_count,
        pr.display_name,pr.handle,pr.avatar_url,u.google_name,(p.owner_sub=$1 OR EXISTS(SELECT 1 FROM premium_playlist_entitlements e WHERE e.playlist_id=p.id AND e.buyer_sub=$1)) AS owned
        FROM playlists p JOIN app_users u ON u.google_sub=p.owner_sub LEFT JOIN profiles pr ON pr.sub=p.owner_sub LEFT JOIN playlist_items i ON i.playlist_id=p.id
        WHERE p.is_creator_playlist=TRUE AND p.is_premium=TRUE AND p.is_public=TRUE AND u.account_status='active'
        GROUP BY p.id,pr.display_name,pr.handle,pr.avatar_url,u.google_name ORDER BY p.updated_at DESC LIMIT 100`, [sub]);
      res.json({ playlists: result.rows.map(p => ({ ...productRow(p), previewCount: Number(p.preview_count) || 0 })) });
    } catch (error) { next(error); }
  });
  app.get('/api/premium/videos', async (req, res, next) => {
    try {
      const auth = req.auth || await loadSession(req), sub = auth?.session?.sub || '';
      const result = await pool.query(`SELECT v.id,v.title,v.description,v.price_bdt,v.is_premium,v.thumbnail_object_name,v.created_at AS updated_at,
        p.display_name,p.handle,p.avatar_url,u.google_name,(v.owner_sub=$1 OR EXISTS(SELECT 1 FROM premium_video_entitlements e WHERE e.video_id=v.id AND e.buyer_sub=$1)) AS owned,
        EXISTS(SELECT 1 FROM premium_video_entitlements e WHERE e.video_id=v.id AND e.buyer_sub=$1) AS purchased,
        (SELECT COUNT(*)::bigint FROM premium_playlist_orders o WHERE o.video_id=v.id AND o.status='paid') AS sold
        FROM videos v JOIN app_users u ON u.google_sub=v.owner_sub LEFT JOIN profiles p ON p.sub=v.owner_sub
        WHERE v.visibility='Public' AND v.is_premium=TRUE AND v.moderation_status='active' AND u.account_status='active'
        ORDER BY v.created_at DESC LIMIT 100`, [sub]);
      res.json({ videos: result.rows.map(v => ({ ...productRow({ ...v, name:v.title, is_public:true }), purchased:Boolean(v.purchased) })) });
    } catch (error) { next(error); }
  });
  app.get('/api/premium/videos/:id', async (req,res,next)=>{
    try{
      const auth=req.auth||await loadSession(req),sub=auth?.session?.sub||'';
      const result=await pool.query(`SELECT v.id,v.title,v.description,v.price_bdt,v.is_premium,v.visibility='Public' AS is_public,
        v.thumbnail_object_name,v.duration_seconds,v.views_count,v.owner_sub,p.display_name,p.handle,p.avatar_url,u.google_name,
        (v.owner_sub=$2) AS is_owner,(v.owner_sub=$2 OR EXISTS(SELECT 1 FROM premium_video_entitlements e WHERE e.video_id=v.id AND e.buyer_sub=$2)) AS owned
        FROM videos v JOIN app_users u ON u.google_sub=v.owner_sub LEFT JOIN profiles p ON p.sub=v.owner_sub
        WHERE v.id=$1 AND v.is_premium=TRUE AND v.moderation_status='active'`,[req.params.id,sub]);
      if(!result.rowCount||(!result.rows[0].is_public&&!result.rows[0].is_owner))return res.status(404).json({error:'Premium video not found.'});
      const row=result.rows[0];res.json({video:{...productRow({...row,name:row.title,thumbnail_object_name:row.thumbnail_object_name}),durationSeconds:Number(row.duration_seconds)||0,views:Number(row.views_count)||0},canAccess:Boolean(row.owned||row.is_owner)});
    }catch(error){next(error);}
  });
  app.get('/api/premium/playlists/:id', async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid premium playlist id.' });
      const auth = req.auth || await loadSession(req), sub = auth?.session?.sub || '';
      const found = await pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,
        COUNT(i.video_id)::bigint AS videos_count,COUNT(i.video_id) FILTER(WHERE i.is_preview)::bigint AS preview_count,
        pr.display_name,pr.handle,pr.avatar_url,u.google_name,EXISTS(SELECT 1 FROM premium_playlist_entitlements e WHERE e.playlist_id=p.id AND e.buyer_sub=$2) AS owned,p.owner_sub=$2 AS is_owner
        FROM playlists p JOIN app_users u ON u.google_sub=p.owner_sub LEFT JOIN profiles pr ON pr.sub=p.owner_sub LEFT JOIN playlist_items i ON i.playlist_id=p.id
        WHERE p.id=$1 AND p.is_creator_playlist=TRUE AND (p.is_premium=TRUE OR EXISTS(SELECT 1 FROM premium_playlist_entitlements ep WHERE ep.playlist_id=p.id AND ep.buyer_sub=$2) OR p.owner_sub=$2) GROUP BY p.id,pr.display_name,pr.handle,pr.avatar_url,u.google_name`, [req.params.id, sub]);
      if (!found.rowCount || (!found.rows[0].is_public && !found.rows[0].is_owner && !found.rows[0].owned)) return res.status(404).json({ error: 'Premium playlist not found.' });
      const row = found.rows[0], canAccess = Boolean(row.owned || row.is_owner);
      const videos = await pool.query(`SELECT v.id,v.title,v.description,v.category,v.duration_seconds,v.thumbnail_object_name,v.views_count,i.is_preview
        FROM playlist_items i JOIN videos v ON v.id=i.video_id WHERE i.playlist_id=$1 AND ($2::boolean OR i.is_preview=TRUE) ORDER BY i.position,i.added_at`, [req.params.id, canAccess]);
      res.json({ playlist: { ...productRow(row), previewCount:Number(row.preview_count)||0 }, canAccess, isOwner:Boolean(row.is_owner),
        videos: videos.rows.map(v => ({ id:v.id,title:v.title,description:v.description,category:v.category,durationSeconds:Number(v.duration_seconds)||0,views:Number(v.views_count)||0,preview:Boolean(v.is_preview),thumbnailUrl:v.thumbnail_object_name?`/api/videos/${encodeURIComponent(v.id)}/thumbnail`:null })) });
    } catch (error) { next(error); }
  });

  app.post('/api/premium/playlists/:id/purchase', requireAuth, requireActive, async (req, res, next) => { try { if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid premium playlist id.' }); await createCheckout(req,res,'playlist',req.params.id); } catch (error) { next(error); } });
  app.post('/api/premium/videos/:id/purchase', requireAuth, requireActive, async (req, res, next) => { try { await createCheckout(req,res,'video',req.params.id); } catch (error) { next(error); } });

  app.post('/api/nogorpay/webhook', async (req, res, next) => {
    try {
      const payload = req.body || {}, data = extractData(payload), externalOrder = data.order_id || payload.order_id, invoiceId = invoiceFrom(payload);
      let found = externalOrder ? await pool.query('SELECT * FROM premium_playlist_orders WHERE provider_reference=$1 LIMIT 1', [externalOrder]) : { rowCount:0, rows:[] };
      if (!found.rowCount && invoiceId) found = await pool.query('SELECT * FROM premium_playlist_orders WHERE provider_invoice_id=$1', [invoiceId]);
      if (!found.rowCount) return res.status(200).json({ received: true, matched: false });
      const order = found.rows[0], verified = await verifyNogorOrder(order);
      if (!verified || !paymentStatus(verified)) return res.status(200).json({ received: true, verified: false });
      const result = await grantEntitlement(order.id, verified);
      res.status(200).json({ received: true, ...result });
    } catch (error) { next(error); }
  });
  app.get('/api/premium/orders/:id/status', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query('SELECT id,status,provider_invoice_id,checkout_url,playlist_id,video_id FROM premium_playlist_orders WHERE id=$1 AND buyer_sub=$2', [req.params.id, req.auth.session.sub]);
      if (!result.rowCount) return res.status(404).json({ error: 'Order not found.' });
      const order = result.rows[0];
      if (order.status === 'pending' && order.provider_invoice_id && NOGORPAY_KEY) { const verified = await verifyNogorOrder(order).catch(() => null); if (verified && paymentStatus(verified)) await grantEntitlement(order.id, verified); }
      const fresh = await pool.query('SELECT status,playlist_id,video_id FROM premium_playlist_orders WHERE id=$1', [req.params.id]);
      res.json({ status:fresh.rows[0].status, contentType:fresh.rows[0].video_id?'video':'playlist', contentId:fresh.rows[0].video_id||fresh.rows[0].playlist_id, owned:fresh.rows[0].status==='paid' });
    } catch (error) { next(error); }
  });

  app.get('/api/creator/premium', requireAuth, requireChannel, async (req, res, next) => {
    try {
      const sub=req.auth.session.sub;
      const [sales,playlists,videos,ledger,withdrawals]=await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS sold,COALESCE(SUM(amount_bdt),0)::numeric AS gross,COALESCE(SUM(creator_earning_bdt),0)::numeric AS creator,COALESCE(SUM(platform_fee_bdt),0)::numeric AS fees FROM premium_playlist_orders WHERE status='paid' AND (playlist_id IN(SELECT id FROM playlists WHERE owner_sub=$1) OR video_id IN(SELECT id FROM videos WHERE owner_sub=$1))`,[sub]),
        pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,COUNT(DISTINCT i.video_id)::bigint AS videos_count,COUNT(DISTINCT i.video_id) FILTER(WHERE i.is_preview)::bigint AS preview_count,(SELECT COUNT(*)::bigint FROM premium_playlist_orders so WHERE so.playlist_id=p.id AND so.status='paid') AS sold,(SELECT COALESCE(SUM(so.amount_bdt),0)::numeric FROM premium_playlist_orders so WHERE so.playlist_id=p.id AND so.status='paid') AS gross,COALESCE(JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id',v.id,'title',v.title,'preview',i.is_preview,'public',v.visibility='Public')) FILTER(WHERE v.id IS NOT NULL),'[]'::jsonb) AS playlist_videos FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id LEFT JOIN videos v ON v.id=i.video_id WHERE p.owner_sub=$1 AND p.is_creator_playlist=TRUE GROUP BY p.id ORDER BY p.updated_at DESC`,[sub]),
        pool.query(`SELECT v.id,v.title,v.price_bdt,v.is_premium,v.visibility,v.created_at,(SELECT COUNT(*)::bigint FROM premium_playlist_orders so WHERE so.video_id=v.id AND so.status='paid') AS sold,(SELECT COALESCE(SUM(so.amount_bdt),0)::numeric FROM premium_playlist_orders so WHERE so.video_id=v.id AND so.status='paid') AS gross FROM videos v WHERE v.owner_sub=$1 GROUP BY v.id ORDER BY v.created_at DESC LIMIT 200`,[sub]),
        pool.query(`SELECT COALESCE(SUM(amount_bdt),0)::numeric AS earned FROM creator_wallet_ledger WHERE creator_sub=$1`,[sub]),
        pool.query(`SELECT COALESCE(SUM(amount_bdt) FILTER(WHERE status IN('pending','approved','paid')),0)::numeric AS reserved FROM creator_withdrawal_requests WHERE creator_sub=$1`,[sub])
      ]);
      const paidOrders=await pool.query(`SELECT o.id,o.amount_bdt,o.creator_earning_bdt,o.created_at,COALESCE(p.name,v.title) AS content_name,o.video_id,u.email FROM premium_playlist_orders o LEFT JOIN playlists p ON p.id=o.playlist_id LEFT JOIN videos v ON v.id=o.video_id JOIN app_users u ON u.google_sub=o.buyer_sub WHERE o.status='paid' AND COALESCE(p.owner_sub,v.owner_sub)=$1 ORDER BY o.created_at DESC LIMIT 50`,[sub]);
      const s=sales.rows[0]||{},balance=money(Number(ledger.rows[0]?.earned||0)-Number(withdrawals.rows[0]?.reserved||0));
      res.set('Cache-Control','private, no-store');
      res.json({summary:{sold:Number(s.sold)||0,grossBdt:Number(s.gross)||0,creatorEarningsBdt:Number(s.creator)||0,platformFeesBdt:Number(s.fees)||0,availableBdt:Math.max(0,balance)},
        playlists:playlists.rows.map(p=>({id:p.id,name:p.name,description:p.description,priceBdt:Number(p.price_bdt)||0,isPremium:Boolean(p.is_premium),isPublic:Boolean(p.is_public),videosCount:Number(p.videos_count)||0,previewCount:Number(p.preview_count)||0,sold:Number(p.sold)||0,grossBdt:Number(p.gross)||0,videos:p.playlist_videos||[]})),
        videos:videos.rows.map(v=>({id:v.id,title:v.title,priceBdt:Number(v.price_bdt)||0,isPremium:Boolean(v.is_premium),visibility:v.visibility,sold:Number(v.sold)||0,grossBdt:Number(v.gross)||0})),
        orders:paidOrders.rows.map(o=>({id:o.id,contentType:o.video_id?'video':'playlist',playlistName:o.content_name,amountBdt:Number(o.amount_bdt)||0,creatorEarningBdt:Number(o.creator_earning_bdt)||0,createdAt:o.created_at,buyer:o.email?o.email.replace(/^(.{2}).*(@.*)$/,'$1•••$2'):'Viewer'}))});
    } catch(error){next(error);}
  });
  app.get('/api/creator/wallet', requireAuth, requireChannel, async(req,res,next)=>{
    try{
      const sub=req.auth.session.sub;
      const [earned,withdrawn,requests]=await Promise.all([
        pool.query('SELECT COALESCE(SUM(amount_bdt),0)::numeric AS total FROM creator_wallet_ledger WHERE creator_sub=$1',[sub]),
        pool.query("SELECT COALESCE(SUM(amount_bdt),0)::numeric AS total FROM creator_withdrawal_requests WHERE creator_sub=$1 AND status IN('pending','approved','paid')",[sub]),
        pool.query('SELECT id,amount_bdt,payout_method,status,decision_note,created_at,reviewed_at,paid_at FROM creator_withdrawal_requests WHERE creator_sub=$1 ORDER BY created_at DESC LIMIT 50',[sub])
      ]);
      res.set('Cache-Control','private, no-store');res.json({earnedBdt:money(earned.rows[0].total),reservedBdt:money(withdrawn.rows[0].total),availableBdt:Math.max(0,money(Number(earned.rows[0].total)-Number(withdrawn.rows[0].total))),withdrawals:requests.rows.map(r=>({id:r.id,amountBdt:Number(r.amount_bdt),payoutMethod:r.payout_method,status:r.status,decisionNote:r.decision_note,createdAt:r.created_at,reviewedAt:r.reviewed_at,paidAt:r.paid_at}))});
    }catch(error){next(error);}
  });
  app.post('/api/creator/withdrawals', requireAuth, requireActive, requireChannel, async(req,res,next)=>{
    try{
      const amount=Number(req.body?.amountBdt),method=String(req.body?.payoutMethod||''),name=String(req.body?.accountName||'').trim().slice(0,120),account=String(req.body?.accountNumber||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,100);
      if(!Number.isFinite(amount)||amount<=0||amount>1000000||!['bkash','nagad','bank'].includes(method)||name.length<2||account.length<6)return res.status(400).json({error:'Amount, payout method, account name, and valid destination details দিন।'});
      const ciphertext=encryptPayoutDetails({accountName:name,accountNumber:account});
      const result=await withTransaction(async client=>{
        await client.query('SELECT sub FROM profiles WHERE sub=$1 FOR UPDATE',[req.auth.session.sub]);
        const balance=await client.query(`SELECT (COALESCE((SELECT SUM(amount_bdt) FROM creator_wallet_ledger WHERE creator_sub=$1),0)-COALESCE((SELECT SUM(amount_bdt) FROM creator_withdrawal_requests WHERE creator_sub=$1 AND status IN('pending','approved','paid')),0))::numeric AS available`,[req.auth.session.sub]);
        if(amount>Number(balance.rows[0]?.available||0))throw Object.assign(new Error('Withdrawal amount exceeds your available balance.'),{status:409});
        const id=crypto.randomUUID();await client.query(`INSERT INTO creator_withdrawal_requests(id,creator_sub,amount_bdt,payout_method,payout_details_ciphertext) VALUES($1,$2,$3,$4,$5)`,[id,req.auth.session.sub,money(amount),method,ciphertext]);
        return {id,amountBdt:money(amount),status:'pending'};
      });
      res.status(201).json({withdrawal:result});
    }catch(error){next(error);}
  });

  app.patch('/api/creator/premium/playlists/:id', requireAuth, requireActive, requireChannel, async (req,res,next)=>{
    try{
      if(!validUuid(req.params.id))return res.status(400).json({error:'Invalid playlist id.'});
      const premium=Boolean(req.body?.isPremium),price=Number(req.body?.priceBdt),previewIds=Array.isArray(req.body?.previewVideoIds)?[...new Set(req.body.previewVideoIds.map(String))].slice(0,100):null;
      if(premium&&(!Number.isFinite(price)||price<=0||price>1000000))return res.status(400).json({error:'Premium price 1 থেকে 1,000,000 BDT-এর মধ্যে দিন।'});
      if(premium){const visible=await pool.query('SELECT 1 FROM playlists WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE AND is_public=TRUE',[req.params.id,req.auth.session.sub]);if(!visible.rowCount)return res.status(400).json({error:'Premium series বিক্রির জন্য creator playlist Public হতে হবে।'});}
      const result=await withTransaction(async client=>{
        const updated=await client.query(`UPDATE playlists SET is_premium=$3,price_bdt=$4,updated_at=NOW() WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE RETURNING id,name,is_premium,price_bdt`,[req.params.id,req.auth.session.sub,premium,premium?price.toFixed(2):'0']);
        if(!updated.rowCount)return null;
        if(previewIds){
          const valid=await client.query(`SELECT i.video_id FROM playlist_items i JOIN videos v ON v.id=i.video_id WHERE i.playlist_id=$1 AND i.video_id=ANY($2::text[]) AND v.visibility='Public' AND v.moderation_status='active'`,[req.params.id,previewIds]);
          if(valid.rowCount!==previewIds.length)throw Object.assign(new Error('Free preview videos must be active Public videos inside this playlist.'),{status:400});
          await client.query('UPDATE playlist_items SET is_preview=(video_id=ANY($2::text[])) WHERE playlist_id=$1',[req.params.id,previewIds]);
        }
        return updated.rows[0];
      });
      if(!result)return res.status(404).json({error:'Creator playlist not found.'});
      res.json({playlist:{id:result.id,name:result.name,isPremium:Boolean(result.is_premium),priceBdt:Number(result.price_bdt)||0}});
    }catch(error){next(error);}
  });
  app.patch('/api/creator/premium/videos/:id',requireAuth,requireActive,requireChannel,async(req,res,next)=>{
    try{
      const premium=Boolean(req.body?.isPremium),price=Number(req.body?.priceBdt);
      if(premium&&(!Number.isFinite(price)||price<=0||price>1000000))return res.status(400).json({error:'Premium price 1 থেকে 1,000,000 BDT-এর মধ্যে দিন।'});
      if(premium){
        const visibility=await pool.query('SELECT visibility FROM videos WHERE id=$1 AND owner_sub=$2',[req.params.id,req.auth.session.sub]);
        if(!visibility.rowCount)return res.status(404).json({error:'Creator video not found.'});
        if(visibility.rows[0].visibility!=='Public')return res.status(400).json({error:'Premium video publish করতে visibility Public করুন।'});
      }
      const result=await pool.query(`UPDATE videos SET is_premium=$3,price_bdt=$4 WHERE id=$1 AND owner_sub=$2 RETURNING id,title,is_premium,price_bdt`,[req.params.id,req.auth.session.sub,premium,premium?price.toFixed(2):'0']);
      if(!result.rowCount)return res.status(404).json({error:'Creator video not found.'});
      res.json({video:{id:result.rows[0].id,title:result.rows[0].title,isPremium:Boolean(result.rows[0].is_premium),priceBdt:Number(result.rows[0].price_bdt)||0}});
    }catch(error){next(error);}
  });
};
