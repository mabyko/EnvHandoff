CREATE TABLE environment_publication_heads (
 environment_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, generation TEXT NOT NULL, version_id TEXT,
 end_reason TEXT
);
CREATE TABLE environment_versions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 publisher_user_id TEXT NOT NULL, publisher_device_id TEXT NOT NULL, publisher_identity TEXT NOT NULL,
 expected_generation TEXT NOT NULL, size BIGINT NOT NULL CHECK(size BETWEEN 40 AND 16777216), digest TEXT NOT NULL,
 signature TEXT NOT NULL, input_digest TEXT NOT NULL, upload_payload_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('reserved','writing','committed','failed','cancelled')),
 created_at BIGINT NOT NULL, published_at BIGINT, write_until BIGINT, ended_at BIGINT, deleted_at BIGINT, end_reason TEXT
);
CREATE INDEX environment_versions_org ON environment_versions(org_id,environment_id);
CREATE TABLE environment_key_wraps (
 version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
 recipient_user_id TEXT NOT NULL, recipient_device_id TEXT NOT NULL,
 wrapper_user_id TEXT NOT NULL, wrapper_device_id TEXT NOT NULL,
 recipient_identity TEXT NOT NULL, wrapper_identity TEXT NOT NULL, wrap TEXT NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY(version_id,recipient_device_id)
);
CREATE TABLE environment_file_challenges (
 id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
 body TEXT NOT NULL, secret_hash TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE environment_download_leases (
 id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL, day BIGINT NOT NULL, bytes BIGINT NOT NULL,
 expires_at BIGINT NOT NULL, finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN(0,1))
);
ALTER TABLE upload_cancellations DROP CONSTRAINT upload_cancellations_kind_check;
ALTER TABLE upload_cancellations DROP CONSTRAINT upload_cancellations_check;
ALTER TABLE upload_cancellations ADD CHECK(kind IN('share','team','publication'));
ALTER TABLE upload_cancellations ADD CHECK((kind='share' AND request_id='') OR (kind IN('team','publication') AND request_id<>''));
CREATE OR REPLACE VIEW stored_objects AS
 SELECT id,org_id,size,status,deleted_at FROM uploads
 UNION ALL SELECT id,org_id,size,status,deleted_at FROM external_shares
 UNION ALL SELECT id,org_id,size,status,deleted_at FROM environment_versions;
CREATE OR REPLACE VIEW creation_attempts AS
 SELECT receiver_id AS user_id,created_at FROM file_requests
 UNION ALL SELECT sender_id,created_at FROM uploads
 UNION ALL SELECT creator_id,created_at FROM external_shares
 UNION ALL SELECT user_id,created_at FROM upload_cancellations
 UNION ALL SELECT publisher_user_id,created_at FROM environment_versions;
CREATE OR REPLACE VIEW all_download_leases AS
 SELECT id,upload_id AS object_id,org_id,day,bytes,expires_at,finished FROM download_leases
 UNION ALL SELECT id,share_id,org_id,day,bytes,expires_at,finished FROM share_download_leases
 UNION ALL SELECT id,version_id,org_id,day,bytes,expires_at,finished FROM environment_download_leases;
