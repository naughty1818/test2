# ClipNest — বাংলা ভিডিও প্ল্যাটফর্ম

Node.js/Express-ভিত্তিক বাংলা-first video sharing site। ClipNest-এর নিজস্ব coral/cream design রেখে পরিচিত video-platform patterns—discovery feed, creator subscriptions, comments, playlists, watch history এবং live interaction counts—যোগ করা হয়েছে। Layout ও branding নিজস্ব; কোনো existing platform-এর হুবহু UI কপি নয়।

## Feature set

- Google OAuth sign-in, Neon-এ user/profile/session data এবং public creator channel
- Direct-to-Cloudflare R2 video upload with progress, signed URLs, Private/Unlisted/Public visibility
- Neon-এ video metadata, likes, unique visitor views, comments/replies, creator subscriptions, playlists, Watch Later, watch history ও upload intents
- Socket.IO দিয়ে video page-এ live like/view/comment counts এবং channel-এ live subscriber count
- Home/discovery feed, category/search, subscription feed, recommendations, channel pages, history ও playlists
- Responsive Bengali UI, mobile navigation, share link ও owner-only video deletion

## কোথায় কোন ডেটা থাকে

| ডেটা | অবস্থান |
|---|---|
| ভিডিও ফাইল/বড় media object | Private Cloudflare R2 bucket |
| User account ID, email, profile ও channel handle | Neon PostgreSQL |
| Session hash/expiry, video title/description/category/visibility | Neon PostgreSQL |
| Likes, views, comments, subscriptions, playlists ও watch history | Neon PostgreSQL |
| Upload intent এবং interaction counters | Neon PostgreSQL |
| Site code, ClipNest UI assets | GitHub repository |

R2-তে পুরনো JSON metadata থাকলে migration command সেগুলো **copy/import** করবে; source R2 object মুছবে না। Video binary R2-তেই থাকবে।

## যা লাগবে

- Node.js 18+
- Neon PostgreSQL project (hosted app-এর জন্য Neon-এর pooled connection string সুপারিশ করা হয়)
- Cloudflare R2 private bucket ও ওই bucket-এ সীমিত Object Read & Write token
- Google Cloud OAuth 2.0 Web application client
- Render বা অন্য Node.js host-এ environment variables

## Neon ও পুরনো ডেটা migration

1. Neon-এ PostgreSQL project/database তৈরি করুন। Neon dashboard-এর **pooled connection string** নিন এবং `DATABASE_URL` হিসেবে hosting environment-এ দিন। Connection string গোপন রাখুন; browser/client code বা Git-এ দেবেন না।
2. Local `.env`-এ `DATABASE_URL`, R2 credentials এবং কমপক্ষে 32-character `SESSION_SECRET` দিন। `.env.example` template হিসেবে ব্যবহার করুন।
3. নতুন backend deploy করার আগে/সাথে পুরনো R2 JSON data একবার import করুন:

   ```bash
   npm install
   npm run migrate:r2
   ```

   Migration idempotent: সফল হলে `storage_migrations`-এ marker রাখে এবং পরের run-এ duplicate import করে না। `meta/`, `profiles/`, active sessions, likes ও views থেকে relational records তৈরি হয়। Original R2 objects untouched থাকে। `npm run migrate:r2` সম্পন্ন না হওয়া পর্যন্ত existing app-এর পুরনো metadata নতুন UI-তে আসবে না।
4. Migration success হলে GitHub থেকে নতুন app deploy করুন। Startup-এ server idempotently database tables/indexes তৈরি/নিশ্চিত করবে।

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

Only the video/media bytes remain in R2 as normal new app data; new accounts and application records are written to Neon.

## Google OAuth

1. Google Cloud Console-এ OAuth consent screen configure করুন; Testing mode হলে test user যোগ করুন।
2. OAuth Client ID-তে **Web application** বেছে নিন।
3. Authorized redirect URI-তে callback URI একদম হুবহু দিন: `https://YOUR-SITE.example/auth/google/callback`। Local development হলে `http://localhost:3000/auth/google/callback` যোগ করুন।
4. একই URI `GOOGLE_REDIRECT_URI`-তে দিন। `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` ও `GOOGLE_REDIRECT_URI` তিনটিই set করুন; client secret শুধু server-side environment-এ থাকবে।

## লোকালি চালানো

```bash
cp .env.example .env
# .env-এ DATABASE_URL, R2 values ও Google OAuth values দিন
openssl rand -hex 32   # output-টি SESSION_SECRET হিসেবে দিন
npm install
npm start
```

তারপর `http://localhost:3000` খুলুন। Socket.IO একই Express service-এ চালু হয়; আলাদা Socket.IO server লাগে না।

## Render-এ deploy

1. GitHub repository থেকে Node Web Service তৈরি করুন; build command `npm install`, start command `npm start`।
2. Render Environment-এ `.env.example`-এর variables দিন—বিশেষ করে `DATABASE_URL`, সব R2 credential, `SESSION_SECRET`, `NODE_ENV=production`, `GOOGLE_REDIRECT_URI` ও `APP_ORIGIN`। `APP_ORIGIN`-এ শুধু site origin দিন, যেমন `https://YOUR-SITE.example`।
3. Google OAuth redirect URI এবং R2 CORS-এ production URL মিলিয়ে দিন।
4. পুরনো app-এর data থাকলে migration সম্পন্ন/যাচাই করে তারপর deploy দিন।

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
| `SESSION_SECRET` | হ্যাঁ | Signed session/viewer cookies; অন্তত 32 characters |

## নিরাপত্তা ও privacy

- Neon/R2/Google secrets কেবল hosting environment বা local `.env`-এ রাখুন; `.env` commit করবেন না।
- Session token browser cookie-তে signed থাকে; database-এ raw token নয়, hash সংরক্ষিত হয়। Google email ও account data frontend-এ প্রকাশ করা হয় না।
- Public feed-এ শুধু Public videos আসে। Unlisted ভিডিও direct link-এ দেখা যায়; Private ভিডিও uploader ছাড়া দেখা যায় না। Signed media URL মেয়াদসীমাবদ্ধ।
- Like/comment/subscribe এবং playlist পরিবর্তনে লগইন লাগে। Video view browser-ভিত্তিক signed first-party cookie দিয়ে deduplicate হয়; cookie মুছলে/অন্য browser ব্যবহার করলে count আবার হতে পারে।
- R2-to-Neon migration source objects মুছে না। Neon data যাচাই না করে পুরনো R2 JSON নিজে থেকে delete করবেন না।
