CREATE TABLE IF NOT EXISTS app_users (
  google_sub TEXT PRIMARY KEY,
  email TEXT,
  google_name TEXT NOT NULL DEFAULT '',
  google_picture TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  ADD COLUMN IF NOT EXISTS monetization_status TEXT NOT NULL DEFAULT 'pending';
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
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (creator_share_percent IS NULL OR (creator_share_percent >= 0 AND creator_share_percent <= 100))
);
INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  sponsor_name TEXT NOT NULL CHECK (char_length(sponsor_name) BETWEEN 1 AND 120),
  placement TEXT NOT NULL CHECK (placement IN ('feed','watch_sidebar')),
  creative_url TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  cpm_bdt NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (cpm_bdt >= 0),
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('draft','active','paused')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS ad_campaigns_serve_idx ON ad_campaigns (placement, status, starts_at, ends_at, created_at DESC);

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
