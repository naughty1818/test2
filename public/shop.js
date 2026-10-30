'use strict';
(() => {
  const $ = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (key === 'onInput') node.addEventListener('input', value);
      else if (key === 'onChange') node.addEventListener('change', value);
      else if (key === 'checked') node.checked = Boolean(value);
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'hidden') node.hidden = Boolean(value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  };
  const money = value => new Intl.NumberFormat('bn-BD', { style: 'currency', currency: 'BDT', maximumFractionDigits: 0 }).format(Number(value) || 0);
  const date = value => value ? new Intl.DateTimeFormat('bn-BD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const statusText = { pending: 'পেমেন্ট অপেক্ষমাণ', paid: 'পেমেন্ট নিশ্চিত', confirmed: 'অর্ডার নিশ্চিত', processing: 'প্রসেসিং', shipped: 'শিপড', delivered: 'ডেলিভারড', cancelled: 'বাতিল' };
  const statusClass = value => ['paid', 'confirmed', 'processing', 'shipped', 'delivered'].includes(value) ? 'shop-status-good' : value === 'cancelled' ? 'shop-status-danger' : 'shop-status-warn';
  const categories = ['সব পণ্য', 'পোশাক', 'খাবার', 'হস্তশিল্প', 'বই', 'Tech', 'অন্যান্য'];

  function context() { return window.AtharoShopContext || {}; }
  function go(path) { context().navigate?.(path); }
  function notify(message, type) { context().notify?.(message, type); }
  function requireLogin(message = 'এই কাজটি করতে আগে লগইন করো।') { if (!context().session?.user) { notify(message, 'error'); go('/login'); return false; } return true; }
  async function request(path, options) { return context().jsonFetch(path, options); }
  function productArt(product, large = false) {
    const art = $('div', { class: `shop-product-art${large ? ' shop-product-art-large' : ''}` });
    if (product.videoId) art.append($('img', { src: `/api/videos/${encodeURIComponent(product.videoId)}/thumbnail`, alt: product.name || '', loading: 'lazy' }));
    art.append($('span', { text: product.category ? product.category.slice(0, 1) : '◆' }));
    return art;
  }
  function stockLabel(product) {
    const stock = Number(product.stockQuantity) || 0;
    return stock <= 0 ? 'স্টক শেষ' : stock <= 5 ? `কম স্টক · ${stock}টি বাকি` : 'স্টকে আছে';
  }
  function productCard(product, onAdded) {
    const stock = Number(product.stockQuantity) || 0;
    const button = $('button', { class: 'primary-cta shop-card-cta', text: stock ? 'কার্টে যোগ করো' : 'স্টক শেষ', disabled: !stock });
    button.addEventListener('click', async () => {
      if (!requireLogin('কার্টে যোগ করতে আগে লগইন করো।')) return;
      button.disabled = true;
      try { await request('/api/me/cart', { method: 'POST', body: { productId: product.id, quantity: 1 } }); notify('পণ্যটি কার্টে যোগ হয়েছে।'); onAdded?.(); }
      catch (error) { notify(error.message, 'error'); }
      finally { button.disabled = !stock; }
    });
    return $('article', { class: 'shop-product-card' }, [
      $('a', { class: 'shop-card-media', href: `/shop/product/${encodeURIComponent(product.id)}`, 'data-route': '' }, [productArt(product), $('span', { class: 'shop-card-category', text: product.category || 'Shop' })]),
      $('div', { class: 'shop-card-copy' }, [
        $('div', { class: 'shop-card-topline' }, [$('span', { class: 'shop-verified-badge', text: 'VERIFIED SHOP' }), $('span', { class: 'shop-stock-label', text: stockLabel(product) })]),
        $('a', { class: 'shop-card-title', href: `/shop/product/${encodeURIComponent(product.id)}`, 'data-route': '', text: product.name }),
        $('p', { class: 'shop-card-description', text: product.description || 'Atharo creator-এর curated product' }),
        $('div', { class: 'shop-card-footer' }, [$('strong', { class: 'shop-price', text: money(product.priceBdt) }), button])
      ])
    ]);
  }
  function shell(path, title, description) {
    const page = $('section', { class: 'shop-page' });
    const header = $('header', { class: 'shop-hero' }, [
      $('div', { class: 'shop-hero-copy' }, [$('span', { class: 'section-kicker shop-kicker', text: 'ATHARO · SHOP' }), $('h1', { text: title }), $('p', { text: description })]),
      $('div', { class: 'shop-hero-mark', 'aria-hidden': 'true' }, [$('span', { text: '◆' }), $('small', { text: 'creator shelf' })])
    ]);
    page.append(header);
    const actions = $('div', { class: 'shop-page-actions' }, [
      $('a', { class: 'shop-action-link', href: '/shop', 'data-route': '', text: 'Shop ঘুরে দেখো' }),
      $('a', { class: 'shop-action-link', href: '/shop/cart', 'data-route': '', text: 'কার্ট ↗' }),
      $('a', { class: 'shop-action-link', href: '/shop/orders', 'data-route': '', text: 'আমার অর্ডার ↗' })
    ]);
    page.append(actions);
    return page;
  }
  async function renderCatalog(root) {
    const page = shell('/shop', 'Creator-দের পছন্দের পণ্য, এক জায়গায়', 'ভালোভাবে যাচাই করা product দেখো, creator-এর video review শোনো এবং সরাসরি order করো।');
    const toolbar = $('div', { class: 'shop-toolbar' });
    const search = $('input', { type: 'search', placeholder: 'পণ্যের নাম বা category খুঁজুন', 'aria-label': 'পণ্য খুঁজুন' });
    const searchButton = $('button', { class: 'shop-search-button', text: 'খুঁজুন' });
    const chips = $('div', { class: 'shop-category-strip', role: 'list' });
    const shelf = $('div', { class: 'shop-product-grid' });
    let products = [], activeCategory = 'সব পণ্য';
    const paint = () => {
      const query = search.value.trim().toLocaleLowerCase('bn-BD');
      const filtered = products.filter(p => (!query || `${p.name} ${p.description} ${p.category}`.toLocaleLowerCase('bn-BD').includes(query)) && (activeCategory === 'সব পণ্য' || p.category === activeCategory));
      shelf.replaceChildren(...(filtered.length ? filtered.map(p => productCard(p, () => renderCartSummary(page))) : [$('div', { class: 'shop-empty shop-empty-grid', text: products.length ? 'এই filter-এ কোনো product পাওয়া যায়নি।' : 'এখনো approved product নেই।' })]));
    };
    categories.forEach(category => chips.append($('button', { class: `category-chip${category === activeCategory ? ' category-chip-active' : ''}`, text: category, onClick: () => { activeCategory = category; chips.querySelectorAll('button').forEach(b => b.classList.toggle('category-chip-active', b.textContent === category)); paint(); } })));
    searchButton.addEventListener('click', paint); search.addEventListener('input', paint);
    toolbar.append($('div', { class: 'shop-search-box' }, [search, searchButton]), chips);
    page.append(toolbar, $('div', { class: 'shop-section-heading' }, [$('div', {}, [$('span', { class: 'section-kicker', text: 'APPROVED PRODUCTS' }), $('h2', { text: 'নতুন পণ্য' })]), $('span', { class: 'shop-heading-note', text: 'Admin-approved seller ও product' })]), shelf);
    root.replaceChildren(page);
    try { products = (await request('/api/shop/products')).products || []; paint(); if (context().session?.user) await renderCartSummary(page); }
    catch (error) { shelf.replaceChildren($('div', { class: 'shop-empty shop-empty-grid', text: `Shop catalog লোড হয়নি: ${error.message}` })); }
  }
  async function renderCartSummary(page) {
    const existing = page.querySelector('.shop-cart-summary'); if (existing) existing.remove();
    try { const items = (await request('/api/me/cart')).items || []; if (!items.length) return;
      const total = items.reduce((sum, item) => sum + Number(item.priceBdt) * Number(item.quantity), 0);
      page.append($('aside', { class: 'shop-cart-summary' }, [$('div', {}, [$('span', { text: `${items.length}টি পণ্য কার্টে` }), $('strong', { text: money(total) })]), $('a', { class: 'primary-cta', href: '/shop/cart', 'data-route': '', text: 'কার্ট দেখো ↗' })]));
    } catch (_) {}
  }
  async function renderDetail(root, id) {
    const page = shell('/shop/product', 'Product details', 'Product-এর ভালো দিক, সীমাবদ্ধতা ও delivery information দেখে সিদ্ধান্ত নাও।'); root.replaceChildren(page);
    try { const product = (await request(`/api/shop/products/${encodeURIComponent(id)}`)).product; const stock = Number(product.stockQuantity) || 0;
      const quantity = $('input', { class: 'shop-quantity', type: 'number', min: '1', max: String(Math.max(stock, 1)), value: '1', 'aria-label': 'পরিমাণ' });
      const add = $('button', { class: 'primary-cta', text: stock ? 'কার্টে যোগ করো' : 'স্টক শেষ', disabled: !stock });
      add.addEventListener('click', async () => { if (!requireLogin('কার্টে যোগ করতে আগে লগইন করো।')) return; try { await request('/api/me/cart', { method: 'POST', body: { productId: product.id, quantity: Math.min(stock, Math.max(1, Number(quantity.value) || 1)) } }); notify('পণ্যটি কার্টে যোগ হয়েছে।'); go('/shop/cart'); } catch (error) { notify(error.message, 'error'); } });
      const detail = $('div', { class: 'shop-detail-layout' }, [$('div', { class: 'shop-detail-media' }, [productArt(product, true), product.videoId ? $('a', { class: 'shop-video-link', href: `/watch/${encodeURIComponent(product.videoId)}`, 'data-route': '', text: 'Product video দেখুন ↗' }) : null]), $('article', { class: 'shop-detail-copy' }, [$('span', { class: 'shop-verified-badge', text: 'VERIFIED SHOP · ' + (product.shopName || 'Atharo seller') }), $('h2', { text: product.name }), $('p', { class: 'shop-detail-description', text: product.description }), $('div', { class: 'shop-detail-price-row' }, [$('strong', { class: 'shop-detail-price', text: money(product.priceBdt) }), $('span', { class: `shop-stock-label ${stock ? '' : 'shop-stock-out'}`, text: stockLabel(product) })]), $('div', { class: 'shop-buy-row' }, [quantity, add]), $('div', { class: 'shop-trust-list' }, [$('span', { text: '✓ Verified seller' }), $('span', { text: '✓ Secure manual payment verification' }), $('span', { text: '✓ Order status tracking' })])])]);
      const info = $('div', { class: 'shop-info-grid' }, [['ভালো দিক', product.goodPoints], ['সীমাবদ্ধতা', product.limitations], ['Delivery', product.deliveryInfo], ['Return policy', product.returnPolicy]].map(([label, value]) => $('section', { class: 'shop-info-card' }, [$('span', { class: 'section-kicker', text: label }), $('p', { text: value || 'Seller এখনো তথ্য যোগ করেননি।' })])));
      page.append(detail, info);
    } catch (error) { page.append($('div', { class: 'shop-empty', text: `Product পাওয়া যায়নি: ${error.message}` })); }
  }
  async function renderCart(root) {
    const page = shell('/shop/cart', 'তোমার কার্ট', 'Order করার আগে product, quantity এবং delivery address একবার দেখে নাও।');
    const content = $('div', { class: 'shop-cart-layout' }); page.append(content); root.replaceChildren(page);
    if (!requireLogin('কার্ট দেখতে আগে লগইন করো।')) return;
    try { const items = (await request('/api/me/cart')).items || []; if (!items.length) { content.append($('div', { class: 'shop-empty', text: 'তোমার কার্ট এখনো খালি।' }), $('a', { class: 'primary-cta', href: '/shop', 'data-route': '', text: 'Shop ঘুরে দেখো ↗' })); return; }
      const list = $('div', { class: 'shop-cart-list' }); let total = 0;
      items.forEach(item => { const lineTotal = Number(item.priceBdt) * Number(item.quantity); total += lineTotal; const remove = $('button', { class: 'shop-remove-button', text: 'সরাও' }); remove.addEventListener('click', async () => { await request(`/api/me/cart/${encodeURIComponent(item.productId)}`, { method: 'DELETE' }); notify('কার্ট আপডেট হয়েছে।'); renderCart(root); }); list.append($('article', { class: 'shop-cart-item' }, [$('div', { class: 'shop-cart-item-art', text: '◆' }), $('div', { class: 'shop-cart-item-copy' }, [$('strong', { text: item.name }), $('small', { text: `${item.shopName || 'Atharo seller'} · ${item.quantity}টি` })]), $('strong', { class: 'shop-price', text: money(lineTotal) }), remove])); });
      const address = $('textarea', { class: 'shop-address', rows: '4', placeholder: 'সম্পূর্ণ delivery address লিখুন', 'aria-label': 'Delivery address' }); const checkout = $('button', { class: 'primary-cta', text: 'Order তৈরি করে payment করো' });
      checkout.addEventListener('click', async () => { if (address.value.trim().length < 5) { notify('Delivery address লিখুন।', 'error'); address.focus(); return; } checkout.disabled = true; try { const order = await request('/api/me/orders', { method: 'POST', body: { shippingAddress: address.value.trim() } }); const payment = await request(`/api/me/orders/${encodeURIComponent(order.order.id)}/checkout`, { method: 'POST', body: {} }); payment.orderKind = 'shop'; payment.returnPath = `/shop/orders?order_id=${encodeURIComponent(order.order.id)}`; sessionStorage.setItem('atharoPaymentOrder', JSON.stringify(payment)); go('/payment'); } catch (error) { notify(error.message, 'error'); checkout.disabled = false; } });
      content.append(list, $('aside', { class: 'shop-order-summary' }, [$('span', { class: 'section-kicker', text: 'ORDER SUMMARY' }), $('h2', { text: money(total) }), $('label', { class: 'form-field' }, [$('span', { text: 'Delivery address' }), address]), checkout]));
    } catch (error) { content.append($('div', { class: 'shop-empty', text: error.message })); }
  }
  async function renderOrders(root) {
    const page = shell('/shop/orders', 'আমার Shop অর্ডার', 'Payment, processing এবং delivery status এক জায়গায় দেখো।'); const list = $('div', { class: 'shop-orders-list' }); page.append(list); root.replaceChildren(page);
    if (!requireLogin('অর্ডার দেখতে আগে লগইন করো।')) return;
    try { const data = await request('/api/me/orders'); const orders = data.orders || []; if (!orders.length) { list.append($('div', { class: 'shop-empty', text: 'এখনো কোনো Shop order নেই।' })); return; }
      orders.forEach(order => { const progress = ['confirmed', 'processing', 'shipped', 'delivered']; const active = progress.indexOf(order.orderStatus); list.append($('article', { class: 'shop-order-card' }, [$('div', { class: 'shop-order-head' }, [$('div', {}, [$('span', { class: 'section-kicker', text: `ORDER · ${order.orderRef}` }), $('h2', { text: money(order.totalAmountBdt) })]), $('span', { class: `shop-status ${statusClass(order.paymentStatus)}`, text: statusText[order.paymentStatus] || order.paymentStatus })]), $('p', { class: 'shop-order-date', text: `${date(order.createdAt)} · ${order.shippingAddress}` }), $('div', { class: 'shop-order-items', text: (order.items || []).map(item => `${item.productName} × ${item.quantity}`).join(' · ') }), $('div', { class: 'shop-progress' }, progress.map((step, index) => $('span', { class: index <= active && active >= 0 ? 'done' : '', text: statusText[step] })))])); });
    } catch (error) { list.append($('div', { class: 'shop-empty', text: `Order লোড হয়নি: ${error.message}` })); }
  }
  window.AtharoShop = { renderCatalog, renderDetail, renderCart, renderOrders };
})();
