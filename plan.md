# Premium video marketplace plan

## Product scope

Atharo-র existing creator platform-এর উপর premium creator playlist marketplace যোগ হবে। Creator Studio থেকে creator একটি playlist-কে premium হিসেবে চিহ্নিত করে BDT price সেট করতে পারবে; viewer public catalog-এ playlist দেখে একটি purchase action দিয়ে entitlement পাবে; entitlement থাকা viewer playlist-এর সব ভিডিও দেখতে পারবে। Creator Studio-তে sold units, gross sales, platform share, creator estimate এবং top premium playlist দেখা যাবে।

Real payment gateway credential এই repository-তে নেই, তাই এই revision-এ payment state/entitlement flow আলাদা রাখা হবে এবং একটি clearly labelled demo checkout endpoint থাকবে। Production launch-এর আগে Stripe/SSLCommerz webhook দিয়ে `paid` order confirm করতে হবে; client-side price বা purchase state-কে payment proof ধরা যাবে না।

## Implementation approach

- PostgreSQL-এ premium playlist fields, purchase orders, purchaser entitlements এবং order event timestamps যোগ করা হবে; existing playlists/videos/user ownership বজায় থাকবে।
- নতুন `premium-marketplace.js` module public catalog/detail/purchase এবং creator sales APIs expose করবে। Existing session/auth middleware reuse হবে।
- Playlist access server-side entitlement দিয়ে gate হবে; creator/owner এবং purchased viewer access পাবে। Catalog-এ preview metadata থাকবে, full playlist content purchase ছাড়া নয়।
- Public `/premium` route existing SPA-তে যোগ হবে। Viewer UI-তে premium cards, price, owned state এবং purchase flow থাকবে।
- Creator Studio-তে Premium tab যোগ হবে: publish/edit premium playlists, price, sales table এবং summary stats।
- UI existing Atharo deep green/orange language বজায় রাখবে; premium-কে আলাদা gold accent দিয়ে distinguish করা হবে।

## Design direction

Three possible styles: **Editorial cinema ledger** (0.06), **Warm creator bazaar** (0.08), **Neon streaming vault** (0.07). Chosen: **Editorial cinema ledger**.

- **Design movement:** independent film catalog meets modern creator business dashboard.
- **Core principles:** high-trust pricing, clear access state, editorial hierarchy, sales data without noise.
- **Color philosophy:** existing green-black studio base conveys control; muted gold marks paid value without looking like an ad.
- **Layout paradigm:** asymmetrical catalog rail with large featured premium collection and compact purchase ledger; avoid generic centered card grid.
- **Signature elements:** gold “PREMIUM” eyebrow, lock/unlock access badge, thin ledger-like sales rows.
- **Interaction philosophy:** every purchase action explains what unlocks before asking for confirmation; owned content stays visibly actionable.
- **Animation:** restrained 150–220ms lift/fade on cards and state changes; no looping decorative motion.
- **Typography system:** existing Noto Sans Bengali for content with system/Inter-like compact labels for metadata.
- **Brand essence:** “Creator knowledge and series worth paying for, in one clear shelf.” Personality: trusted, focused, creator-first.
- **Brand voice:** “একবার কিনে পুরো সিরিজ দেখো।” / “তোমার premium series থেকে কত বিক্রি হলো—এখন পরিষ্কার দেখো।”
- **Wordmark & logo:** retain Atharo mark; use a small gold play-lock badge for premium.
- **Signature brand color:** #d4a94f muted premium gold.

## Project structure

- `schema.sql`: idempotent premium playlist/order/entitlement tables and indexes.
- `premium-marketplace.js`: premium catalog, access and creator sales APIs.
- `server.js`: mount premium module and expose premium-aware playlist access.
- `public/index.html`: `/premium` catalog/detail route and purchase UI.
- `public/studio.js`: Premium Studio tab and sales management UI.
- `public/clipnest.css`: premium catalog, badges, purchase and ledger styles.
- `public/manus-routes.json`: public route manifest update.

## Acceptance criteria

- Creator can mark a creator playlist as premium and set a positive BDT price.
- Viewer can browse premium playlists, see title/creator/price/preview, and purchase one.
- After a successful purchase state, only entitled viewer/owner can access the premium playlist videos; non-entitled viewers see the locked state.
- Creator Studio shows premium playlist sales count, gross sales, creator estimate and recent orders.
- Purchase and access checks are server-side and ownership is scoped to the authenticated account.
- UI is responsive and uses existing Atharo visual system.
