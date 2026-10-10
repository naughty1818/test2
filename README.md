# Video Hub R2

বাংলা-প্রথম ভিডিও শেয়ারিং ওয়েব অ্যাপ। Node.js/Express সার্ভার Google sign-in, signed upload/download link এবং metadata পরিচালনা করে; ভিডিও ফাইল সরাসরি private Cloudflare R2 bucket-এ যায়। আলাদা SQL database লাগে না—ভিডিও, প্রোফাইল ও interaction marker-ও R2-তে থাকে।

## ফিচার

- Google OAuth sign-in এবং প্রতি ব্যবহারকারীর চ্যানেল
- Drag-and-drop ভিডিও আপলোড, progress bar ও configurable file-size limit
- Public / Unlisted / Private visibility
- বাংলা category filter ও title/description search
- Video watch page, share link, view count ও account-based like
- Display name, unique handle ও bio-সহ editable public channel profile
- Private ভিডিও কেবল uploader দেখতে পারবেন
- পুরনো Video Hub metadata-র ভিডিও legacy public item হিসেবে দেখা যাবে

YouTube upload ও comments এই সংস্করণে নেই।

## যা লাগবে

- Node.js 18+
- Cloudflare R2 bucket এবং bucket-এ সীমাবদ্ধ Object Read & Write API token
- Google Cloud OAuth 2.0 **Web application** client
- Render বা অন্য Node.js hosting-এ environment variables সেট করার সুযোগ

## Cloudflare R2 সেটআপ

1. একটি R2 bucket তৈরি করে **private** রাখুন।
2. ওই bucket-টির জন্যই Object Read & Write permission-সহ API token তৈরি করুন।
3. Bucket Settings → CORS Policy-তে নিচের policy দিন। নিজের production site origin এবং local development origin বসান। `*` origin ব্যবহার করবেন না।

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

## Google OAuth সেটআপ

1. Google Cloud Console-এ project বেছে নিয়ে OAuth consent screen configure করুন। Testing অবস্থায় প্রয়োজনীয় test user যোগ করুন; সাধারণ ব্যবহারকারীর জন্য চালুর আগে Google-এর publication/verification নিয়ম অনুসরণ করুন।
2. OAuth Client ID তৈরি করার সময় **Web application** বেছে নিন।
3. Authorized redirect URI হিসেবে একদম হুবহু callback যোগ করুন:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://YOUR-SITE.example/auth/google/callback`
4. একই URI `GOOGLE_REDIRECT_URI` environment variable-এ দিন।
5. Sign-in-এর scope হলো `openid`, `email`, `profile`। Client secret শুধু server-side environment-এ রাখুন—কখনো frontend, `public/` বা Git commit-এ নয়।

R2 ও SESSION_SECRET দিয়ে public browsing চালাতে পারবেন; Google OAuth-এর GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI তিনটি variable না দিলে login ও upload বন্ধ থাকবে। OAuth চালু করতে তিনটিই সেট করুন। কোডে কোনো credentials বা user secret অন্তর্ভুক্ত নেই.

## লোকালি চালানো

```bash
cp .env.example .env
# .env-এ R2 ও Google OAuth মান দিন; SESSION_SECRET তৈরি করুন:
openssl rand -hex 32
npm install
npm start
```

তারপর `http://localhost:3000` খুলুন। `.env` commit করবেন না; `.gitignore`-এ এটি বাদ দেওয়া আছে।

## Render-এ deploy

1. GitHub repository থেকে Node Web Service তৈরি করুন।
2. Build command: `npm install`; Start command: `npm start`।
3. `.env.example`-এর variable-গুলো Render Environment-এ যোগ করুন। `NODE_ENV=production`, `GOOGLE_REDIRECT_URI=https://YOUR-SITE.example/auth/google/callback` এবং নতুন random `SESSION_SECRET` দিন।
4. Google OAuth client-এর Authorized redirect URI ও R2 CORS-এ production URL-গুলো যোগ করুন।

সব video/media এবং app metadata R2-তে থাকার কারণে সাধারণ stateless web-service restart-এ app data হারায় না। R2 bucket private রাখুন; access key browser code-এ দেবেন না।

## Environment variables

| নাম | দরকার? | কাজ |
|---|---|---|
| `PORT` | না | HTTP port; default `3000` |
| `NODE_ENV` | না | Production-এ `production` দিন; secure cookie চালু করে |
| `MAX_FILE_MB` | না | সর্বোচ্চ upload size; default `500` MB |
| `R2_ACCOUNT_ID` | হ্যাঁ | Cloudflare account ID |
| `R2_BUCKET` | হ্যাঁ | Private bucket-এর নাম |
| `R2_ACCESS_KEY_ID` | হ্যাঁ | Bucket-scoped access key |
| `R2_SECRET_ACCESS_KEY` | হ্যাঁ | Bucket-scoped secret |
| `GOOGLE_CLIENT_ID` | Login-এর জন্য | Google OAuth Web client ID |
| `GOOGLE_CLIENT_SECRET` | Login-এর জন্য | Google OAuth Web client secret |
| `GOOGLE_REDIRECT_URI` | Login-এর জন্য | Authorized callback URL |
| `APP_ORIGIN` | না | Login শেষে redirect; default `/` |
| `SESSION_SECRET` | হ্যাঁ | Session ও visitor cookie signing secret |

## Privacy ও পুরনো আপলোড

- OAuth/session signing secret, R2 keys ও Google client secret কেবল hosting environment-এ রাখুন; `.env.example`-এ কোনো আসল secret দেবেন না।
- Video link সময়সীমাবদ্ধ signed URL। Public ভিডিও feed/search-এ আসে; Unlisted ভিডিও link থাকলে দেখা যায়; Private ভিডিও uploader-এর জন্য সীমিত।
- Like দিতে Google account-এ login করতে হয়। View count first-party visitor cookie-ভিত্তিক এবং আনুমানিক; cookie মুছলে বা অন্য browser ব্যবহার করলে আবার count হতে পারে।
- আগের single-password Video Hub-এর metadata-তে owner/visibility না থাকলে পুরনো ভিডিও legacy public item হিসেবে থাকবে। সেগুলো নতুন Private/Unlisted নিয়মে স্বয়ংক্রিয়ভাবে বদলায় না; প্রয়োজন হলে R2 metadata migration বা access review করুন।
- ভিডিও ও ব্যক্তিগত তথ্য প্রকাশে প্রযোজ্য copyright, privacy ও data-protection নিয়ম মানুন।
