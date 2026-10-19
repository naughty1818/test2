# Atharo | আঠারো — বাংলা ভিডিও প্ল্যাটফর্ম

Node.js/Express-ভিত্তিক বাংলা-first video sharing site। Atharo-র নিজস্ব deep green-black design, supplied transparent logo এবং video-platform patterns—discovery feed, creator subscriptions, comments, playlists, watch history এবং live interaction counts—আছে। Layout ও branding নিজস্ব; কোনো existing platform-এর হুবহু UI কপি নয়।

## Feature set

- Google OAuth sign-in, Neon-এ user/profile/session data এবং public creator channel
- Viewer mode: **Normal** viewers সব visibility/moderation-eligible public video দেখতে পারেন; **Islamic** viewers কেবল Islamic হিসেবে creator-marked এবং Admin/Moderator-approved public video feed, search, channel, playlist ও playback-এ পান। নতুন/পুরনো account-এর default Normal; account menu থেকে mode বদলানো যায়।
- Creator channel type: **Islamic**, **Normal** বা **Mixed**। Islamic creator-এর সব upload certification review-তে যায়; Normal creator Islamic হিসেবে mark করতে পারে না; Mixed creator প্রতি video-তে Islamic flag বেছে নেয়। Flag মানেই certification নয়—approval না হওয়া পর্যন্ত Islamic viewers-এর কাছে ভিডিওটি থাকবে না।
- Direct-to-Cloudflare R2 video upload with progress and signed URLs; uploaders must explicitly select Private/Unlisted/Public visibility (no default), and Education videos require class/level, subject and at least one syllabus tag
- Neon-এ video metadata, likes, unique visitor views, comments/replies, creator subscriptions, playlists, Watch Later, watch history ও upload intents
- Socket.IO দিয়ে video page-এ live like/view/comment counts এবং channel-এ live subscriber count
- Home/discovery feed, category/search, subscription feed, recommendations, channel pages, history ও playlists
- **Creator Studio** (`/studio`, account menu থেকে নতুন tab-এ খোলে): content library ও metadata/thumbnail/visibility/scheduled publish/comments controls; upload intents; comments reply/pin/hide; views, subscriber growth, CTR, watch time ও sampled retention analytics; audience activity; playlist/series ordering; channel avatar/cover/profile customization; creator notifications/resources; estimated creator earnings ও copyright appeals
- Creator Studio video editor থেকে video ও thumbnail-এর permanent delete; R2 deletion ব্যর্থ হলে database record রাখা হয় এবং retry করা যায়।
- **Role-based fullscreen Admin Panel** (`/admin`, account menu থেকে নতুন tab): unified reports/video appeals/copyright-strike appeal queue, searchable and paginated content/user/campaign/audit views, atomic report-to-moderation actions, creator approval, reversible channel/video moderation, campaign preview/editing and time-range CTR analytics, staff roles, platform settings ও audit log
- Admin/Moderator panel-এ Islamic certification review queue; approve/reject সিদ্ধান্ত note-সহ audit log-এ যায়। এটি Atharo-র অভ্যন্তরীণ moderation decision—কোনো ধর্মীয় কর্তৃপক্ষের endorsement নয়।
- Admin-controlled sponsored cards in feed/watch page. Ads global default-এ বন্ধ এবং নতুন campaigns Paused থাকে
- Responsive Bengali UI, mobile navigation, share link ও owner-only video deletion
- Account menu থেকে Normal/Islamic viewer mode switch, creator channel permanent delete এবং পুরো user account permanent delete; account deletion-এর সময় owned database records ও R2 media cleanup-এর চেষ্টা হয়
- Campaign editor-এ PC/Desktop ও Phone/Mobile-এর জন্য আলাদা HTTPS creative image URL; ad serving request-এর user-agent অনুযায়ী সঠিক image বেছে নেওয়া হয়, পুরনো campaign URL fallback হিসেবে থাকে
- Education-first P0 tools: class/subject/syllabus metadata, indexed advanced search filters, Bengali/English WebVTT captions with searchable transcript, creator thumbnails, duration badges, timestamp chapters, playback-speed control, signed direct-to-R2 playback, continue-watching, sampled watch-time/retention, content reports and moderation appeals

## শিক্ষা ও playback P0: কী আছে, কী নেই

1. Education বিভাগ বেছে নিলে Class/level, subject ও syllabus tags upload metadata-তে Neon-এ রাখা বাধ্যতামূলক; home/search-এ education-specific filters কেবল Education category নির্বাচনের পর দেখা যায়। Duration, caption ও sort filters সাধারণ search-এ থাকে।
2. Creator `.vtt` captions upload/edit করতে পারেন। Transcript search index হয়; player-এ browser-native captions toggle এবং transcript panel থাকে।
3. Upload থেকে duration best-effort পড়া হয়, custom thumbnail R2-তে আলাদাভাবে রাখা হয় এবং creator timestamp chapters সম্পাদনা করতে পারেন।
4. Player-এ 0.75×–2× playback speed, buffering/error/retry state, signed R2 direct URL এবং account-based resume/continue-watching আছে। Video bytes Node server দিয়ে proxy হয় না; watch page playback-এর আগে R2 `HEAD` request করে না।
5. Creator Studio-তে best-effort sampled watch seconds, session counts, completion estimate ও 5%-bucket audience-retention curve আছে। Studio audience ও analytics view anonymous viewer hashes-ভিত্তিক aggregate signal দেখায়; traffic source বা demographic profile সংগ্রহ করে না। এগুলো unique-person guarantee বা payout proof নয়।
6. Signed-in viewers video/channel/comment report জমা দিতে পারেন; Admin/Moderator report triage করেন, Admin removed-video appeal reason-সহ review করতে পারেন এবং decisions audit হয়।

**Streaming limitation:** এই revision-এ upload file-কে HLS/DASH multi-bitrate renditions-এ transcode করার background worker নেই; তাই quality/adaptive bitrate selector-ও নেই। Direct R2 signed playback Node hop কমায়, কিন্তু source file-এর codec/bitrate অনুযায়ী mobile/slow-network performance এখনও বদলাতে পারে। Production-grade adaptive streaming-এর জন্য আলাদা queue/transcoding worker, HLS renditions, manifest access policy এবং end-to-end device/network testing লাগবে।

**Scale limitation:** এই feature release কোনো 5 কোটি registered বা ১ কোটি concurrent-user load-test/guarantee নয়। Render web process, Neon pooled connections, Socket.IO multi-instance fanout এবং analytics write capacity-তে বাস্তব workload-ভিত্তিক load test, queues, caching/CDN policies ও horizontal-scaling validation দরকার।

## Monetization: বর্তমান সীমা

এটি এখন **নিজস্ব sponsor campaign ও estimated-revenue framework**—Google AdSense/YouTube ad network integration নয়। Owner/admin campaign-এ HTTPS creative/landing URL এবং CPM (BDT/1,000 impressions) দেয়; Owner global ads delivery ও creator share চালু না করা পর্যন্ত visitor-কে ad দেখানো হয় না। `watch_sidebar` placement-এর public video-তে approved creator-এর revenue estimate record হয়। Home-feed ad impression creator-কে স্বয়ংক্রিয়ভাবে credit হয় না।

Owner-এর Platform settings থেকে monetization eligibility-এর **minimum subscriber** ও **minimum watch-hour milestone** বেছে নেওয়া যায় (default: 1,000 subscribers এবং 4,000 watch hours)। Creator Studio-তে channel-এর all-time subscribers এবং pseudonymous watch-session hours-এর বিপরীতে এই দুই milestone-এর green progress fill, eligibility এবং **Apply for monetization** action দেখা যায়। দুই milestone পূরণ ও platform monetization চালু থাকলে creator application পাঠাতে পারেন; Admin Panel থেকে Admin/Owner সেটি approve, pause বা reject করতে পারেন। Eligibility দেখানো হলেও creator monetization approval এবং platform monetization switch আলাদা admin control হিসেবে থাকে।

**এখানে real advertiser billing, contract/invoice, fraud review, tax handling, payout account বা creator cash payment নেই।** Creator Studio-র আয় কেবল campaign CPM ও configured share থেকে হিসাব করা estimate; এটি earned/withdrawable money-এর নিশ্চয়তা নয়। বাস্তবে টাকা দেওয়ার আগে advertiser payment, platform terms, Bangladesh tax/payment compliance, identity/eligibility review এবং payout provider আলাদাভাবে যুক্ত করতে হবে।

## কোথায় কোন ডেটা থাকে

| ডেটা | অবস্থান |
|---|---|
| ভিডিও ফাইল/বড় media object | Private Cloudflare R2 bucket |
| User account ID, email, profile ও channel handle | Neon PostgreSQL |
| Session hash/expiry, video title/description/category/visibility | Neon PostgreSQL |
| Likes, views, comments, subscriptions, playlists ও watch history | Neon PostgreSQL |
| Admin roles, platform settings, campaigns, ad events, strikes ও audit log | Neon PostgreSQL |
| Site code, Atharo UI assets | GitHub repository |

R2-তে পুরনো JSON metadata থাকলে migration command সেগুলো **copy/import** করবে; source R2 object মুছবে না। Video binary R2-তেই থাকবে। Campaign creative URL এখন HTTPS URL হিসেবে সংরক্ষিত হয়; ভিডিও ছাড়া অন্য কোনো media upload workflow যোগ করা হয়নি।

## Admin roles ও moderation

1. Render Environment-এ `OWNER_EMAIL`-কে Owner হিসেবে site-এ Google sign-in করতে ব্যবহৃত account-এর email দিন। Email code-এ নেই—role resolution server-side-এ হয়।
2. সেই verified Google account দিয়ে sign-in করলে account menu-তে **Admin control panel** link দেখা যায়; এটি `/admin`-কে fullscreen, sidebar-মুক্ত নতুন tab-এ খোলে। প্রথম Owner-কে panel থেকে সরানো বা demote করা যায় না।
3. Owner panel থেকে email অনুযায়ী অন্য **Admin** বা **Moderator** যোগ/বাদ দিতে পারবেন। তাঁরা নিজ নিজ Google account দিয়ে sign-in করলে role কার্যকর হবে। **Moderator** report triage ও video/channel moderation action করতে পারে, কিন্তু campaign, audit log, appeals review, staff roles, platform settings বা creator monetization approval করতে পারে না। **Admin** moderation, reports/video appeals/copyright-strike appeals, campaigns ও audit log পরিচালনা করতে পারে; তবে staff roles, platform-wide settings এবং creator monetization approval Owner-only। **Owner** সব controls পান।
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
