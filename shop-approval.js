'use strict';

const crypto = require('crypto');

module.exports = function registerShopApproval({ app, pool, withTransaction, requireAuth, requireActive, safeText, validVideoId }) {
  const normalizeUrl = value => {
    const raw = safeText(value, 2048);
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch (_) { return null; }
  };
  const shape = row => row ? ({
    id: row.id,
    businessName: row.business_name,
    fullName: row.full_name,
    phone: row.phone,
    address: row.address,
    businessType: row.business_type,
    description: row.description,
    productTypes: row.product_types,
    socialUrl: row.social_url,
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at
  }) : null;

  app.get('/api/me/shop-application', requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id,business_name,full_name,phone,address,business_type,description,product_types,social_url,status,decision_note,created_at,reviewed_at
        FROM shop_applications WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 1`, [req.auth.session.sub]);
      const shop = await pool.query(`SELECT id,slug,business_name,status,approved_at FROM shops WHERE owner_sub=$1`, [req.auth.session.sub]);
      res.set('Cache-Control', 'private, no-store');
      res.json({ application: shape(result.rows[0]), shop: shop.rows[0] || null });
    } catch (error) { next(error); }
  });

  app.post('/api/me/shop-application', requireAuth, requireActive, async (req, res, next) => {
    try {
      const sub = req.auth.session.sub;
      const businessName = safeText(req.body?.businessName, 120);
      const fullName = safeText(req.body?.fullName, 120);
      const phone = safeText(req.body?.phone, 40);
      const address = safeText(req.body?.address, 500);
      const businessType = safeText(req.body?.businessType, 80);
      const description = safeText(req.body?.description, 2000);
      const productTypes = safeText(req.body?.productTypes, 500);
      const socialUrl = normalizeUrl(req.body?.socialUrl);
      if (businessName.length < 2) return res.status(400).json({ error: 'ব্যবসার নাম অন্তত ২ অক্ষরের হতে হবে।' });
      if (fullName.length < 2) return res.status(400).json({ error: 'পূর্ণ নাম দিন।' });
      if (phone.length < 6) return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন।' });
      if (address.length < 5) return res.status(400).json({ error: 'ব্যবসার ঠিকানা দিন।' });
      if (businessType.length < 2) return res.status(400).json({ error: 'ব্যবসার ধরন নির্বাচন করুন।' });
      if (description.length < 20) return res.status(400).json({ error: 'ব্যবসার বিবরণ অন্তত ২০ অক্ষরের হতে হবে।' });
      if (productTypes.length < 2) return res.status(400).json({ error: 'কী ধরনের পণ্য বিক্রি করবেন তা লিখুন।' });
      if (req.body?.socialUrl && !socialUrl) return res.status(400).json({ error: 'Social link অবশ্যই valid HTTPS URL হতে হবে।' });
      if ((await pool.query('SELECT 1 FROM shops WHERE owner_sub=$1 AND status=\'active\'', [sub])).rowCount) return res.status(409).json({ error: 'এই account-এর একটি approved shop ইতিমধ্যে আছে।' });
      const pending = await pool.query("SELECT id FROM shop_applications WHERE user_sub=$1 AND status='pending'", [sub]);
      if (pending.rowCount) return res.status(409).json({ error: 'আপনার Shop application এখনো review-এ আছে।' });
      const id = crypto.randomUUID();
      const saved = await pool.query(`INSERT INTO shop_applications
        (id,user_sub,business_name,full_name,phone,address,business_type,description,product_types,social_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id,business_name,full_name,phone,address,business_type,description,product_types,social_url,status,decision_note,created_at,reviewed_at`,
        [id,sub,businessName,fullName,phone,address,businessType,description,productTypes,socialUrl]);
      res.status(201).json({ application: shape(saved.rows[0]) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'আপনার একটি pending Shop application ইতিমধ্যে আছে।' });
      next(error);
    }
  });

  const productShape = row => ({
    id: row.id, name: row.name, description: row.description, priceBdt: Number(row.price_bdt), stockQuantity: row.stock_quantity,
    category: row.category, goodPoints: row.good_points, limitations: row.limitations, deliveryInfo: row.delivery_info,
    returnPolicy: row.return_policy, status: row.status, decisionNote: row.decision_note, shopId: row.shop_id,
    shopName: row.business_name, videoId: row.video_id || null, videoSegments: row.video_id ? { good: row.good_start_second, limitation: row.limitation_start_second, details: row.details_start_second } : null,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
  async function activeShop(sub) {
    const result = await pool.query("SELECT id,owner_sub,business_name,status FROM shops WHERE owner_sub=$1 AND status='active'", [sub]);
    return result.rows[0] || null;
  }

  app.get('/api/shop/products', async (req, res, next) => {
    try {
      const q = safeText(req.query?.q, 120);
      const result = await pool.query(`SELECT p.*,s.business_name,pv.video_id,pv.good_start_second,pv.limitation_start_second,pv.details_start_second
        FROM products p JOIN shops s ON s.id=p.shop_id LEFT JOIN product_videos pv ON pv.product_id=p.id
        WHERE p.status='approved' AND s.status='active' AND ($1='' OR to_tsvector('simple',p.name||' '||p.description||' '||p.category) @@ plainto_tsquery('simple',$1))
        ORDER BY p.created_at DESC LIMIT 60`, [q]);
      res.json({ products: result.rows.map(productShape) });
    } catch (error) { next(error); }
  });
  app.get('/api/shop/products/:id', async (req, res, next) => {
    try { const result=await pool.query(`SELECT p.*,s.business_name,pv.video_id,pv.good_start_second,pv.limitation_start_second,pv.details_start_second FROM products p JOIN shops s ON s.id=p.shop_id LEFT JOIN product_videos pv ON pv.product_id=p.id WHERE p.id=$1 AND p.status='approved' AND s.status='active'`,[req.params.id]); if(!result.rowCount)return res.status(404).json({error:'Product not found.'}); res.json({product:productShape(result.rows[0])}); } catch(error){next(error);}
  });
  app.get('/api/creator/shop/products', requireAuth, requireActive, async (req,res,next)=>{try{const shop=await activeShop(req.auth.session.sub);if(!shop)return res.status(403).json({error:'Admin approval is required before managing Shop products.',code:'shop_required'});const result=await pool.query(`SELECT p.*,s.business_name,pv.video_id,pv.good_start_second,pv.limitation_start_second,pv.details_start_second FROM products p JOIN shops s ON s.id=p.shop_id LEFT JOIN product_videos pv ON pv.product_id=p.id WHERE p.owner_sub=$1 ORDER BY p.created_at DESC`,[req.auth.session.sub]);res.json({products:result.rows.map(productShape)});}catch(error){next(error);}});
  app.post('/api/creator/shop/products', requireAuth, requireActive, async (req,res,next)=>{
    try{const shop=await activeShop(req.auth.session.sub);if(!shop)return res.status(403).json({error:'Admin approval is required before publishing products.',code:'shop_required'});const name=safeText(req.body?.name,160),description=safeText(req.body?.description,4000),category=safeText(req.body?.category,80),goodPoints=safeText(req.body?.goodPoints,2000),limitations=safeText(req.body?.limitations,2000),deliveryInfo=safeText(req.body?.deliveryInfo,1000),returnPolicy=safeText(req.body?.returnPolicy,1000),price=Number(req.body?.priceBdt),stock=Math.floor(Number(req.body?.stockQuantity));if(name.length<2||description.length<10||category.length<2)return res.status(400).json({error:'Product name, category and detailed description are required.'});if(!Number.isFinite(price)||price<=0)return res.status(400).json({error:'Price must be greater than zero.'});if(!Number.isInteger(stock)||stock<0)return res.status(400).json({error:'Stock must be zero or more.'});const id=crypto.randomUUID();const result=await pool.query(`INSERT INTO products(id,shop_id,owner_sub,name,description,price_bdt,stock_quantity,category,good_points,limitations,delivery_info,return_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,shop.id,req.auth.session.sub,name,description,price,stock,category,goodPoints,limitations,deliveryInfo,returnPolicy]);res.status(201).json({product:productShape(result.rows[0]),message:'Product submitted for Admin review.'});}catch(error){next(error);}
  });
  app.post('/api/creator/shop/products/:id/video', requireAuth, requireActive, async (req,res,next)=>{try{const shop=await activeShop(req.auth.session.sub);if(!shop)return res.status(403).json({error:'Approved Shop required.'});const videoId=safeText(req.body?.videoId,120);if(!validVideoId(videoId))return res.status(400).json({error:'Valid Atharo video id is required.'});const video=await pool.query('SELECT id FROM videos WHERE id=$1 AND owner_sub=$2',[videoId,req.auth.session.sub]);if(!video.rowCount)return res.status(404).json({error:'You can attach only your own video.'});const product=await pool.query('SELECT id FROM products WHERE id=$1 AND owner_sub=$2',[req.params.id,req.auth.session.sub]);if(!product.rowCount)return res.status(404).json({error:'Product not found.'});const segment=n=>Math.max(0,Math.floor(Number(n)||0));const saved=await pool.query(`INSERT INTO product_videos(product_id,video_id,good_start_second,limitation_start_second,details_start_second) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_id) DO UPDATE SET video_id=EXCLUDED.video_id,good_start_second=EXCLUDED.good_start_second,limitation_start_second=EXCLUDED.limitation_start_second,details_start_second=EXCLUDED.details_start_second RETURNING *`,[req.params.id,videoId,segment(req.body?.goodStartSecond),segment(req.body?.limitationStartSecond),segment(req.body?.detailsStartSecond)]);res.json({video:saved.rows[0]});}catch(error){next(error);}});
  app.get('/api/me/cart', requireAuth, async (req,res,next)=>{try{const result=await pool.query(`SELECT c.product_id,c.quantity,p.name,p.price_bdt,p.stock_quantity,p.status,s.business_name FROM cart_items c JOIN products p ON p.id=c.product_id JOIN shops s ON s.id=p.shop_id WHERE c.buyer_sub=$1 ORDER BY c.added_at DESC`,[req.auth.session.sub]);res.json({items:result.rows.map(x=>({productId:x.product_id,quantity:x.quantity,name:x.name,priceBdt:Number(x.price_bdt),stockQuantity:x.stock_quantity,status:x.status,shopName:x.business_name}))});}catch(error){next(error);}});
  app.post('/api/me/cart', requireAuth, requireActive, async (req,res,next)=>{try{const productId=safeText(req.body?.productId,80),quantity=Math.floor(Number(req.body?.quantity||1));if(!productId||!Number.isInteger(quantity)||quantity<1)return res.status(400).json({error:'Valid product and quantity are required.'});const product=await pool.query("SELECT id,stock_quantity FROM products WHERE id=$1 AND status='approved'",[productId]);if(!product.rowCount)return res.status(404).json({error:'Approved product not found.'});if(quantity>product.rows[0].stock_quantity)return res.status(409).json({error:'Requested quantity is not in stock.'});await pool.query('INSERT INTO carts(buyer_sub) VALUES($1) ON CONFLICT(buyer_sub) DO UPDATE SET updated_at=NOW()',[req.auth.session.sub]);await pool.query(`INSERT INTO cart_items(buyer_sub,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(buyer_sub,product_id) DO UPDATE SET quantity=LEAST(cart_items.quantity+EXCLUDED.quantity,$3),added_at=NOW()`,[req.auth.session.sub,productId,quantity]);res.json({ok:true});}catch(error){next(error);}});
  app.delete('/api/me/cart/:productId', requireAuth, requireActive, async (req,res,next)=>{try{await pool.query('DELETE FROM cart_items WHERE buyer_sub=$1 AND product_id=$2',[req.auth.session.sub,req.params.productId]);res.json({ok:true});}catch(error){next(error);}});
  app.post('/api/me/orders', requireAuth, requireActive, async (req,res,next)=>{try{const address=safeText(req.body?.shippingAddress,1000);if(address.length<5)return res.status(400).json({error:'Shipping address is required.'});const order=await withTransaction(async client=>{const rows=await client.query(`SELECT c.product_id,c.quantity,p.owner_sub,p.price_bdt,p.stock_quantity,p.name FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.buyer_sub=$1 AND p.status='approved' FOR UPDATE`,[req.auth.session.sub]);if(!rows.rowCount)throw Object.assign(new Error('Your cart is empty.'),{status:400});let total=0;for(const item of rows.rows){if(item.quantity>item.stock_quantity)throw Object.assign(new Error(`Not enough stock for ${item.name}.`),{status:409});total+=Number(item.price_bdt)*item.quantity;}const id=crypto.randomUUID();await client.query('INSERT INTO shop_orders(id,buyer_sub,total_amount_bdt,shipping_address) VALUES($1,$2,$3,$4)',[id,req.auth.session.sub,total,address]);for(const item of rows.rows){await client.query('INSERT INTO shop_order_items(order_id,product_id,seller_sub,quantity,unit_price_bdt) VALUES($1,$2,$3,$4,$5)',[id,item.product_id,item.owner_sub,item.quantity,item.price_bdt]);await client.query('UPDATE products SET stock_quantity=stock_quantity-$2,updated_at=NOW(),status=CASE WHEN stock_quantity-$2=0 THEN \'out_of_stock\' ELSE status END WHERE id=$1',[item.product_id,item.quantity]);}await client.query('DELETE FROM cart_items WHERE buyer_sub=$1',[req.auth.session.sub]);return {id,total};});res.status(201).json({order});}catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}});
  app.post('/api/me/orders/:id/checkout', requireAuth, requireActive, async (req,res,next)=>{try{const order=await pool.query('SELECT id,total_amount_bdt,payment_status FROM shop_orders WHERE id=$1 AND buyer_sub=$2',[req.params.id,req.auth.session.sub]);if(!order.rowCount)return res.status(404).json({error:'অর্ডার পাওয়া যায়নি।'});const row=order.rows[0];if(row.payment_status==='paid')return res.json({paid:true,orderId:row.id});res.json({pending:true,manual:true,orderId:row.id,orderRef:`ATH-SHOP-${row.id.replace(/-/g,'').slice(0,20).toUpperCase()}`,amountBdt:Number(row.total_amount_bdt),receivers:{bkash:process.env.PAYMENT_RECEIVER_BKASH||'',nagad:process.env.PAYMENT_RECEIVER_NAGAD||''}});}catch(error){next(error);}});
  app.get('/api/me/orders/:id/status', requireAuth, async (req,res,next)=>{try{const result=await pool.query('SELECT id,payment_status FROM shop_orders WHERE id=$1 AND buyer_sub=$2',[req.params.id,req.auth.session.sub]);if(!result.rowCount)return res.status(404).json({error:'অর্ডার পাওয়া যায়নি।'});res.json({orderId:result.rows[0].id,paymentStatus:result.rows[0].payment_status});}catch(error){next(error);}});
  app.get('/api/creator/shop/orders', requireAuth, requireActive, async (req,res,next)=>{try{const shop=await activeShop(req.auth.session.sub);if(!shop)return res.status(403).json({error:'Approved Shop required.'});const result=await pool.query(`SELECT o.id,o.total_amount_bdt,o.payment_status,o.order_status,o.shipping_address,o.created_at,COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT('productId',i.product_id,'productName',p.name,'quantity',i.quantity,'unitPriceBdt',i.unit_price_bdt)),'[]'::jsonb) AS items FROM shop_orders o JOIN shop_order_items i ON i.order_id=o.id JOIN products p ON p.id=i.product_id WHERE i.seller_sub=$1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,[req.auth.session.sub]);res.json({orders:result.rows.map(o=>({id:o.id,totalAmountBdt:Number(o.total_amount_bdt),paymentStatus:o.payment_status,orderStatus:o.order_status,shippingAddress:o.shipping_address,items:o.items,createdAt:o.created_at}))});}catch(error){next(error);}});
  app.patch('/api/creator/shop/orders/:id', requireAuth, requireActive, async (req,res,next)=>{try{const shop=await activeShop(req.auth.session.sub);if(!shop)return res.status(403).json({error:'Approved Shop required.'});const status=String(req.body?.orderStatus||'');if(!['confirmed','processing','shipped','delivered','cancelled'].includes(status))return res.status(400).json({error:'Invalid order status.'});const result=await pool.query(`UPDATE shop_orders SET order_status=$2 WHERE id=$1 AND EXISTS(SELECT 1 FROM shop_order_items WHERE order_id=shop_orders.id AND seller_sub=$3) RETURNING id,order_status`,[req.params.id,status,req.auth.session.sub]);if(!result.rowCount)return res.status(404).json({error:'Order not found for this Shop.'});res.json({order:{id:result.rows[0].id,orderStatus:result.rows[0].order_status}});}catch(error){next(error);}});
};
