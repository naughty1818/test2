# Video Hub (Render + Cloudflare R2)

Video upload website. Browser theke video **shorashori Cloudflare R2 te** jay, Render server shudhu temporary upload link ar video list dey. Tai Render er free plan e-o boro video upload kora jay.

```
Browser --(1) upload link chai--> Render server (Node.js)
Browser --(2) video PUT--------> Cloudflare R2
Browser --(3) title save koro--> Render server
```

> Dashboard er menu/button er naam kichu somoy bodle jay. Ekdom hubohu na milleo kache er naam dekhe nio.

---

## Step 1: Cloudflare R2 te bucket banano

1. https://dash.cloudflare.com e free account kholo.
2. Left menu theke **R2 Object Storage** e jao. Prothom bar R2 chalu korte payment method (card) chaite pare. Free limit er moddhe thakle taka kete na, kintu card dite hote pare.
3. **Create bucket** click koro. Naam dao (jemon `video-hub`), eta tomar `R2_BUCKET`. Bucket **private** thakbe (public access on korbe na).
4. R2 er page e (right side e) tomar **Account ID** dekha jabe. Eta copy kore rakho, eta `R2_ACCOUNT_ID`.

## Step 2: API token banano

1. R2 page e **Manage API Tokens** (ba **API > Manage**) e jao.
2. **Create API token** click koro.
3. Permission: **Object Read & Write**. Bucket: sudhu tomar `video-hub` bucket select koro.
4. Create korle ekta **Access Key ID** ar ekta **Secret Access Key** dekhabe. **Secret ta shudhu ekbar dekhabe**, ekhuni copy kore rakho.
   - Access Key ID = `R2_ACCESS_KEY_ID`
   - Secret Access Key = `R2_SECRET_ACCESS_KEY`

## Step 3: CORS set kora (browser theke upload er jonno must)

1. Tomar bucket e click koro > **Settings** > **CORS Policy** > **Add CORS policy**.
2. Ei project er `cors.json` file er content ta paste koro > Save.

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

(Pore chaile `"*"` er jayga nijer Render URL dite paro, jemon `https://video-hub.onrender.com`)

## Step 4: Code GitHub e rakho

1. https://github.com e notun repository banao (naam: `video-hub`).
2. **Add file > Upload files** diye ei folder er file gulo upload koro: `server.js`, `package.json`, `README.md`, `cors.json`, `.env.example`, `.gitignore`, ar `public` folder (bhitore `index.html`).
   - `.env` file ba kono secret key upload korba na.
3. Commit koro.

## Step 5: Render e deploy

1. https://render.com e GitHub diye sign up koro.
2. **New > Web Service** > tomar `video-hub` repo select koro.
3. Settings:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Environment Variables** e 5 ta add koro:

   | Name | Value |
   |---|---|
   | `R2_ACCOUNT_ID` | Step 1 er Account ID |
   | `R2_BUCKET` | bucket er naam |
   | `R2_ACCESS_KEY_ID` | Step 2 er Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | Step 2 er Secret Access Key |
   | `APP_PASSWORD` | upload er jonno ekta shokto password |

5. **Create Web Service** click koro. Kichukkhon por Render ekta link dibe (`https://...onrender.com`).

## Step 6: Test

Website e jao, ekta chhoto video select koro, password dao, Upload click koro. Hoye gele nicher list e video dekha jabe.

---

## Shomossha hole

| Ki hocche | Karon |
|---|---|
| "Network/CORS error" ba "R2 upload fail (403)" | Step 3 (CORS) hoy nai, ba Account ID/bucket er naam bhul, ba token e bucket er Read & Write permission nai |
| "Password thik na" | `APP_PASSWORD` Render e ja diyecho seta dao |
| Render log e `ei environment variable gulo set kora nai` | Step 5 er 5 ta variable-i deya hoyeche kina dekho |
| Prothom bar page khulte onek time lage | Render free plan e kichukkhon use na korle server ghumiye jay, ~30-60 second lage jagte |
| Upload hoyeche kintu list e dekhay na | "Shesh kortechi" step fail hoyeche. Render er Logs e error dekho |

## Khoroch niye

- R2 te ekta free limit ache (storage, request), tar beshi hole taka lage. Cloudflare dashboard e usage mathay mathay dekhe nio.
- `APP_PASSWORD` ache bole shudhu tumi upload korte parbe. Video dekhar link page e ashe, ar seta shobai dekhte pabe jar kache website er URL ache.
- Home page e shobcheye notun 100 ta video dekhay.

## Nijer computer e chalate chaile

```
npm install
cp .env.example .env    # tarpor .env e R2 er value gulo boshao
npm start
```
Tarpor http://localhost:3000
