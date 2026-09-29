CREATE TABLE beta_codes (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= max_uses),
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);
CREATE TABLE beta_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activated_at BIGINT NOT NULL,
  code_id TEXT REFERENCES beta_codes(id) ON DELETE SET NULL
);
-- Preserve participants explicitly admitted through the former operator-only opening invitation.
INSERT INTO beta_members(user_id,activated_at)
SELECT i.accepted_by, min(i.created_at) FROM invitations i JOIN users u ON u.id=i.accepted_by
WHERE i.kind='owner' AND i.status='accepted' GROUP BY i.accepted_by;
