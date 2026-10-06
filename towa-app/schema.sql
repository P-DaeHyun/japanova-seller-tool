CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY,email TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,
 password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS birth_profiles (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,gender TEXT NOT NULL,
 birth_date DATE NOT NULL,birth_time TIME,birth_time_known BOOLEAN NOT NULL DEFAULT FALSE,
 timezone_id TEXT NOT NULL DEFAULT 'Asia/Tokyo',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saju_profiles (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,engine_version TEXT NOT NULL,
 chart_json JSONB NOT NULL,calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS reading_reports (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_json JSONB NOT NULL,model_name TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS conversations (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
 id UUID PRIMARY KEY,conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS memories (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 category TEXT NOT NULL,fact TEXT NOT NULL,importance TEXT NOT NULL CHECK(importance IN ('low','medium','high')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,fact)
);
CREATE TABLE IF NOT EXISTS entitlements (
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,product_code TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 revoked_at TIMESTAMPTZ,PRIMARY KEY(user_id,product_code)
);
CREATE TABLE IF NOT EXISTS purchases (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product_code TEXT NOT NULL,amount_jpy INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'jpy',
 status TEXT NOT NULL CHECK(status IN ('creating','pending','paid','expired','refunded','disputed','failed')),
 stripe_checkout_session_id TEXT UNIQUE,stripe_payment_intent_id TEXT,stripe_customer_id TEXT,
 paid_at TIMESTAMPTZ,refunded_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
 event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id,created_at);