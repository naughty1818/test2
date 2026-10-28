# Shared rate limits and PostgreSQL index rollout

## Redis on Render

The app uses Redis-backed rate-limit counters whenever `REDIS_URL` is set. In Render, create a Key Value/Redis service in the same region as the web service, copy its **internal** connection URL, and add it to the web service environment as `REDIS_URL`. Do not commit the URL or use a public Redis URL when the internal one is available. After saving the environment variable, redeploy. Startup logs should say `Shared Redis rate-limit store connected.` If `REDIS_URL` is empty, the site still starts but limits are only in each process's memory and are not shared.

If Redis becomes temporarily unavailable after connection, the app logs an error and fails open for that limiter so normal site requests are not all blocked; monitor that log and restore Redis promptly.

## Limits currently applied

- General `/api/*`: 300 requests per IP per minute.
- Google OAuth start/callback: 20 per IP per 15 minutes.
- Upload URL creation: 20 per IP per 15 minutes.
- Premium/Talent checkout: 20 per IP per 10 minutes.
- Exceeded limits return HTTP 429 and a `Retry-After` header; they are not permanent bans. OPTIONS preflight is skipped.

The general threshold is intentionally generous. Shared household/mobile-network IPs still share IP-based counters. If traffic grows across several servers, Redis keeps the counters shared across instances.

## PostgreSQL indexes

Startup applies six `CREATE INDEX CONCURRENTLY IF NOT EXISTS` indexes for premium order lookups, provider reference lookup, date-range ad analytics, and Talent buyer/provider order lists. Concurrent index creation avoids blocking normal writes, but the first startup can take longer while PostgreSQL builds indexes. Startup also drops the duplicate legacy withdrawal-status index concurrently. These are workload-based indexes; validate query plans and table sizes as the database grows.
