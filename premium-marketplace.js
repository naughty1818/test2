'use strict';

const crypto = require('crypto');

const NOGORPAY_BASE = String(process.env.NOGORPAY_API_BASE || 'https://api.nogorpay.com/api/v1').replace(/\/$/, '');
const NOGORPAY_KEY = process.env.NOGORPAY_API_KEY || '';
const NOGORPAY_BRAND = process.env.NOGORPAY_BRAND_ID || '8ETVNX';
const NOGORPAY_WEBHOOK = process.env.NOGORPAY_WEBHOOK_URL || '';

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
  const premiumRow = row => ({
    id: row.id, name: row.name, description: row.description || '', priceBdt: Number(row.price_bdt) || 0,
    isPremium: Boolean(row.is_premium), isPublic: Boolean(row.is_public), videosCount: Number(row.videos_count) || 0,
    creatorName: row.display_name || row.google_name || 'Creator', handle: row.handle || '', avatarUrl: row.avatar_url || null,
    updatedAt: row.updated_at, owned: Boolean(row.owned)
  });
  async function nogorRequest(path, options = {}) {
    if (!NOGORPAY_KEY) throw Object.assign(new Error('NogorPay integration is not configured on the server.'), { status: 503 });
    const response = await fetch(`${NOGORPAY_BASE}${path}`, { ...options, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'NOGORPAY-API-KEY': NOGORPAY_KEY, ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw Object.assign(new Error(body.message || body.error || `NogorPay request failed (${response.status}).`), { status: 502 });
    return body;
  }
  async function verifyNogorOrder(order) {
    if (!order.provider_invoice_id) return null;
    const body = await nogorRequest(`/charge/verify/${encodeURIComponent(order.provider_invoice_id)}`, { method: 'GET' });
    return body;
  }
  async function grantEntitlement(orderId, providerPayload) {
    return withTransaction(async client => {
      const orderResult = await client.query('SELECT o.*,p.price_bdt FROM premium_playlist_orders o JOIN playlists p ON p.id=o.playlist_id WHERE o.id=$1 FOR UPDATE', [orderId]);
      if (!orderResult.rowCount) return { ok: false, reason: 'order_not_found' };
      const order = orderResult.rows[0];
      const receivedAmount = amountFrom(providerPayload);
      if (receivedAmount && Math.abs(receivedAmount - Number(order.amount_bdt)) > 0.009) return { ok: false, reason: 'amount_mismatch' };
      if (order.status === 'paid') return { ok: true, alreadyPaid: true };
      await client.query(`UPDATE premium_playlist_orders SET status='paid',paid_at=COALESCE(paid_at,NOW()),verified_at=NOW(),provider_reference=COALESCE($2,provider_reference) WHERE id=$1`, [orderId, String(extractData(providerPayload).transaction_id || extractData(providerPayload).payment_id || '') || null]);
      await client.query('INSERT INTO premium_playlist_entitlements(playlist_id,buyer_sub,order_id) VALUES($1,$2,$3) ON CONFLICT (playlist_id,buyer_sub) DO NOTHING', [order.playlist_id, order.buyer_sub, order.id]);
      return { ok: true };
    });
  }

  app.get('/api/premium/playlists', async (req, res, next) => {
    try {
      const auth = req.auth || await loadSession(req);
      const result = await pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,
        COUNT(i.video_id)::bigint AS videos_count,pr.display_name,pr.handle,pr.avatar_url,u.google_name,
        EXISTS(SELECT 1 FROM premium_playlist_entitlements e WHERE e.playlist_id=p.id AND e.buyer_sub=$1) AS owned
        FROM playlists p JOIN app_users u ON u.google_sub=p.owner_sub LEFT JOIN profiles pr ON pr.sub=p.owner_sub
        LEFT JOIN playlist_items i ON i.playlist_id=p.id
        WHERE p.is_creator_playlist=TRUE AND p.is_premium=TRUE AND p.is_public=TRUE AND u.account_status='active'
        GROUP BY p.id,pr.display_name,pr.handle,pr.avatar_url,u.google_name ORDER BY p.updated_at DESC LIMIT 100`, [auth?.session?.sub || '']);
      res.json({ playlists: result.rows.map(premiumRow) });
    } catch (error) { next(error); }
  });

  app.get('/api/premium/playlists/:id', async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid premium playlist id.' });
      const auth = req.auth || await loadSession(req);
      const found = await pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,
        COUNT(i.video_id)::bigint AS videos_count,pr.display_name,pr.handle,pr.avatar_url,u.google_name,
        EXISTS(SELECT 1 FROM premium_playlist_entitlements e WHERE e.playlist_id=p.id AND e.buyer_sub=$2) AS owned,
        p.owner_sub=$2 AS is_owner
        FROM playlists p JOIN app_users u ON u.google_sub=p.owner_sub LEFT JOIN profiles pr ON pr.sub=p.owner_sub
        LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.id=$1 AND p.is_creator_playlist=TRUE AND p.is_premium=TRUE
        GROUP BY p.id,pr.display_name,pr.handle,pr.avatar_url,u.google_name`, [req.params.id, auth?.session?.sub || '']);
      if (!found.rowCount || (!found.rows[0].is_public && !found.rows[0].is_owner)) return res.status(404).json({ error: 'Premium playlist not found.' });
      const row = found.rows[0], canAccess = Boolean(row.owned || row.is_owner);
      const videos = await pool.query(`SELECT v.id,v.title,v.description,v.category,v.duration_seconds,v.thumbnail_object_name,v.views_count
        FROM playlist_items i JOIN videos v ON v.id=i.video_id WHERE i.playlist_id=$1 ORDER BY i.position,i.added_at`, [req.params.id]);
      res.json({ playlist: premiumRow(row), canAccess, isOwner: Boolean(row.is_owner), videos: canAccess ? videos.rows.map(v => ({ id:v.id,title:v.title,description:v.description,category:v.category,durationSeconds:Number(v.duration_seconds)||0,views:Number(v.views_count)||0,thumbnailUrl:v.thumbnail_object_name?`/api/videos/${encodeURIComponent(v.id)}/thumbnail`:null })) : videos.rows.slice(0, 1).map(v => ({ id:v.id,title:v.title,category:v.category,durationSeconds:Number(v.duration_seconds)||0,views:Number(v.views_count)||0,preview:true })) });
    } catch (error) { next(error); }
  });

  app.post('/api/premium/playlists/:id/purchase', requireAuth, requireActive, async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid premium playlist id.' });
      if (!NOGORPAY_KEY || !NOGORPAY_BRAND) return res.status(503).json({ error: 'NogorPay checkout is not configured yet.' });
      const phone = String(req.body?.customerPhone || '').replace(/[^0-9+]/g, '').slice(0, 20);
      if (phone.length < 8) return res.status(400).json({ error: 'NogorPay checkout-এর জন্য valid customer phone দিন।' });
      const buyer = req.auth.session.sub;
      const result = await pool.query('SELECT id,owner_sub,price_bdt,is_premium,is_public,name FROM playlists WHERE id=$1 AND is_creator_playlist=TRUE', [req.params.id]);
      if (!result.rowCount || !result.rows[0].is_premium || !result.rows[0].is_public) return res.status(404).json({ error: 'Premium playlist not found.' });
      const item = result.rows[0];
      if (item.owner_sub === buyer) return res.json({ owned: true, message: 'Creator access granted.' });
      const existing = await pool.query("SELECT id,status,checkout_url FROM premium_playlist_orders WHERE playlist_id=$1 AND buyer_sub=$2 AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1", [req.params.id, buyer]);
      if (existing.rows[0]?.status === 'paid') return res.json({ owned: true, orderId: existing.rows[0].id, message: 'এই playlist আগে থেকেই কেনা আছে।' });
      if (existing.rows[0]?.checkout_url) return res.json({ pending: true, orderId: existing.rows[0].id, paymentUrl: existing.rows[0].checkout_url });
      const orderId = crypto.randomUUID(), externalOrderId = publicOrderId(orderId);
      await pool.query(`INSERT INTO premium_playlist_orders(id,playlist_id,buyer_sub,amount_bdt,status,payment_provider,provider_reference,payment_method) VALUES($1,$2,$3,$4,'pending','nogorpay',$5,$6)`, [orderId, req.params.id, buyer, item.price_bdt, externalOrderId, String(req.body?.paymentMethod || '').slice(0, 40) || null]);
      const origin = String(process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const webhookUrl = NOGORPAY_WEBHOOK || (origin ? `${origin}/api/nogorpay/webhook` : '');
      if (!webhookUrl) return res.status(503).json({ error: 'Set APP_ORIGIN or NOGORPAY_WEBHOOK_URL before starting NogorPay checkout.' });
      const body = await nogorRequest('/charge/create', { method: 'POST', body: JSON.stringify({ order_id: externalOrderId, amount: Number(item.price_bdt), customer_phone: phone, customer_email: req.auth.session.email, customer_name: req.auth.session.name || 'Atharo viewer', brand_id: NOGORPAY_BRAND, payment_method: req.body?.paymentMethod || undefined, webhook_url: webhookUrl, redirect_url: `${origin}/premium/${encodeURIComponent(req.params.id)}?payment=return&order_id=${encodeURIComponent(orderId)}`, cancel_url: `${origin}/premium/${encodeURIComponent(req.params.id)}?payment=cancelled` }) });
      const data = extractData(body), paymentUrl = data.payment_url || data.paymentUrl || body.payment_url, invoiceId = data.invoice_id || data.invoiceId || body.invoice_id;
      if (!paymentUrl || !invoiceId) throw Object.assign(new Error('NogorPay did not return a checkout URL or invoice id.'), { status: 502 });
      await pool.query('UPDATE premium_playlist_orders SET provider_invoice_id=$2,checkout_url=$3 WHERE id=$1', [orderId, invoiceId, paymentUrl]);
      res.status(201).json({ pending: true, orderId, invoiceId, paymentUrl, amountBdt: Number(item.price_bdt), paymentProvider: 'nogorpay' });
    } catch (error) { next(error); }
  });

  app.post('/api/nogorpay/webhook', async (req, res, next) => {
    try {
      const payload = req.body || {}, data = extractData(payload), externalOrder = data.order_id || payload.order_id;
      const invoiceId = invoiceFrom(payload);
      let orderResult = externalOrder ? await pool.query('SELECT * FROM premium_playlist_orders WHERE provider_reference=$1 LIMIT 1', [externalOrder]) : { rowCount: 0, rows: [] };
      if (!orderResult.rowCount && invoiceId) orderResult = await pool.query('SELECT * FROM premium_playlist_orders WHERE provider_invoice_id=$1', [invoiceId]);
      if (!orderResult.rowCount) return res.status(200).json({ received: true, matched: false });
      const order = orderResult.rows[0];
      const verified = await verifyNogorOrder(order).catch(() => payload);
      if (!paymentStatus(verified) && !paymentStatus(payload)) return res.status(200).json({ received: true, verified: false });
      const result = await grantEntitlement(order.id, verified);
      res.status(200).json({ received: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/premium/orders/:id/status', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query('SELECT id,status,provider_invoice_id,checkout_url,playlist_id FROM premium_playlist_orders WHERE id=$1 AND buyer_sub=$2', [req.params.id, req.auth.session.sub]);
      if (!result.rowCount) return res.status(404).json({ error: 'Order not found.' });
      const order = result.rows[0];
      if (order.status === 'pending' && order.provider_invoice_id && NOGORPAY_KEY) {
        const verified = await verifyNogorOrder(order).catch(() => null);
        if (verified && paymentStatus(verified)) await grantEntitlement(order.id, verified);
      }
      const fresh = await pool.query('SELECT status,playlist_id FROM premium_playlist_orders WHERE id=$1', [req.params.id]);
      res.json({ status:fresh.rows[0].status, playlistId:fresh.rows[0].playlist_id, owned:fresh.rows[0].status==='paid' });
    } catch (error) { next(error); }
  });

  app.get('/api/creator/premium', requireAuth, requireChannel, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const [summary, playlists, orders] = await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS sold,COALESCE(SUM(o.amount_bdt),0)::numeric AS gross,COALESCE(SUM(o.amount_bdt*0.8),0)::numeric AS creator FROM premium_playlist_orders o JOIN playlists p ON p.id=o.playlist_id WHERE p.owner_sub=$1 AND o.status='paid'`, [sub]),
        pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,COUNT(DISTINCT i.video_id)::bigint AS videos_count,COUNT(DISTINCT o.id) FILTER (WHERE o.status='paid')::bigint AS sold,COALESCE(SUM(DISTINCT o.amount_bdt) FILTER (WHERE o.status='paid'),0)::numeric AS gross FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id LEFT JOIN premium_playlist_orders o ON o.playlist_id=p.id WHERE p.owner_sub=$1 AND p.is_creator_playlist=TRUE GROUP BY p.id ORDER BY p.updated_at DESC`, [sub]),
        pool.query(`SELECT o.id,o.amount_bdt,o.created_at,p.name,u.email FROM premium_playlist_orders o JOIN playlists p ON p.id=o.playlist_id JOIN app_users u ON u.google_sub=o.buyer_sub WHERE p.owner_sub=$1 AND o.status='paid' ORDER BY o.created_at DESC LIMIT 50`, [sub])
      ]);
      const s = summary.rows[0] || {};
      res.set('Cache-Control', 'private, no-store');
      res.json({ summary: { sold:Number(s.sold)||0,grossBdt:Number(s.gross)||0,creatorEstimateBdt:Number(s.creator)||0,sharePercent:80 }, playlists:playlists.rows.map(p=>({id:p.id,name:p.name,description:p.description,priceBdt:Number(p.price_bdt)||0,isPremium:Boolean(p.is_premium),isPublic:Boolean(p.is_public),videosCount:Number(p.videos_count)||0,sold:Number(p.sold)||0,grossBdt:Number(p.gross)||0})), orders:orders.rows.map(o=>({id:o.id,playlistName:o.name,amountBdt:Number(o.amount_bdt)||0,createdAt:o.created_at,buyer:o.email?o.email.replace(/^(.{2}).*(@.*)$/,'$1•••$2'):'Viewer'})) });
    } catch (error) { next(error); }
  });

  app.patch('/api/creator/premium/playlists/:id', requireAuth, requireActive, requireChannel, async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid playlist id.' });
      const premium = Boolean(req.body?.isPremium), price = Number(req.body?.priceBdt);
      if (premium && (!Number.isFinite(price) || price <= 0 || price > 1000000)) return res.status(400).json({ error: 'Premium price 1 থেকে 1,000,000 BDT-এর মধ্যে দিন।' });
      const result = await pool.query(`UPDATE playlists SET is_premium=$3,price_bdt=$4,updated_at=NOW() WHERE id=$1 AND owner_sub=$2 AND is_creator_playlist=TRUE RETURNING id,name,is_premium,price_bdt`, [req.params.id, req.auth.session.sub, premium, premium ? price.toFixed(2) : '0']);
      if (!result.rowCount) return res.status(404).json({ error: 'Creator playlist not found.' });
      res.json({ playlist: { id:result.rows[0].id,name:result.rows[0].name,isPremium:Boolean(result.rows[0].is_premium),priceBdt:Number(result.rows[0].price_bdt)||0 } });
    } catch (error) { next(error); }
  });
};
