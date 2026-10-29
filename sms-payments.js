'use strict';

const crypto = require('crypto');

const PHONE_RE = /^01[3-9]\d{8}$/;
const TRX_RE = /^[A-Z0-9]{6,15}$/;
const PROVIDERS = new Set(['bkash', 'nagad']);
const RECEIVED_WORDS = /(?:you\s+have\s+received|money\s+received|payment\s+received|received\s+money)/i;
const NEGATIVE_WORDS = /(?:cash\s*in|cash\s*out|send\s+money|money\s+sent|sent\s+to|otp|verification\s+code|cashback|offer|promo|প্রচার|টাকা\s*পাঠানো)/i;
const cleanText = value => String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
const amount = value => Number(String(value || '').replace(/,/g, ''));

function normalizePhone(value) {
  let phone = String(value || '').replace(/[\s-]/g, '');
  if (phone.startsWith('+88')) phone = phone.slice(3);
  else if (phone.startsWith('88')) phone = phone.slice(2);
  return phone;
}

function bangladeshDateToUtc(value) {
  const match = String(value || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match.map(Number);
  const localUtcMillis = Date.UTC(yyyy, mm - 1, dd, hh, min);
  return new Date(localUtcMillis - 6 * 60 * 60 * 1000);
}

// Keep provider/message shapes here. Real samples can update these templates without changing routes.
const SMS_TEMPLATES = {
  bkash: [
    { name: 'received-from-phone', pattern: /you\s+have\s+received\s+Tk\s+(?<amount>[\d,]+(?:\.\d{1,2})?)\s+from\s+(?<phone>(?:\+?88)?01[3-9]\d{8})(?:[\s\S]*?\bRef\s*[:.]?\s*(?<reference>[A-Z0-9_-]+))?[\s\S]*?Balance\s+Tk\s+(?<balance>[\d,]+(?:\.\d{1,2})?)[\s\S]*?TrxID\s*[:.]?\s*(?<trxId>[A-Z0-9]{6,15})[\s\S]*?at\s+(?<receivedAt>\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i },
    { name: 'received-deposit', pattern: /you\s+have\s+received\s+deposit[\s\S]*?Tk\s+(?<amount>[\d,]+(?:\.\d{1,2})?)[\s\S]*?Balance\s+Tk\s+(?<balance>[\d,]+(?:\.\d{1,2})?)[\s\S]*?TrxID\s*[:.]?\s*(?<trxId>[A-Z0-9]{6,15})[\s\S]*?at\s+(?<receivedAt>\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i }
  ],
  nagad: [
    { name: 'money-received', pattern: /money\s+received[\s\S]*?amount\s*:\s*Tk\s*(?<amount>[\d,]+(?:\.\d{1,2})?)[\s\S]*?sender\s*:\s*(?<phone>(?:\+?88)?01[3-9]\d{8})[\s\S]*?txnid\s*[:.]?\s*(?<trxId>[A-Z0-9]{6,15})[\s\S]*?(?:balance\s*:\s*Tk\s*(?<balance>[\d,]+(?:\.\d{1,2})?))?[\s\S]*?(?<receivedAt>\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i }
  ]
};

function parseSms(sender, body) {
  const provider = String(sender || '').toLowerCase().includes('bkash') ? 'bkash' : String(sender || '').toLowerCase().includes('nagad') ? 'nagad' : null;
  if (!provider) return null;
  const text = cleanText(body);
  if (!text || NEGATIVE_WORDS.test(text) || !RECEIVED_WORDS.test(text)) return null;
  for (const template of SMS_TEMPLATES[provider]) {
    const match = template.pattern.exec(text);
    if (!match?.groups) continue;
    const trxId = String(match.groups.trxId || '').toUpperCase();
    const senderPhone = normalizePhone(match.groups.phone);
    const amountBdt = amount(match.groups.amount);
    const receivedAt = bangladeshDateToUtc(match.groups.receivedAt);
    if (!TRX_RE.test(trxId) || (senderPhone && !PHONE_RE.test(senderPhone)) || (!senderPhone && template.name !== 'received-deposit') || !Number.isFinite(amountBdt) || amountBdt <= 0 || !receivedAt) continue;
    return { provider, template: template.name, trxId, senderPhone, amountBdt: Number(amountBdt.toFixed(2)), balanceBdt: match.groups.balance ? Number(amount(match.groups.balance).toFixed(2)) : null, receivedAt };
  }
  return null;
}

function timingSafeApiKey(expected, supplied) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(supplied || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function attachSmsPayments({ app, pool, withTransaction, requireAuth, requireActive, loadSession, notifyAdmin }) {
  const apiKey = process.env.SMS_WEBHOOK_API_KEY || '';
  const windowHours = Math.max(1, Number(process.env.SMS_PAYMENT_WINDOW_HOURS || 24));
  const ownerOnly = String(process.env.SMS_MANUAL_OWNER_ONLY || 'false').toLowerCase() === 'true';
  const receiverPayload = () => ({ bkash: process.env.PAYMENT_RECEIVER_BKASH || '', nagad: process.env.PAYMENT_RECEIVER_NAGAD || '' });
  const authAdmin = (...roles) => async (req, res, next) => {
    try {
      req.auth = req.auth || await loadSession(req);
      if (!req.auth?.session?.emailVerified) return res.status(401).json({ error: 'লগইন আবশ্যক।' });
      const email = String(req.auth.session.email || '').trim().toLowerCase();
      const owner = String(process.env.OWNER_EMAIL || '').trim().toLowerCase() === email;
      const row = owner ? { role: 'owner', permissions: ['*'] } : (await pool.query('SELECT role,permissions FROM admin_members WHERE email=$1', [email])).rows[0];
      if (!row || (!['owner', 'admin'].includes(row.role) && !(row.role === 'custom' && (row.permissions || []).includes('payments')))) return res.status(403).json({ error: 'এই কাজের অনুমতি নেই।' });
      if (ownerOnly && row.role !== 'owner' && req.method !== 'GET') return res.status(403).json({ error: 'শুধু Owner এই কাজটি করতে পারবেন।' });
      if (roles.length && !roles.includes(row.role) && row.role !== 'owner') return res.status(403).json({ error: 'এই কাজের অনুমতি নেই।' });
      req.admin = { ...row, email };
      next();
    } catch (error) { next(error); }
  };
  const suffix = value => String(value || '').slice(-4);
  const normalizeClaim = (kind, id) => ({ premium: 'premium', shop: 'shop', talent: 'talent' }[kind] ? String(kind) : null);

  async function completeOrder(client, kind, orderId, trxId) {
    if (kind === 'premium') {
      const found = await client.query(`SELECT o.*,COALESCE(p.owner_sub,v.owner_sub) AS creator_sub FROM premium_playlist_orders o LEFT JOIN playlists p ON p.id=o.playlist_id LEFT JOIN videos v ON v.id=o.video_id WHERE o.id=$1 FOR UPDATE OF o`, [orderId]);
      if (!found.rowCount) throw Object.assign(new Error('অর্ডার পাওয়া যায়নি।'), { status: 404 });
      const order = found.rows[0]; if (order.status === 'paid') return;
      const settings = (await client.query('SELECT video_commission_percent,playlist_commission_percent FROM platform_settings WHERE id=1')).rows[0] || {};
      const feePercent = Number(order.video_id ? settings.video_commission_percent ?? 20 : settings.playlist_commission_percent ?? 20);
      const gross = Number(order.amount_bdt), fee = Number((gross * feePercent / 100).toFixed(2)), creatorAmount = Number((gross - fee).toFixed(2));
      await client.query(`UPDATE premium_playlist_orders SET status='paid',payment_provider='sms_manual',paid_at=COALESCE(paid_at,NOW()),verified_at=NOW(),provider_reference=$2,platform_fee_percent=$3,platform_fee_bdt=$4,creator_earning_bdt=$5 WHERE id=$1`, [orderId, trxId, feePercent, fee, creatorAmount]);
      if (order.playlist_id) await client.query('INSERT INTO premium_playlist_entitlements(playlist_id,buyer_sub,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [order.playlist_id, order.buyer_sub, order.id]);
      else await client.query('INSERT INTO premium_video_entitlements(video_id,buyer_sub,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [order.video_id, order.buyer_sub, order.id]);
      await client.query(`INSERT INTO creator_wallet_ledger(id,creator_sub,order_id,amount_bdt,entry_type,description) VALUES($1,$2,$3,$4,'sale','Premium content sale') ON CONFLICT(order_id) DO NOTHING`, [crypto.randomUUID(), order.creator_sub, order.id, creatorAmount]);
      await client.query(`INSERT INTO creator_wallet_entries(id,creator_sub,source,source_ref,amount_bdt,description,metadata) VALUES($1,$2,'premium',$3,$4,'Premium content sale',jsonb_build_object('orderId',$5::text,'grossBdt',$6::numeric,'feeBdt',$7::numeric)) ON CONFLICT(source,source_ref) DO NOTHING`, [crypto.randomUUID(), order.creator_sub, 'premium:' + order.id, creatorAmount, order.id, gross, fee]);
    } else if (kind === 'shop') {
      const r = await client.query("UPDATE shop_orders SET payment_status='paid',payment_provider='sms_manual',paid_at=COALESCE(paid_at,NOW()),verified_at=NOW(),provider_reference=$2 WHERE id=$1 AND payment_status='pending' RETURNING id", [orderId, trxId]);
      if (!r.rowCount) { const existing = await client.query('SELECT payment_status FROM shop_orders WHERE id=$1', [orderId]); if (!existing.rowCount) throw Object.assign(new Error('অর্ডার পাওয়া যায়নি।'), { status: 404 }); }
    } else if (kind === 'talent') {
      const r = await client.query("UPDATE talent_orders SET status=CASE WHEN status='awaiting_payment' THEN 'in_progress' ELSE status END,paid_at=COALESCE(paid_at,NOW()),verified_at=NOW(),provider_reference=$2,updated_at=NOW() WHERE id=$1 AND status IN('awaiting_payment','in_progress','paid') RETURNING id", [orderId, trxId]);
      if (!r.rowCount) throw Object.assign(new Error('অর্ডারটি এখন পেমেন্টের জন্য প্রস্তুত নয়।'), { status: 409 });
      await client.query("INSERT INTO talent_order_events(order_id,actor_sub,event_type,details) VALUES($1,NULL,'payment_verified',$2) ON CONFLICT DO NOTHING", [orderId, 'SMS payment verified; work may begin.']);
    }
  }

  async function matchClaims(client, transaction) {
    const claims = await client.query(`SELECT c.*, CASE c.order_kind WHEN 'premium' THEN o.amount_bdt WHEN 'shop' THEN s.total_amount_bdt WHEN 'talent' THEN t.amount_bdt END AS order_amount, CASE c.order_kind WHEN 'premium' THEN o.created_at WHEN 'shop' THEN s.created_at WHEN 'talent' THEN t.created_at END AS order_created_at FROM sms_payment_claims c LEFT JOIN premium_playlist_orders o ON c.order_kind='premium' AND o.id=c.order_id LEFT JOIN shop_orders s ON c.order_kind='shop' AND s.id=c.order_id LEFT JOIN talent_orders t ON c.order_kind='talent' AND t.id=c.order_id WHERE c.status='pending' AND c.trx_id=$1 AND c.phone=$2 FOR UPDATE OF c`, [transaction.trx_id, transaction.sender_phone]);
    for (const claim of claims.rows) {
      if (Math.abs(Number(claim.order_amount) - Number(transaction.amount_bdt)) > 0.009 || new Date(transaction.received_at) < new Date(new Date(claim.order_created_at).getTime() - 10 * 60 * 1000)) continue;
      await client.query("UPDATE sms_transactions SET status='used',used_order_kind=$2,used_order_id=$3,used_at=NOW() WHERE id=$1 AND status='unused'", [transaction.id, claim.order_kind, claim.order_id]);
      await completeOrder(client, claim.order_kind, claim.order_id, transaction.trx_id);
      await client.query("UPDATE sms_payment_claims SET status='matched',attempts=attempts+1 WHERE id=$1", [claim.id]);
    }
  }

  app.post('/api/sms-webhook', async (req, res, next) => {
    const bearer = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const sender = String(req.body?.sender || req.body?.from || req.body?.address || '').slice(0, 120);
    const ipHash = crypto.createHash('sha256').update(String(req.ip || '')).digest('hex').slice(0, 16);
    if (!timingSafeApiKey(apiKey, req.get('x-api-key') || bearer)) { await pool.query("INSERT INTO sms_ingest_log(sender,outcome,created_at) VALUES($1,'bad_key',NOW())", [sender || ipHash]).catch(() => {}); return res.status(401).json({ error: 'অনুমতি নেই।' }); }
    try {
      const parsed = parseSms(sender, req.body?.body || req.body?.text);
      if (!parsed || !parsed.senderPhone) { await pool.query("INSERT INTO sms_ingest_log(sender,outcome) VALUES($1,'parse_failed')", [sender]); return res.json({ saved: false }); }
      const saved = await withTransaction(async client => {
        const inserted = await client.query(`INSERT INTO sms_transactions(provider,trx_id,sender_phone,amount_bdt,balance_bdt,received_at,source) VALUES($1,$2,$3,$4,$5,$6,'sms') ON CONFLICT(trx_id) DO NOTHING RETURNING *`, [parsed.provider, parsed.trxId, parsed.senderPhone, parsed.amountBdt, parsed.balanceBdt, parsed.receivedAt]);
        if (!inserted.rowCount) { await client.query("INSERT INTO sms_ingest_log(sender,outcome,trx_suffix) VALUES($1,'duplicate',$2)", [sender, suffix(parsed.trxId)]); return { saved: false, duplicate: true }; }
        await client.query("INSERT INTO sms_ingest_log(sender,outcome,trx_suffix) VALUES($1,'saved',$2)", [sender, suffix(parsed.trxId)]);
        await matchClaims(client, inserted.rows[0]); return { saved: true, trxId: parsed.trxId };
      });
      if (notifyAdmin) notifyAdmin('payments');
      res.json(saved);
    } catch (error) { next(error); }
  });

  app.post('/api/payments/sms/verify', requireAuth, requireActive, async (req, res, next) => {
    const orderKind = normalizeClaim(req.body?.orderKind, req.body?.orderId), orderId = String(req.body?.orderId || ''), phone = normalizePhone(req.body?.phone), trxId = String(req.body?.trxId || '').trim().toUpperCase();
    if (!orderKind || !orderId || !PHONE_RE.test(phone) || !TRX_RE.test(trxId)) return res.status(400).json({ error: 'বাংলাদেশি ফোন নম্বর ও সঠিক TrxID দিন।' });
    try {
      const result = await withTransaction(async client => {
        const table = { premium: 'premium_playlist_orders', shop: 'shop_orders', talent: 'talent_orders' }[orderKind];
        const ownerColumn = { premium: 'buyer_sub', shop: 'buyer_sub', talent: 'buyer_sub' }[orderKind];
        const amountColumn = { premium: 'amount_bdt', shop: 'total_amount_bdt', talent: 'amount_bdt' }[orderKind];
        const pending = { premium: "status='pending'", shop: "payment_status='pending'", talent: "status='awaiting_payment'" }[orderKind];
        const order = await client.query(`SELECT id,${amountColumn} AS amount,created_at FROM ${table} WHERE id=$1 AND ${ownerColumn}=$2 AND ${pending} FOR UPDATE`, [orderId, req.auth.session.sub]);
        if (!order.rowCount) return { ok: false, message: 'অর্ডারটি যাচাই করা যাচ্ছে না।' };
        const tx = await client.query('SELECT * FROM sms_transactions WHERE trx_id=$1 FOR UPDATE', [trxId]);
        const row = tx.rows[0], valid = row && row.status === 'unused' && row.sender_phone === phone && Math.abs(Number(row.amount_bdt) - Number(order.rows[0].amount)) < 0.01 && new Date(row.received_at) >= new Date(new Date(order.rows[0].created_at).getTime() - 10 * 60 * 1000) && new Date(row.received_at) >= new Date(Date.now() - windowHours * 60 * 60 * 1000);
        await client.query('INSERT INTO sms_payment_claims(order_kind,order_id,buyer_sub,phone,trx_id,status,attempts) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(order_kind,order_id,trx_id) DO UPDATE SET attempts=sms_payment_claims.attempts+1', [orderKind, orderId, req.auth.session.sub, phone, trxId, valid ? 'matched' : 'pending']);
        if (!valid) return { ok: false, message: 'লেনদেন এখনো পাওয়া যায়নি, ১–২ মিনিট পর আবার চেষ্টা করুন।' };
        await client.query('UPDATE sms_transactions SET status=\'used\',used_order_kind=$2,used_order_id=$3,used_at=NOW() WHERE id=$1 AND status=\'unused\'', [row.id, orderKind, orderId]);
        await completeOrder(client, orderKind, orderId, trxId);
        return { ok: true, orderId };
      });
      if (notifyAdmin) notifyAdmin('payments');
      res.status(result.ok ? 200 : 202).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/admin/sms-payments/summary', authAdmin(), async (req, res, next) => { try { const [last,day,week,counts,claims,sync] = await Promise.all([pool.query("SELECT MAX(received_at) AS at FROM sms_transactions"),pool.query("SELECT provider,COUNT(*)::int AS count,COALESCE(SUM(amount_bdt),0)::numeric AS amount FROM sms_transactions WHERE received_at>=CURRENT_DATE GROUP BY provider"),pool.query("SELECT provider,COUNT(*)::int AS count,COALESCE(SUM(amount_bdt),0)::numeric AS amount FROM sms_transactions WHERE received_at>=NOW()-INTERVAL '7 days' GROUP BY provider"),pool.query("SELECT status,COUNT(*)::int AS count FROM sms_transactions GROUP BY status"),pool.query("SELECT COUNT(*)::int AS count FROM sms_payment_claims WHERE status='pending'"),pool.query('SELECT MAX(received_at) AS at FROM sms_ingest_log')]); const lastSync=sync.rows[0].at; res.json({lastSuccessfulSms:last.rows[0].at,today:day.rows,sevenDays:week.rows,transactions:counts.rows,pendingClaims:claims.rows[0].count,lastSyncMinutes:lastSync?Math.floor((Date.now()-new Date(lastSync).getTime())/60000):null,stale:lastSync?((Date.now()-new Date(lastSync).getTime())/60000>Number(process.env.SMS_STALE_MINUTES||30)):true}); } catch(e){next(e);} });
  app.get('/api/admin/sms-payments/transactions', authAdmin(), async (req,res,next)=>{try{const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||30)),params=[],where=[];for(const [key,col] of [['provider','provider'],['status','status'],['source','source']])if(req.query[key]){params.push(String(req.query[key]));where.push(`${col}=$${params.length}`);}if(req.query.search){params.push('%'+String(req.query.search).slice(0,80)+'%');where.push(`(trx_id ILIKE $${params.length} OR sender_phone ILIKE $${params.length})`);}params.push(limit,(page-1)*limit);const r=await pool.query(`SELECT * FROM sms_transactions ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY received_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);res.json({transactions:r.rows,page,limit});}catch(e){next(e);}});
  app.get('/api/admin/sms-payments/claims', authAdmin(), async (req,res,next)=>{try{const r=await pool.query(`SELECT c.*,CASE c.order_kind WHEN 'premium' THEN o.amount_bdt WHEN 'shop' THEN s.total_amount_bdt WHEN 'talent' THEN t.amount_bdt END AS amount_bdt FROM sms_payment_claims c LEFT JOIN premium_playlist_orders o ON c.order_kind='premium' AND o.id=c.order_id LEFT JOIN shop_orders s ON c.order_kind='shop' AND s.id=c.order_id LEFT JOIN talent_orders t ON c.order_kind='talent' AND t.id=c.order_id WHERE c.status='pending' ORDER BY c.created_at ASC LIMIT 200`);res.json({claims:r.rows});}catch(e){next(e);}});
  app.post('/api/admin/sms-payments/transactions', authAdmin('admin'), async (req,res,next)=>{try{const provider=String(req.body?.provider||'').toLowerCase(),trxId=String(req.body?.trxId||'').trim().toUpperCase(),phone=normalizePhone(req.body?.senderPhone),amountBdt=Number(req.body?.amountBdt),note=String(req.body?.note||'').trim();if(!PROVIDERS.has(provider)||!TRX_RE.test(trxId)||!PHONE_RE.test(phone)||!Number.isFinite(amountBdt)||amountBdt<=0||note.length<10)return res.status(400).json({error:'Provider, ফোন, সঠিক TrxID, টাকার পরিমাণ এবং কমপক্ষে ১০ অক্ষরের কারণ দিন।'});const row=await pool.query(`INSERT INTO sms_transactions(provider,trx_id,sender_phone,amount_bdt,received_at,source,created_by,note) VALUES($1,$2,$3,$4,$5,'manual',$6,$7) ON CONFLICT(trx_id) DO NOTHING RETURNING *`,[provider,trxId,phone,amountBdt,req.body?.receivedAt||new Date(),req.auth.session.sub,note]);if(!row.rowCount)return res.status(409).json({error:'এই TrxID আগে থেকেই আছে।'});res.status(201).json({transaction:row.rows[0]});}catch(e){next(e);}});
  app.post('/api/admin/sms-payments/claims/:id/approve', authAdmin('admin'), async (req,res,next)=>{try{const note=String(req.body?.note||'').trim(),amountBdt=Number(req.body?.amountBdt);if(note.length<10)return res.status(400).json({error:'কমপক্ষে ১০ অক্ষরের কারণ দিন।'});const result=await withTransaction(async client=>{const c=await client.query(`SELECT c.*,CASE c.order_kind WHEN 'premium' THEN o.amount_bdt WHEN 'shop' THEN s.total_amount_bdt WHEN 'talent' THEN t.amount_bdt END AS order_amount FROM sms_payment_claims c LEFT JOIN premium_playlist_orders o ON c.order_kind='premium' AND o.id=c.order_id LEFT JOIN shop_orders s ON c.order_kind='shop' AND s.id=c.order_id LEFT JOIN talent_orders t ON c.order_kind='talent' AND t.id=c.order_id WHERE c.id=$1 FOR UPDATE`,[req.params.id]);if(!c.rowCount||c.rows[0].status!=='pending')throw Object.assign(new Error('এই আবেদনটি আর pending নেই।'),{status:409});const claim=c.rows[0];if(Math.abs(amountBdt-Number(claim.order_amount))>.009)throw Object.assign(new Error('অর্ডারের amount-এর সঙ্গে মিল নেই।'),{status:400});const tx=await client.query(`INSERT INTO sms_transactions(provider,trx_id,sender_phone,amount_bdt,received_at,status,used_order_kind,used_order_id,used_at,source,created_by,note) VALUES($1,$2,$3,$4,NOW(),'used',$5,$6,NOW(),'manual',$7,$8) ON CONFLICT(trx_id) DO NOTHING RETURNING id`,['bkash',claim.trx_id,claim.phone,amountBdt,claim.order_kind,claim.order_id,req.auth.session.sub,note]);if(!tx.rowCount)throw Object.assign(new Error('এই TrxID আগে থেকেই ব্যবহৃত হয়েছে।'),{status:409});await completeOrder(client,claim.order_kind,claim.order_id,claim.trx_id);await client.query("UPDATE sms_payment_claims SET status='matched',attempts=attempts+1 WHERE id=$1",[claim.id]);await client.query('INSERT INTO admin_audit_logs(actor_email,actor_role,action,target_type,target_id,reason,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[req.admin.email,req.admin.role,'sms_claim_approved','sms_payment_claim',claim.id,note,JSON.stringify({trxSuffix:suffix(claim.trx_id),amountBdt})]);return {ok:true};});res.json(result);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}});
  app.post('/api/admin/sms-payments/claims/:id/reject', authAdmin('admin'), async (req,res,next)=>{try{const note=String(req.body?.note||'').trim();if(note.length<10)return res.status(400).json({error:'কমপক্ষে ১০ অক্ষরের কারণ দিন।'});const r=await pool.query("UPDATE sms_payment_claims SET status='rejected',attempts=attempts+1 WHERE id=$1 AND status='pending' RETURNING id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Pending আবেদন পাওয়া যায়নি।'});res.json({ok:true,message:'যাচাই করা যায়নি, সাপোর্টে যোগাযোগ করুন।'});}catch(e){next(e);}});
}

module.exports = { attachSmsPayments, parseSms, SMS_TEMPLATES, normalizePhone, bangladeshDateToUtc };
