CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text UNIQUE NOT NULL,
  photon_user_id text,
  opted_out boolean NOT NULL DEFAULT false,
  activated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slouch_seconds integer NOT NULL DEFAULT 30,
  sensitivity text NOT NULL DEFAULT 'medium',
  voice_id text NOT NULL,
  audio_enabled boolean NOT NULL DEFAULT true,
  snoozed_until bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  minutes integer NOT NULL,
  good_pct integer NOT NULL,
  alerts integer NOT NULL,
  top_issue text,
  stats jsonb NOT NULL,
  recap text
);

CREATE TABLE IF NOT EXISTS slouch_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text,
  issue text NOT NULL,
  sustained_seconds integer NOT NULL,
  nudge_text text NOT NULL,
  delivery_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS events_user_idx ON slouch_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_user_idx ON conversation_messages(user_id, created_at DESC);
