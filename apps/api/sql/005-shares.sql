CREATE TABLE external_shares (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, environment_id TEXT NOT NULL, creator_id TEXT NOT NULL,
 size BIGINT NOT NULL CHECK(size BETWEEN 40 AND 16777216), digest TEXT NOT NULL,
 retention_days INTEGER NOT NULL CHECK(retention_days IN(1,3,7)), token_hash TEXT,
 status TEXT NOT NULL CHECK(status IN('reserved','writing','committed','failed','cancelled')),
 created_at BIGINT NOT NULL, write_until BIGINT, ended_at BIGINT, deleted_at BIGINT,
 available_until BIGINT, revoked_at BIGINT, acknowledged_at BIGINT
);
CREATE INDEX shares_org ON external_shares(org_id,created_at);
CREATE TABLE share_operations (
 user_id TEXT NOT NULL, operation_id TEXT NOT NULL, share_id TEXT NOT NULL REFERENCES external_shares(id) ON DELETE CASCADE,
 input_hash TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE share_download_leases (
 id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES external_shares(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL, day BIGINT NOT NULL, bytes BIGINT NOT NULL,
 expires_at BIGINT NOT NULL, finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN(0,1))
);
CREATE VIEW stored_objects AS
 SELECT id,org_id,size,status,deleted_at FROM uploads UNION ALL SELECT id,org_id,size,status,deleted_at FROM external_shares;
CREATE VIEW creation_attempts AS
 SELECT receiver_id AS user_id,created_at FROM file_requests UNION ALL SELECT sender_id,created_at FROM uploads UNION ALL SELECT creator_id,created_at FROM external_shares;
CREATE VIEW all_download_leases AS
 SELECT id,upload_id AS object_id,org_id,day,bytes,expires_at,finished FROM download_leases UNION ALL SELECT id,share_id,org_id,day,bytes,expires_at,finished FROM share_download_leases;
