'use strict';

const crypto = require('crypto');

module.exports = function attachPremiumMarketplace({ app, pool, requireAuth, requireActive, requireChannel, loadSession, validUuid, safeText }) {
  const premiumRow = row => ({
    id: row.id, name: row.name, description: row.description || '', priceBdt: Number(row.price_bdt) || 0,
    isPremium: Boolean(row.is_premium), isPublic: Boolean(row.is_public), videosCount: Number(row.videos_count) || 0,
    creatorName: row.display_name || row.google_name || 'Creator', handle: row.handle || '', avatarUrl: row.avatar_url || null,
    updatedAt: row.updated_at, owned: Boolean(row.owned)
  });

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
      const row = found.rows[0];
      const canAccess = Boolean(row.owned || row.is_owner);
      const videos = await pool.query(`SELECT v.id,v.title,v.description,v.category,v.duration_seconds,v.thumbnail_object_name,v.views_count
        FROM playlist_items i JOIN videos v ON v.id=i.video_id WHERE i.playlist_id=$1 AND ($2::boolean OR v.owner_sub=$3) ORDER BY i.position,i.added_at`, [req.params.id, canAccess, auth?.session?.sub || '']);
      res.json({ playlist: premiumRow(row), canAccess, isOwner: Boolean(row.is_owner), videos: canAccess ? videos.rows.map(v => ({ id:v.id,title:v.title,description:v.description,category:v.category,durationSeconds:Number(v.duration_seconds)||0,views:Number(v.views_count)||0,thumbnailUrl:v.thumbnail_object_name?`/api/videos/${encodeURIComponent(v.id)}/thumbnail`:null })) : videos.rows.slice(0, 1).map(v => ({ id:v.id,title:v.title,category:v.category,durationSeconds:Number(v.duration_seconds)||0,views:Number(v.views_count)||0,preview:true })) });
    } catch (error) { next(error); }
  });

  app.post('/api/premium/playlists/:id/purchase', requireAuth, requireActive, async (req, res, next) => {
    try {
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid premium playlist id.' });
      const buyer = req.auth.session.sub;
      const result = await pool.query('SELECT id,owner_sub,price_bdt,is_premium,is_public FROM playlists WHERE id=$1 AND is_creator_playlist=TRUE', [req.params.id]);
      if (!result.rowCount || !result.rows[0].is_premium || !result.rows[0].is_public) return res.status(404).json({ error: 'Premium playlist not found.' });
      const item = result.rows[0];
      if (item.owner_sub === buyer) return res.json({ owned: true, message: 'Creator access granted.' });
      const existing = await pool.query("SELECT order_id FROM premium_playlist_entitlements WHERE playlist_id=$1 AND buyer_sub=$2", [req.params.id, buyer]);
      if (existing.rowCount) return res.json({ owned: true, orderId: existing.rows[0].order_id, message: 'এই playlist আগে থেকেই কেনা আছে।' });
      const orderId = crypto.randomUUID();
      await pool.query('BEGIN');
      try {
        await pool.query(`INSERT INTO premium_playlist_orders(id,playlist_id,buyer_sub,amount_bdt,status,payment_provider,provider_reference,paid_at) VALUES($1,$2,$3,$4,'paid','demo',$5,NOW())`, [orderId, req.params.id, buyer, item.price_bdt, `demo_${orderId.slice(0, 8)}`]);
        await pool.query('INSERT INTO premium_playlist_entitlements(playlist_id,buyer_sub,order_id) VALUES($1,$2,$3)', [req.params.id, buyer, orderId]);
        await pool.query('COMMIT');
      } catch (error) { await pool.query('ROLLBACK'); throw error; }
      res.status(201).json({ owned: true, orderId, amountBdt: Number(item.price_bdt), paymentProvider: 'demo', message: 'Demo checkout complete. Production payment gateway এখনো সংযুক্ত নয়।' });
    } catch (error) { next(error); }
  });

  app.get('/api/creator/premium', requireAuth, requireChannel, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const [summary, playlists, orders] = await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS sold,COALESCE(SUM(o.amount_bdt),0)::numeric AS gross,COALESCE(SUM(o.amount_bdt*0.8),0)::numeric AS creator FROM premium_playlist_orders o JOIN playlists p ON p.id=o.playlist_id WHERE p.owner_sub=$1 AND o.status='paid'`, [sub]),
        pool.query(`SELECT p.id,p.name,p.description,p.price_bdt,p.is_premium,p.is_public,p.updated_at,COUNT(i.video_id)::bigint AS videos_count,COUNT(o.id) FILTER (WHERE o.status='paid')::bigint AS sold,COALESCE(SUM(o.amount_bdt) FILTER (WHERE o.status='paid'),0)::numeric AS gross FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id LEFT JOIN premium_playlist_orders o ON o.playlist_id=p.id WHERE p.owner_sub=$1 AND p.is_creator_playlist=TRUE GROUP BY p.id ORDER BY p.updated_at DESC`, [sub]),
        pool.query(`SELECT o.id,o.amount_bdt,o.created_at,p.name,u.email FROM premium_playlist_orders o JOIN playlists p ON p.id=o.playlist_id JOIN app_users u ON u.google_sub=o.buyer_sub WHERE p.owner_sub=$1 AND o.status='paid' ORDER BY o.created_at DESC LIMIT 50`, [sub])
      ]);
      const s = summary.rows[0] || {};
      res.set('Cache-Control', 'private, no-store');
      res.json({ summary: { sold: Number(s.sold)||0, grossBdt:Number(s.gross)||0, creatorEstimateBdt:Number(s.creator)||0, sharePercent:80 }, playlists: playlists.rows.map(p => ({ id:p.id,name:p.name,description:p.description,priceBdt:Number(p.price_bdt)||0,isPremium:Boolean(p.is_premium),isPublic:Boolean(p.is_public),videosCount:Number(p.videos_count)||0,sold:Number(p.sold)||0,grossBdt:Number(p.gross)||0 })), orders: orders.rows.map(o => ({ id:o.id,playlistName:o.name,amountBdt:Number(o.amount_bdt)||0,createdAt:o.created_at,buyer:o.email ? o.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : 'Viewer' })) });
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
