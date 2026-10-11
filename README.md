# ClipNest — বাংলা ভিডিও প্ল্যাটফর্ম

Node.js/Express-ভিত্তিক বাংলা-first video sharing site। ClipNest-এর নিজস্ব coral/cream design রেখে পরিচিত video-platform patterns—discovery feed, creator subscriptions, comments, playlists, watch history এবং live interaction counts—যোগ করা হয়েছে। Layout ও branding নিজস্ব; কোনো existing platform-এর হুবহু UI কপি নয়।

## Feature set

- Google OAuth sign-in, Neon-এ user/profile/session data এবং public creator channel
- Direct-to-Cloudflare R2 video upload with progress, signed URLs, Private/Unlisted/Public visibility
- Neon-এ video metadata, likes, unique visitor views, comments/replies, creator subscriptions, playlists, Watch Later, watch history ও upload intents
- Socket.IO দিয়ে video page-এ live like/view/comment counts এবং channel-এ live subscriber count
- Home/discovery feed, category/search, subscription feed, recommendations, channel pages, history ও playlists
- **Creator Studio** (`/studio`): views, likes, comments, subscribers, ad impressions/clicks, estimated creator earnings ও copyright notices
- **Role-based Admin Panel** (`/admin`): campaign/ads controls, platform monetization settings, creator approval, channel suspend/ban, video remove/restore, copyright strikes/appeals, multiple staff accounts ও audit log
- Admin-controlled sponsored cards in feed/watch page. Ads global default-এ বন্ধ এবং নতুন campaigns Paused থাকে
- Responsive Bengali UI, mobile navigation, share link ও owner-only video deletion

## Monetization: বর্তমান সীমা

এটি এখন **নিজস্ব sponsor campaign ও estimated-revenue framework**—Google AdSense/YouTube ad network integration নয়। Owner/admin campaign-এ HTTPS creative/landing URL এবং CPM (BDT/1,000 impressions) দেয়; Owner global ads delivery ও creator share চালু না করা পর্যন্ত visitor-কে ad দেখানো হয় না। `watch_sidebar` placement-এর public video-তে approved creator-এর revenue estimate record হয়। Home-feed ad impression creator-কে স্বয়ংক্রিয়ভাবে credit হয় না।

**এখানে real advertiser billing, contract/invoice, fraud review, tax handling, payout account বা creator cash payment নেই।** Creator Studio-র আয় কেবল campaign CPM ও configured share থেকে হিসাব করা estimate; এটি earned/withdrawable money-এর নিশ্চয়তা নয়। বাস্তবে টাকা দেওয়ার আগে advertiser payment, platform terms, Bangladesh tax/payment compliance, identity/eligibility review এবং payout provider আলাদাভাবে যুক্ত করতে হবে।

## কোথায় কোন ডেটা থাকে

| ডেটা | অবস্থান |
|---|---|
| ভিডিও ফাইল/বড় media object | Private Cloudflare R2 bucket |
| User account ID, email, profile ও channel handle | Neon PostgreSQL |
| Session hash/expiry, video title/description/category/visibility | Neon PostgreSQL |
| Likes, views, comments, subscriptions, playlists ও watch history | Neon PostgreSQL |
| Admin roles, platform settings, campaigns, ad events, strikes ও audit log | Neon PostgreSQL |
| Site code, ClipNest UI assets | GitHub repository |

R2-তে পুরনো JSON metadata থাকলে migration command সেগুলো **copy/import** করবে; source R2 object মুছবে না। Video binary R2-তেই থাকবে। Campaign creative URL এখন HTTPS URL হিসেবে সংরক্ষিত হয়; ভিডিও ছাড়া অন্য কোনো media upload workflow যোগ করা হয়নি।

## Admin roles ও moderation

1. Render Environment-এ `OWNER_EMAIL`-কে Owner হিসেবে site-এ Google sign-in করতে ব্যবহৃত account-এর email দিন। Email code-এ নেই—role resolution server-side-এ হয়।
2. সেই verified Google account দিয়ে sign-in করলে account menu-তে **Admin control panel** ও `/admin` route দেখাবে। প্রথম Owner-কে panel থেকে সরানো বা demote করা যায় না।
3. Owner panel থেকে email অনুযায়ী অন্য **Admin** বা **Moderator** যোগ/বাদ দিতে পারবেন। তাঁরা নিজ নিজ Google account দিয়ে sign-in করলে role কার্যকর হবে। Admin campaign/moderation পরিচালনা করতে পারে; Moderator moderation-এ সীমিত; Owner সব settings, roles ও monetization approval নিয়ন্ত্রণ করে।
4. Video remove হলো Neon-এ reversible moderation state—R2 binary এই action-এ স্থায়ীভাবে delete হয় না। Copyright strike creator dashboard-এ দেখা যায় এবং creator appeal পাঠাতে পারে। Ban/suspend public channel/videos লুকিয়ে ওই account-এর content-changing actions বন্ধ করে। প্রতিটি admin action reason-সহ audit log-এ যায়।
5. Copyright strike হলো এই app-এর **internal moderation record**, নিজে থেকে আদালত/সরকারি বা বাইরের platform-এর আইনগত সিদ্ধান্ত নয়। Owner/admin-এর মানবিক review ও ন্যায্য appeal process রাখা উচিত।

`OWNER_EMAIL` সঠিক না থাকলে বা Google OAuth sign-in অসম্পূর্ণ হলে Owner panel পাওয়া যাবে না। Email বদলানোর আগে Render config-এ নতুন Owner address set করে নতুন Google account দিয়ে লগইন পরীক্ষা করুন; নতুন account যাচাইয়ের আগে পুরনো Owner-কে সরাবেন না।

## যা লাগবে

- Node.js 18+
- Neon PostgreSQL project (hosted app-এর জন্য Neon-এর pooled connection string সুপারিশ করা হয়)
- Cloudflare R2 private bucket ও ওই bucket-এ সীমিত Object Read & Write token
- Google Cloud OAuth 2.0 Web application client
- Render বা অন্য Node.js host-এ environment variables

## Neon ও পুরনো ডেটা migration

1. Neon-এ PostgreSQL project/database তৈরি করুন। Neon dashboard-এর **pooled connection string** নিন এবং `DATABASE_URL` হিসেবে hosting environment-এ দিন। Connection string গোপন রাখুন; browser/client code বা Git-এ দেবেন না।
2. Hosting environment-এ `DATABASE_URL`, R2 credentials এবং কমপক্ষে 32-character `SESSION_SECRET` দিন। `.env.example` template হিসেবে ব্যবহার করুন।
3. Server startup-এ `schema.sql` idempotently চালিয়ে tables/indexes এবং নতুন moderation, monetization, ad ও admin schema নিশ্চিত করে। আগে থেকে থাকা Neon data মুছবে না।
4. `storage_migrations`-এ `r2-json-v1` marker না থাকলে backend পুরনো R2 JSON metadata-কে Neon-এ **একবার** import করে। `meta/`, `profiles/`, active sessions, likes ও views থেকে relational records তৈরি হয়; source R2 objects এবং video files মুছে না।
5. Auto-migration সাময়িকভাবে বন্ধ করতে `MIGRATE_R2_JSON_ON_START=false` দিন। Local CLI-তে একই migration `npm run migrate:r2` দিয়ে চালানো যায়; সফল migration marker থাকলে পরের run duplicate import করে না।

## Cloudflare R2 ও browser upload

1. একটি R2 bucket তৈরি করে private রাখুন। Bucket-scoped Object Read & Write API token ব্যবহার করুন।
2. Bucket Settings → CORS Policy-তে production site origin ও local origin দিন। `*` origin ব্যবহার করবেন না:

   ```json
   [
     {
       "AllowedOrigins": ["https://YOUR-SITE.example", "http://localhost:3000"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

Only video/media bytes stay in R2 as normal app data; new accounts and application records are written to Neon.

## Google OAuth

1. Google Cloud Console-এ OAuth consent screen configure করুন; Testing mode হলে test user যোগ করুন।
2. OAuth Client ID-তে **Web application** বেছে নিন।
3. Authorized redirect URI-তে callback URI একদম হুবহু দিন: `https://YOUR-SITE.example/auth/google/callback`। Local development হলে `http://localhost:3000/auth/google/callback` যোগ করুন।
4. একই URI `GOOGLE_REDIRECT_URI`-তে দিন। `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` ও `GOOGLE_REDIRECT_URI` তিনটিই set করুন; client secret শুধু server-side environment-এ থাকবে।

## লোকালি চালানো

```bash
cp .env.example .env
# .env-এ DATABASE_URL, R2 values, Google OAuth values এবং OWNER_EMAIL দিন
openssl rand -hex 32   # output-টি SESSION_SECRET হিসেবে দিন
npm install
npm start
```

তারপর `http://localhost:3000` খুলুন। Socket.IO একই Express service-এ চালু হয়; আলাদা Socket.IO server লাগে না।

## Render-এ deploy

1. GitHub repository থেকে Node Web Service তৈরি করুন; build command `npm install`, start command `npm start`।
2. Render Environment-এ `.env.example`-এর variables দিন—বিশেষ করে `DATABASE_URL`, সব R2 credential, `SESSION_SECRET`, `NODE_ENV=production`, Google OAuth settings, `APP_ORIGIN` ও `OWNER_EMAIL`। `OWNER_EMAIL`-তে Owner account-এর Google email দিন; trailing space দেবেন না। `APP_ORIGIN`-এ শুধু site origin দিন, যেমন `https://YOUR-SITE.example`।
3. Google OAuth redirect URI এবং R2 CORS-এ production URL মিলিয়ে দিন।
4. Deploy-এর পর Render logs-এ schema/migration error আছে কি না দেখুন, তারপর Owner Google account দিয়ে `/admin` access পরীক্ষা করুন। Ads ও creator monetization **শুধু নীতিমালা/CPM/share যাচাইয়ের পর** Owner panel-এ চালু করুন।

Render Free web service 15 মিনিট inbound traffic না থাকলে sleep করে এবং পরের request-এ wake হতে সময় নেয়; sleep/redeploy-এ live socket connections disconnect হবে, তারপর client reconnect করবে। নিরবচ্ছিন্ন realtime-এর জন্য always-on web service দরকার। একাধিক server instance-এ scale করলে Socket.IO Redis adapter যোগ করতে হবে; বর্তমান setup single Render service/process-এর জন্য।

## Environment variables

| নাম | দরকার? | কাজ |
|---|---|---|
| `PORT` | না | HTTP port; default `3000` |
| `NODE_ENV` | production-এ | Secure cookie ও production behavior |
| `DATABASE_URL` | হ্যাঁ | Neon PostgreSQL connection string; secret |
| `PG_POOL_MAX` | না | PostgreSQL pool size; default `5` |
| `MAX_FILE_MB` | না | সর্বোচ্চ upload size; default `500` MB |
| `R2_ACCOUNT_ID` | হ্যাঁ | Cloudflare account ID |
| `R2_BUCKET` | হ্যাঁ | Private media bucket |
| `R2_ACCESS_KEY_ID` | হ্যাঁ | Bucket-scoped access key |
| `R2_SECRET_ACCESS_KEY` | হ্যাঁ | Bucket-scoped secret |
| `GOOGLE_CLIENT_ID` | Login-এর জন্য | Google OAuth Web client ID |
| `GOOGLE_CLIENT_SECRET` | Login-এর জন্য | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Login-এর জন্য | Authorized callback URI |
| `APP_ORIGIN` | Production-এ সুপারিশকৃত | OAuth redirect ও Socket.IO allowed origin |
| `OWNER_EMAIL` | Admin bootstrap-এর জন্য | Verified Google account-এর Owner email; server-side only |
| `SESSION_SECRET` | হ্যাঁ | Signed session/viewer cookies; অন্তত 32 characters |
| `MIGRATE_R2_JSON_ON_START` | না | `false` দিলে startup-এ legacy R2 JSON migration বন্ধ |

## নিরাপত্তা ও privacy

- Neon/R2/Google secrets কেবল hosting environment বা local `.env`-এ রাখুন; `.env` commit করবেন না।
- Session token browser cookie-তে signed থাকে; database-এ raw token নয়, hash সংরক্ষিত হয়। Google email ও account data সাধারণ frontend/feed-এ প্রকাশ করা হয় না; authorized admin context-এই staff/content records দেখা যায়।
- Admin authorization প্রতিটি protected backend route-এ server-side যাচাই হয়; client-side menu লুকানো একমাত্র access control নয়। Owner bootstrap email source code-এ hard-code নয়।
- Public feed-এ শুধু active-account-এর Public videos আসে। Unlisted ভিডিও direct link-এ দেখা যায়; Private ভিডিও uploader ছাড়া দেখা যায় না। Signed media URL মেয়াদসীমাবদ্ধ।
- Like/comment/subscribe, upload ও playlist পরিবর্তনে লগইন লাগে; suspended/banned accounts content-changing action করতে পারে না। Video view browser-ভিত্তিক signed first-party cookie দিয়ে deduplicate হয়; cookie মুছলে/অন্য browser ব্যবহার করলে count আবার হতে পারে।
- Ad URLs HTTPS-only; ads default-off; new campaign paused; ad events browser/day ভিত্তিক deduplicate হয়। CPM-based earnings **estimate** মাত্র, payout নয়।
- R2-to-Neon migration source objects মুছে না। Neon data যাচাই না করে পুরনো R2 JSON নিজে থেকে delete করবেন না। Production schema পরিবর্তনের আগে Neon backup/restore point রাখুন।
