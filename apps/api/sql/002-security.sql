CREATE TABLE passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  public_key BYTEA NOT NULL, counter BIGINT NOT NULL, label TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);
CREATE TABLE totp_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id), secret TEXT NOT NULL,
  last_counter BIGINT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE reauthentications (
  session_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  verified_at BIGINT NOT NULL
);
CREATE TABLE security_challenges (
  id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), purpose TEXT NOT NULL,
  challenge TEXT NOT NULL, label TEXT NOT NULL, expires_at BIGINT NOT NULL,
  UNIQUE(session_hash, purpose)
);
CREATE TABLE security_attempts (
  user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL,
  count INTEGER NOT NULL, until_at BIGINT NOT NULL, PRIMARY KEY(user_id, scope)
);
