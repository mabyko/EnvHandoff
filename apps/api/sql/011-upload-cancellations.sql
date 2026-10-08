-- Keep cancellation intent after upload/share receipts are pruned. An absent
-- reservation is not proof that an earlier request cannot still arrive.
CREATE TABLE upload_cancellations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('share','team')),
 reservation_id TEXT NOT NULL,
 request_id TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,org_id,kind,reservation_id),
 CHECK((kind='share' AND request_id='') OR (kind='team' AND request_id<>''))
);
CREATE INDEX upload_cancellations_actor_time ON upload_cancellations(user_id,created_at);
CREATE INDEX upload_cancellations_org ON upload_cancellations(org_id);
CREATE OR REPLACE VIEW creation_attempts AS
 SELECT receiver_id AS user_id,created_at FROM file_requests
 UNION ALL SELECT sender_id,created_at FROM uploads
 UNION ALL SELECT creator_id,created_at FROM external_shares
 UNION ALL SELECT user_id,created_at FROM upload_cancellations;
