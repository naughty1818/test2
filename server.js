require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);
const MAX_LIST = 100; // home page e shorbocho koyta video dekhabe

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, APP_PASSWORD } = process.env;

const missing = Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, APP_PASSWORD })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error('ERROR: ei environment variable gulo set kora nai: ' + missing.join(', '));
  process.exit(1);
}

// ---------- Cloudflare R2 (S3-compatible) ----------
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  // Notun AWS SDK default e extra checksum jore, jeta browser upload bhenge dey. Tai bondho:
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});

// ---------- Simple password check ----------
function checkPassword(req, res, next) {
  const given = Buffer.from(String(req.get('x-app-password') || ''));
  const real = Buffer.from(APP_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: 'Password thik na.' });
  next();
}

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ maxFileMb: MAX_FILE_MB });
});

// Step 1: browser ke ekta temporary upload link (presigned URL) dei
app.post('/api/upload-url', checkPassword, async (req, res) => {
  try {
    const { filename, contentType, size } = req.body || {};
    if (typeof filename !== 'string' || !filename) return res.status(400).json({ error: 'Filename dao.' });
    if (typeof contentType !== 'string' || !contentType.startsWith('video/')) {
      return res.status(400).json({ error: 'Shudhu video file upload kora jabe.' });
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_MB * 1024 * 1024) {
      return res.status(400).json({ error: `File ${MAX_FILE_MB}MB er moddhe hote hobe.` });
    }

    const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(-100);
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const objectName = `videos/${id}-${safeName}`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectName, ContentType: contentType }),
      { expiresIn: 30 * 60 } // 30 minute
    );
    res.json({ uploadUrl, objectName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: upload shesh hole title/description save kori (ekta chhoto JSON file hishebe)
app.post('/api/finish', checkPassword, async (req, res) => {
  try {
    const { objectName, title, description } = req.body || {};
    const m = /^videos\/(\d+-[0-9a-f]{8})-[\w.\-]+$/.exec(typeof objectName === 'string' ? objectName : '');
    if (!m) return res.status(400).json({ error: 'Invalid object name.' });
    const id = m[1];

    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: objectName }));
    } catch (err) {
      if (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
        return res.status(404).json({ error: 'File R2 te paoa jay nai. Upload shesh hoyeche to?' });
      }
      throw err;
    }

    if (head.ContentLength > MAX_FILE_MB * 1024 * 1024) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: objectName }));
      return res.status(413).json({ error: `File ${MAX_FILE_MB}MB er beshi chhilo, delete kora hoyeche.` });
    }

    const meta = {
      objectName,
      title: String(title || '').trim().slice(0, 100) || objectName,
      description: String(description || '').trim().slice(0, 5000),
      size: head.ContentLength,
      created: new Date().toISOString()
    };
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `meta/${id}.json`,
      Body: JSON.stringify(meta),
      ContentType: 'application/json'
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Video list (private bucket theke 1 ghontar presigned URL diye)
app.get('/api/videos', async (req, res) => {
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'meta/' }));
    const metaObjects = (list.Contents || [])
      .sort((a, b) => b.LastModified - a.LastModified)
      .slice(0, MAX_LIST);

    const videos = await Promise.all(
      metaObjects.map(async (o) => {
        try {
          const r = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: o.Key }));
          const meta = JSON.parse(await r.Body.transformToString());
          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: R2_BUCKET, Key: meta.objectName }),
            { expiresIn: 60 * 60 }
          );
          return { title: meta.title, description: meta.description, size: meta.size, created: meta.created, url };
        } catch (err) {
          console.error('Skip', o.Key, err.message);
          return null;
        }
      })
    );
    res.json(videos.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => console.log(`Video Hub chalu: port ${PORT}`));
