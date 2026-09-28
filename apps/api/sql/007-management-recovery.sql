CREATE TABLE management_recovery_contacts (
 org_id TEXT PRIMARY KEY, contact_ref TEXT NOT NULL, case_ref TEXT NOT NULL, verified_at BIGINT NOT NULL
);
CREATE TABLE management_recoveries (
 case_ref TEXT PRIMARY KEY, org_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
 contact_ref TEXT NOT NULL, input_hash TEXT NOT NULL, owner_ids TEXT[] NOT NULL, created_at BIGINT NOT NULL
);
