CREATE TABLE IF NOT EXISTS app_users (
  google_sub TEXT PRIMARY KEY,
  email TEXT,
  google_name TEXT NOT NULL DEFAULT '',
  google_picture TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS viewer_type TEXT NOT NULL DEFAULT 'normal';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_viewer_type_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_viewer_type_check CHECK (viewer_type IN ('islamic','normal'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS profiles (
  sub TEXT PRIMARY KEY REFERENCES app_users(google_sub) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Creator',
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS profiles_handle_lower_idx ON profiles (LOWER(handle));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_url TEXT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  object_name TEXT NOT NULL UNIQUE,
  owner_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled video',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'অন্যান্য',
  visibility TEXT NOT NULL DEFAULT 'Public' CHECK (visibility IN ('Public','Unlisted','Private')),
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  likes_count BIGINT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  views_count BIGINT NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  comments_count BIGINT NOT NULL DEFAULT 0 CHECK (comments_count >= 0)
);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS premium_price_bdt NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (premium_price_bdt >= 0);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS premium_free_preview BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS is_islamic BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS islamic_certification_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS islamic_reviewed_by_email TEXT,
  ADD COLUMN IF NOT EXISTS islamic_review_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS islamic_reviewed_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'videos_islamic_certification_status_check') THEN
    ALTER TABLE videos ADD CONSTRAINT videos_islamic_certification_status_check
      CHECK (islamic_certification_status IN ('not_applicable','pending','approved','rejected'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS videos_islamic_review_idx
  ON videos (created_at ASC) WHERE is_islamic=TRUE AND islamic_certification_status='pending';
CREATE INDEX IF NOT EXISTS videos_public_feed_idx ON videos (created_at DESC) WHERE visibility = 'Public';
CREATE INDEX IF NOT EXISTS videos_owner_created_idx ON videos (owner_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS videos_category_created_idx ON videos (category, created_at DESC) WHERE visibility = 'Public';
CREATE INDEX IF NOT EXISTS videos_title_search_idx ON videos USING GIN (to_tsvector('simple', title || ' ' || description));

CREATE TABLE IF NOT EXISTS video_likes (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, user_sub)
);
CREATE INDEX IF NOT EXISTS video_likes_user_idx ON video_likes (user_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS video_views (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, viewer_hash)
);
CREATE INDEX IF NOT EXISTS video_views_created_idx ON video_views (created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE comments ADD COLUMN IF NOT EXISTS creator_pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS creator_hidden BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS comments_video_created_idx ON comments (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (author_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  channel_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (subscriber_sub <> channel_sub),
  PRIMARY KEY (subscriber_sub, channel_sub)
);
CREATE INDEX IF NOT EXISTS subscriptions_channel_idx ON subscriptions (channel_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_subscriber_idx ON subscriptions (subscriber_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  is_watch_later BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS playlists_watch_later_unique_idx ON playlists (owner_sub) WHERE is_watch_later = TRUE;
CREATE INDEX IF NOT EXISTS playlists_owner_idx ON playlists (owner_sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id, video_id)
);
ALTER TABLE playlist_items ADD COLUMN IF NOT EXISTS is_free_preview BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS playlist_items_order_idx ON playlist_items (playlist_id, position, added_at DESC);

CREATE TABLE IF NOT EXISTS watch_history (
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  last_watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, video_id)
);
CREATE INDEX IF NOT EXISTS watch_history_recent_idx ON watch_history (user_sub, last_watched_at DESC);

CREATE TABLE IF NOT EXISTS upload_intents (
  id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  object_name TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  expected_size BIGINT NOT NULL CHECK (expected_size > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('Public','Unlisted','Private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_intents_expiry_idx ON upload_intents (expires_at);

CREATE TABLE IF NOT EXISTS storage_migrations (
  name TEXT PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);


-- Owner/admin controls, ad campaigns, creator analytics, and reversible moderation.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_account_status_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_account_status_check CHECK (account_status IN ('active','suspended','banned'));
  END IF;
END $$;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'videos_moderation_status_check') THEN
    ALTER TABLE videos ADD CONSTRAINT videos_moderation_status_check CHECK (moderation_status IN ('active','removed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS videos_moderation_owner_idx ON videos (moderation_status, owner_sub, created_at DESC);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS monetization_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS monetization_applied_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_monetization_status_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_monetization_status_check CHECK (monetization_status IN ('pending','enabled','paused','rejected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_members (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','moderator')),
  added_by_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ads_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  monetization_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  creator_share_percent NUMERIC(5,2),
  ad_feed_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ad_watch_sidebar_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ad_channel_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ad_sticky_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ad_postroll_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ad_l_banner_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  l_banner_duration_seconds INTEGER NOT NULL DEFAULT 10,
  l_banner_skippable BOOLEAN NOT NULL DEFAULT TRUE,
  feed_ad_every_rows SMALLINT NOT NULL DEFAULT 4 CHECK (feed_ad_every_rows BETWEEN 1 AND 20),
  ad_layout_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  monetization_min_subscribers INTEGER NOT NULL DEFAULT 1000,
  monetization_min_watch_hours NUMERIC(12,2) NOT NULL DEFAULT 4000,
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (creator_share_percent IS NULL OR (creator_share_percent >= 0 AND creator_share_percent <= 100)),
  CHECK (monetization_min_subscribers BETWEEN 1 AND 1000000000),
  CHECK (monetization_min_watch_hours > 0 AND monetization_min_watch_hours <= 1000000000)
);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_feed_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_watch_sidebar_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_channel_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_sticky_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_postroll_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_l_banner_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS l_banner_duration_seconds INTEGER NOT NULL DEFAULT 10;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS l_banner_skippable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS feed_ad_every_rows SMALLINT NOT NULL DEFAULT 4;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS ad_layout_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS monetization_min_subscribers INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS monetization_min_watch_hours NUMERIC(12,2) NOT NULL DEFAULT 4000;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS premium_platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 20;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_monetization_min_subscribers_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_monetization_min_subscribers_check CHECK (monetization_min_subscribers BETWEEN 1 AND 1000000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_monetization_min_watch_hours_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_monetization_min_watch_hours_check CHECK (monetization_min_watch_hours > 0 AND monetization_min_watch_hours <= 1000000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_premium_platform_fee_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_premium_platform_fee_check CHECK (premium_platform_fee_percent >= 0 AND premium_platform_fee_percent <= 100);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_feed_ad_every_rows_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_feed_ad_every_rows_check CHECK (feed_ad_every_rows BETWEEN 1 AND 20);
  END IF;
END $$;
INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  sponsor_name TEXT NOT NULL CHECK (char_length(sponsor_name) BETWEEN 1 AND 120),
  placement TEXT NOT NULL CHECK (placement IN ('feed','watch_sidebar','channel','sticky_banner','postroll','l_banner')),
  creative_url TEXT NOT NULL,
  desktop_creative_url TEXT,
  mobile_creative_url TEXT,
  destination_url TEXT NOT NULL,
  l_bottom_creative_url TEXT,
  l_bottom_destination_url TEXT,
  monthly_impression_cap INTEGER CHECK (monthly_impression_cap IS NULL OR monthly_impression_cap >= 1),
  cpm_bdt NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (cpm_bdt >= 0),
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('draft','active','paused')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS l_bottom_creative_url TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS l_bottom_destination_url TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS desktop_creative_url TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS mobile_creative_url TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS monthly_impression_cap INTEGER;
UPDATE ad_campaigns SET desktop_creative_url=COALESCE(desktop_creative_url,creative_url),mobile_creative_url=COALESCE(mobile_creative_url,creative_url)
  WHERE desktop_creative_url IS NULL OR mobile_creative_url IS NULL;
UPDATE ad_campaigns SET l_bottom_creative_url=COALESCE(l_bottom_creative_url,creative_url),
  l_bottom_destination_url=COALESCE(l_bottom_destination_url,destination_url)
  WHERE placement='l_banner' AND (l_bottom_creative_url IS NULL OR l_bottom_destination_url IS NULL);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ad_campaigns_monthly_impression_cap_check') THEN
    ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_monthly_impression_cap_check CHECK (monthly_impression_cap IS NULL OR monthly_impression_cap >= 1);
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;
  ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_placement_check CHECK (placement IN ('feed','watch_sidebar','channel','sticky_banner','postroll','l_banner'));
EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ad_campaigns_serve_idx ON ad_campaigns (placement, status, starts_at, ends_at, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_monthly_serves (
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  served_count INTEGER NOT NULL DEFAULT 0 CHECK (served_count >= 0),
  PRIMARY KEY (campaign_id, month_start)
);

CREATE TABLE IF NOT EXISTS ad_events (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
  creator_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression','click')),
  dedupe_key TEXT NOT NULL,
  estimated_creator_earnings_bdt NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (estimated_creator_earnings_bdt >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, event_type, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ad_events_creator_created_idx ON ad_events (creator_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_events_campaign_created_idx ON ad_events (campaign_id, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS copyright_strikes (
  id UUID PRIMARY KEY,
  video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
  channel_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 2000),
  evidence_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','appealed','dismissed','resolved')),
  appeal_text TEXT,
  issued_by_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  appealed_at TIMESTAMPTZ,
  resolved_by_email TEXT,
  resolved_at TIMESTAMPTZ
);
ALTER TABLE copyright_strikes ADD COLUMN IF NOT EXISTS resolution_note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS copyright_strikes_channel_created_idx ON copyright_strikes (channel_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_logs (created_at DESC);


-- Learning-first creator/video features. These changes are additive and safe to re-run at startup.
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS thumbnail_object_name TEXT,
  ADD COLUMN IF NOT EXISTS class_level TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS syllabus_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_intents
  ADD COLUMN IF NOT EXISTS class_level TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS syllabus_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_islamic BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS videos_public_education_idx
  ON videos (class_level, subject, duration_seconds, created_at DESC)
  WHERE visibility='Public' AND moderation_status='active';
CREATE INDEX IF NOT EXISTS videos_syllabus_tags_gin_idx ON videos USING GIN (syllabus_tags);

CREATE TABLE IF NOT EXISTS video_captions (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  label TEXT NOT NULL DEFAULT '',
  vtt_body TEXT NOT NULL CHECK (char_length(vtt_body) BETWEEN 6 AND 2000000),
  transcript_text TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, language_code)
);
CREATE INDEX IF NOT EXISTS video_captions_search_gin_idx
  ON video_captions USING GIN (to_tsvector('simple', transcript_text));
CREATE UNIQUE INDEX IF NOT EXISTS video_captions_one_default_idx
  ON video_captions (video_id) WHERE is_default=TRUE;

CREATE TABLE IF NOT EXISTS video_chapters (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 99),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, position),
  UNIQUE (video_id, start_seconds)
);
CREATE INDEX IF NOT EXISTS video_chapters_time_idx ON video_chapters (video_id, start_seconds);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  current_seconds REAL NOT NULL DEFAULT 0 CHECK (current_seconds >= 0),
  duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, video_id)
);
CREATE INDEX IF NOT EXISTS watch_progress_recent_idx ON watch_progress (user_sub, updated_at DESC);

-- Pseudonymous daily aggregates: no raw IP address or Google identifier is retained here.
CREATE TABLE IF NOT EXISTS video_watch_sessions (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL CHECK (char_length(viewer_hash)=64),
  watch_day DATE NOT NULL DEFAULT CURRENT_DATE,
  watch_seconds REAL NOT NULL DEFAULT 0 CHECK (watch_seconds >= 0),
  max_position_seconds REAL NOT NULL DEFAULT 0 CHECK (max_position_seconds >= 0),
  duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, viewer_hash, watch_day)
);
CREATE INDEX IF NOT EXISTS video_watch_sessions_video_day_idx ON video_watch_sessions (video_id, watch_day);

CREATE TABLE IF NOT EXISTS video_retention_buckets (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL CHECK (char_length(viewer_hash)=64),
  watch_day DATE NOT NULL DEFAULT CURRENT_DATE,
  bucket SMALLINT NOT NULL CHECK (bucket BETWEEN 0 AND 19),
  PRIMARY KEY (video_id, viewer_hash, watch_day, bucket)
);
CREATE INDEX IF NOT EXISTS video_retention_video_bucket_idx ON video_retention_buckets (video_id, bucket, watch_day);

CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY,
  reporter_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('video','channel','comment')),
  target_id TEXT NOT NULL,
  video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
  channel_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  comment_id UUID REFERENCES comments(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('spam','harassment','harmful','copyright','misinformation','other')),
  details TEXT NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','action_taken','dismissed')),
  resolution TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS content_reports_status_created_idx ON content_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS content_reports_reporter_created_idx ON content_reports (reporter_sub, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS content_reports_one_open_per_reporter_idx
  ON content_reports (reporter_sub, target_type, target_id) WHERE status IN ('open','reviewing');

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id UUID PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  appellant_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  appeal_text TEXT NOT NULL CHECK (char_length(appeal_text) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS moderation_appeals_one_pending_idx
  ON moderation_appeals (video_id, appellant_sub) WHERE status='pending';
CREATE INDEX IF NOT EXISTS moderation_appeals_status_created_idx ON moderation_appeals (status, created_at DESC);


-- Approved creator channels, creator playlists, verification, viewer feedback, and realtime notifications.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS creator_type TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_channel_type_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_channel_type_check CHECK (channel_type IN ('general','personal','education','business','organization','other'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_creator_type_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_creator_type_check CHECK (creator_type IN ('islamic','normal','mixed'));
  END IF;
END $$;

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_creator_playlist BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS price_bdt NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price_bdt >= 0);
ALTER TABLE upload_intents ADD COLUMN IF NOT EXISTS creator_playlist_id UUID REFERENCES playlists(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS playlists_premium_catalog_idx ON playlists (is_premium, is_public, updated_at DESC) WHERE is_creator_playlist=TRUE;

CREATE TABLE IF NOT EXISTS premium_playlist_orders (
  id UUID PRIMARY KEY,
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK (amount_bdt > 0),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','refunded','failed')),
  payment_provider TEXT NOT NULL DEFAULT 'demo',
  provider_reference TEXT,
  provider_invoice_id TEXT,
  payment_method TEXT,
  checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ
);
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS provider_invoice_id TEXT;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS checkout_url TEXT;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS premium_orders_provider_invoice_idx ON premium_playlist_orders (provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS premium_orders_one_paid_idx ON premium_playlist_orders (playlist_id,buyer_sub) WHERE status='paid';
CREATE INDEX IF NOT EXISTS premium_orders_playlist_idx ON premium_playlist_orders (playlist_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS premium_orders_buyer_idx ON premium_playlist_orders (buyer_sub,status,created_at DESC);

CREATE TABLE IF NOT EXISTS premium_playlist_entitlements (
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES premium_playlist_orders(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id,buyer_sub)
);
CREATE INDEX IF NOT EXISTS premium_entitlements_buyer_idx ON premium_playlist_entitlements (buyer_sub,granted_at DESC);

CREATE TABLE IF NOT EXISTS premium_video_orders (
  id UUID PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK (amount_bdt > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded','failed')),
  payment_provider TEXT NOT NULL DEFAULT 'nogorpay',
  provider_reference TEXT,
  provider_invoice_id TEXT,
  payment_method TEXT,
  checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS premium_video_orders_one_paid_idx ON premium_video_orders (video_id,buyer_sub) WHERE status='paid';
CREATE UNIQUE INDEX IF NOT EXISTS premium_video_orders_invoice_idx ON premium_video_orders (provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS premium_video_entitlements (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES premium_video_orders(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id,buyer_sub)
);

CREATE TABLE IF NOT EXISTS creator_withdrawal_requests (
  id UUID PRIMARY KEY,
  creator_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK (amount_bdt > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('bkash','nagad','rocket','upay','bank')),
  account_number TEXT NOT NULL CHECK (char_length(account_number) BETWEEN 6 AND 80),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected','cancelled')),
  creator_note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS creator_withdrawals_creator_idx ON creator_withdrawal_requests (creator_sub,status,created_at DESC);
CREATE INDEX IF NOT EXISTS creator_withdrawals_status_idx ON creator_withdrawal_requests (status,created_at ASC);

CREATE TABLE IF NOT EXISTS channel_applications (
  id UUID PRIMARY KEY,
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  channel_name TEXT NOT NULL CHECK (char_length(channel_name) BETWEEN 2 AND 120),
  channel_type TEXT NOT NULL CHECK (channel_type IN ('personal','education','business','organization','other')),
  creator_type TEXT NOT NULL DEFAULT 'normal' CHECK (creator_type IN ('islamic','normal','mixed')),
  other_platform_name TEXT NOT NULL DEFAULT '',
  other_platform_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
ALTER TABLE channel_applications ADD COLUMN IF NOT EXISTS creator_type TEXT NOT NULL DEFAULT 'normal';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_applications_creator_type_check') THEN
    ALTER TABLE channel_applications ADD CONSTRAINT channel_applications_creator_type_check CHECK (creator_type IN ('islamic','normal','mixed'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS channel_applications_one_pending_per_user_idx
  ON channel_applications (user_sub) WHERE status='pending';
CREATE INDEX IF NOT EXISTS channel_applications_review_idx ON channel_applications (status,created_at ASC);

CREATE TABLE IF NOT EXISTS channel_verification_requests (
  id UUID PRIMARY KEY,
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 20 AND 2000),
  proof_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_verification_one_pending_per_user_idx
  ON channel_verification_requests (user_sub) WHERE status='pending';
CREATE INDEX IF NOT EXISTS channel_verification_review_idx ON channel_verification_requests (status,created_at ASC);

CREATE TABLE IF NOT EXISTS video_feedback (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  feedback TEXT NOT NULL CHECK (feedback IN ('interested','not_interested')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id,user_sub)
);
CREATE INDEX IF NOT EXISTS video_feedback_user_idx ON video_feedback (user_sub,feedback,updated_at DESC);

CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY,
  recipient_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  actor_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '/',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_notifications_recipient_created_idx ON user_notifications (recipient_sub,created_at DESC);
CREATE INDEX IF NOT EXISTS user_notifications_unread_idx ON user_notifications (recipient_sub,created_at DESC) WHERE read_at IS NULL;


-- Premium single-video sales, playlist previews, configurable sales fees and creator payouts.
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price_bdt NUMERIC(12,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='videos_price_bdt_check') THEN
    ALTER TABLE videos ADD CONSTRAINT videos_price_bdt_check CHECK (price_bdt >= 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS videos_premium_catalog_idx ON videos (created_at DESC) WHERE is_premium=TRUE AND visibility='Public';

ALTER TABLE playlist_items ADD COLUMN IF NOT EXISTS is_preview BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS video_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS playlist_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 20;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_video_commission_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_video_commission_check CHECK(video_commission_percent BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_settings_playlist_commission_check') THEN
    ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_playlist_commission_check CHECK(playlist_commission_percent BETWEEN 0 AND 100);
  END IF;
END $$;

ALTER TABLE premium_playlist_orders ALTER COLUMN playlist_id DROP NOT NULL;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS video_id TEXT REFERENCES videos(id) ON DELETE RESTRICT;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2);
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS platform_fee_bdt NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE premium_playlist_orders ADD COLUMN IF NOT EXISTS creator_earning_bdt NUMERIC(12,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='premium_order_exactly_one_content_check') THEN
    ALTER TABLE premium_playlist_orders ADD CONSTRAINT premium_order_exactly_one_content_check
      CHECK ((playlist_id IS NOT NULL) <> (video_id IS NOT NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS premium_orders_one_paid_video_idx
  ON premium_playlist_orders(video_id,buyer_sub) WHERE video_id IS NOT NULL AND status='paid';

CREATE TABLE IF NOT EXISTS premium_video_entitlements (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES premium_playlist_orders(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(video_id,buyer_sub)
);
CREATE INDEX IF NOT EXISTS premium_video_entitlements_buyer_idx ON premium_video_entitlements(buyer_sub,granted_at DESC);

CREATE TABLE IF NOT EXISTS creator_wallet_ledger (
  id UUID PRIMARY KEY,
  creator_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  order_id UUID NOT NULL UNIQUE REFERENCES premium_playlist_orders(id) ON DELETE RESTRICT,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK(amount_bdt >= 0),
  entry_type TEXT NOT NULL DEFAULT 'sale' CHECK(entry_type IN('sale','adjustment')),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS creator_wallet_ledger_creator_idx ON creator_wallet_ledger(creator_sub,created_at DESC);

CREATE TABLE IF NOT EXISTS creator_withdrawal_requests (
  id UUID PRIMARY KEY,
  creator_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK(amount_bdt > 0),
  payout_method TEXT NOT NULL CHECK(payout_method IN('bkash','nagad','bank')),
  payout_details_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','paid')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS creator_withdrawals_creator_created_idx ON creator_withdrawal_requests(creator_sub,created_at DESC);
CREATE INDEX IF NOT EXISTS creator_withdrawals_review_idx ON creator_withdrawal_requests(status,created_at ASC);


-- Shop access is gated by an Admin/Owner-reviewed seller application.
CREATE TABLE IF NOT EXISTS shop_applications (
  id UUID PRIMARY KEY,
  user_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE CASCADE,
  business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 2 AND 120),
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  phone TEXT NOT NULL CHECK (char_length(phone) BETWEEN 6 AND 40),
  address TEXT NOT NULL CHECK (char_length(address) BETWEEN 5 AND 500),
  business_type TEXT NOT NULL CHECK (char_length(business_type) BETWEEN 2 AND 80),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 20 AND 2000),
  product_types TEXT NOT NULL CHECK (char_length(product_types) BETWEEN 2 AND 500),
  social_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_applications_one_pending_idx
  ON shop_applications(user_sub) WHERE status='pending';
CREATE INDEX IF NOT EXISTS shop_applications_review_idx ON shop_applications(status,created_at ASC);

CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL UNIQUE REFERENCES app_users(google_sub) ON DELETE CASCADE,
  application_id UUID NOT NULL UNIQUE REFERENCES shop_applications(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 2 AND 120),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  approved_by_email TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS shops_status_idx ON shops(status,approved_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),
  price_bdt NUMERIC(12,2) NOT NULL CHECK (price_bdt > 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 80),
  good_points TEXT NOT NULL DEFAULT '',
  limitations TEXT NOT NULL DEFAULT '',
  delivery_info TEXT NOT NULL DEFAULT '',
  return_policy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('draft','pending_review','approved','rejected','hidden','out_of_stock')),
  decision_note TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS products_public_idx ON products(status,created_at DESC) WHERE status='approved';
CREATE INDEX IF NOT EXISTS products_owner_idx ON products(owner_sub,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN (to_tsvector('simple', name || ' ' || description || ' ' || category));

CREATE TABLE IF NOT EXISTS product_videos (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  good_start_second INTEGER NOT NULL DEFAULT 0 CHECK (good_start_second >= 0),
  limitation_start_second INTEGER NOT NULL DEFAULT 0 CHECK (limitation_start_second >= 0),
  details_start_second INTEGER NOT NULL DEFAULT 0 CHECK (details_start_second >= 0)
);

CREATE TABLE IF NOT EXISTS carts (
  buyer_sub TEXT PRIMARY KEY REFERENCES app_users(google_sub) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cart_items (
  buyer_sub TEXT NOT NULL REFERENCES carts(buyer_sub) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (buyer_sub,product_id)
);
CREATE TABLE IF NOT EXISTS shop_orders (
  id UUID PRIMARY KEY,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  total_amount_bdt NUMERIC(12,2) NOT NULL CHECK (total_amount_bdt > 0),
  shipping_address TEXT NOT NULL CHECK (char_length(shipping_address) BETWEEN 5 AND 1000),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  order_status TEXT NOT NULL DEFAULT 'placed' CHECK (order_status IN ('placed','confirmed','processing','shipped','delivered','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shop_order_items (
  order_id UUID NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  seller_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_bdt NUMERIC(12,2) NOT NULL CHECK (unit_price_bdt > 0),
  PRIMARY KEY (order_id,product_id)
);
CREATE INDEX IF NOT EXISTS shop_orders_buyer_idx ON shop_orders(buyer_sub,created_at DESC);
CREATE INDEX IF NOT EXISTS shop_order_items_seller_idx ON shop_order_items(seller_sub,order_id);
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'nogorpay';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS provider_reference TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS provider_invoice_id TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS checkout_url TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_provider_invoice_idx ON shop_orders(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;

-- Atharo Talent: service listings and project-based hiring (separate from physical Shop orders).
CREATE TABLE IF NOT EXISTS talent_listings (
  id UUID PRIMARY KEY,
  provider_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK(char_length(title) BETWEEN 4 AND 120),
  description TEXT NOT NULL CHECK(char_length(description) BETWEEN 20 AND 4000),
  category TEXT NOT NULL CHECK(category IN('software-development','web-design','tutoring','graphic-design','writing-translation','video-editing','other')),
  skills TEXT[] NOT NULL DEFAULT '{}',
  requirements TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS talent_listings_public_idx ON talent_listings(category,updated_at DESC) WHERE status='published';
CREATE INDEX IF NOT EXISTS talent_listings_search_idx ON talent_listings USING GIN(to_tsvector('simple',title||' '||description));
CREATE INDEX IF NOT EXISTS talent_listings_skills_idx ON talent_listings USING GIN(skills);
CREATE TABLE IF NOT EXISTS talent_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES talent_listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 40),
  scope TEXT NOT NULL CHECK(char_length(scope) BETWEEN 1 AND 1000),
  price_bdt NUMERIC(12,2) NOT NULL CHECK(price_bdt>0),
  delivery_days INTEGER NOT NULL CHECK(delivery_days BETWEEN 1 AND 365),
  revisions SMALLINT NOT NULL DEFAULT 0 CHECK(revisions BETWEEN 0 AND 20),
  position SMALLINT NOT NULL DEFAULT 0,
  UNIQUE(listing_id,position)
);
CREATE TABLE IF NOT EXISTS talent_portfolio_videos (
  listing_id UUID NOT NULL REFERENCES talent_listings(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE RESTRICT,
  position SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY(listing_id,video_id),
  UNIQUE(listing_id,position)
);
CREATE TABLE IF NOT EXISTS talent_orders (
  id UUID PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES talent_listings(id) ON DELETE RESTRICT,
  package_id UUID NOT NULL REFERENCES talent_packages(id) ON DELETE RESTRICT,
  buyer_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  provider_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK(amount_bdt>0),
  contract_snapshot JSONB NOT NULL,
  buyer_brief TEXT NOT NULL CHECK(char_length(buyer_brief) BETWEEN 20 AND 4000),
  status TEXT NOT NULL DEFAULT 'awaiting_provider' CHECK(status IN('awaiting_provider','awaiting_payment','in_progress','submitted','revision_requested','completed','declined','cancelled','disputed','refunded','payment_failed')),
  revisions_used SMALLINT NOT NULL DEFAULT 0 CHECK(revisions_used>=0),
  provider_invoice_id TEXT,
  checkout_url TEXT,
  provider_reference TEXT,
  paid_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  provider_accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_invoice_id),
  CHECK(buyer_sub<>provider_sub)
);
CREATE INDEX IF NOT EXISTS talent_orders_buyer_idx ON talent_orders(buyer_sub,created_at DESC);
CREATE INDEX IF NOT EXISTS talent_orders_provider_idx ON talent_orders(provider_sub,status,created_at DESC);
CREATE TABLE IF NOT EXISTS talent_order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES talent_orders(id) ON DELETE RESTRICT,
  actor_sub TEXT REFERENCES app_users(google_sub) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS talent_order_events_order_idx ON talent_order_events(order_id,created_at);
CREATE TABLE IF NOT EXISTS talent_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES talent_orders(id) ON DELETE RESTRICT,
  note TEXT NOT NULL DEFAULT '',
  delivery_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(char_length(note)<=2000),
  CHECK(delivery_url IS NULL OR delivery_url ~* '^https://')
);
CREATE INDEX IF NOT EXISTS talent_deliverables_order_idx ON talent_deliverables(order_id,created_at DESC);
CREATE TABLE IF NOT EXISTS talent_earnings (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES talent_orders(id) ON DELETE RESTRICT,
  provider_sub TEXT NOT NULL REFERENCES app_users(google_sub) ON DELETE RESTRICT,
  amount_bdt NUMERIC(12,2) NOT NULL CHECK(amount_bdt>0),
  status TEXT NOT NULL DEFAULT 'pending_payout' CHECK(status IN('pending_payout','paid','reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS talent_earnings_provider_idx ON talent_earnings(provider_sub,status,created_at DESC);
