-- One effective-permission relation for catalog, requests and revocation.
CREATE VIEW effective_file_permissions AS
SELECT p.org_id, p.id AS project_id, e.id AS environment_id, ep.user_id,
       ep.receive, ep.send, ep.external_share
FROM environment_permissions ep
JOIN environments e ON e.id=ep.environment_id
JOIN projects p ON p.id=e.project_id
JOIN organizations o ON o.id=p.org_id AND o.active=1
JOIN memberships m ON m.org_id=p.org_id AND m.user_id=ep.user_id
JOIN users u ON u.id=ep.user_id AND u.disabled=0
WHERE EXISTS (
  SELECT 1 FROM project_teams pt JOIN teams t ON t.id=pt.team_id AND t.org_id=p.org_id
  JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=ep.user_id
  WHERE pt.project_id=p.id
);

-- Retain only internal identifiers after access is lost; no copied names or keys.
CREATE TABLE file_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled','expired','fulfilled')),
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, ended_at BIGINT,
  CHECK(receiver_id != sender_id)
);
CREATE INDEX requests_org ON file_requests(org_id,created_at);
CREATE INDEX requests_receiver ON file_requests(receiver_id);
CREATE INDEX requests_sender ON file_requests(sender_id);
CREATE TABLE request_operations (
  user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES file_requests(id) ON DELETE CASCADE,
  input TEXT NOT NULL, result TEXT NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
