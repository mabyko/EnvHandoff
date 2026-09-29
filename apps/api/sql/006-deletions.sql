-- The external ledger is authoritative. This binding detects a missing/replaced ledger.
CREATE TABLE deletion_ledger_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ledger_id TEXT NOT NULL);
CREATE TABLE deletion_records (
 kind TEXT NOT NULL CHECK(kind IN('user','organization')), target_id TEXT NOT NULL,
 deleted_at BIGINT NOT NULL, PRIMARY KEY(kind,target_id)
);
