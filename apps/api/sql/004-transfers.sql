CREATE TABLE uploads (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES file_requests(id), org_id TEXT NOT NULL,
 sender_id TEXT NOT NULL, sender_device_id TEXT NOT NULL, project_id TEXT NOT NULL,
 size BIGINT NOT NULL CHECK(size BETWEEN 174 AND 16777350), digest TEXT NOT NULL,
 retention_days INTEGER NOT NULL CHECK(retention_days IN (1,3,7)),
 status TEXT NOT NULL CHECK(status IN ('reserved','writing','committed','failed','cancelled')),
 created_at BIGINT NOT NULL, write_until BIGINT, ended_at BIGINT, deleted_at BIGINT,
 available_until BIGINT, revoked_at BIGINT, acknowledged_at BIGINT,
 sender_identity TEXT NOT NULL, receiver_identity TEXT NOT NULL
);
CREATE UNIQUE INDEX one_open_upload ON uploads(request_id) WHERE status IN ('reserved','writing','committed');
CREATE INDEX uploads_org ON uploads(org_id);
CREATE TABLE transfer_challenges (
 id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
 body TEXT NOT NULL, secret_hash TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE download_leases (
 id TEXT PRIMARY KEY, upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL, day BIGINT NOT NULL, bytes BIGINT NOT NULL,
 expires_at BIGINT NOT NULL, finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN(0,1))
);
