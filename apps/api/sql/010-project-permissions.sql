CREATE TABLE project_permissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receive INTEGER NOT NULL CHECK(receive IN (0,1)),
  send INTEGER NOT NULL CHECK(send IN (0,1)),
  external_share INTEGER NOT NULL CHECK(external_share IN (0,1)),
  PRIMARY KEY(project_id,user_id)
);

-- Only permissions shared by EVERY existing environment become defaults.
-- Missing environment grants count as deny, including for a later-demoted Owner.
INSERT INTO project_permissions
SELECT p.id, m.user_id, min(coalesce(ep.receive,0)), min(coalesce(ep.send,0)), min(coalesce(ep.external_share,0))
FROM projects p
JOIN memberships m ON m.org_id=p.org_id
JOIN users u ON u.id=m.user_id
JOIN environments e ON e.project_id=p.id
LEFT JOIN environment_permissions ep ON ep.environment_id=e.id AND ep.user_id=m.user_id
GROUP BY p.id,m.user_id;

-- Keep every differing override. Equal rows now inherit without changing access.
DELETE FROM environment_permissions ep USING environments e, project_permissions pp
WHERE ep.environment_id=e.id AND pp.project_id=e.project_id AND pp.user_id=ep.user_id
  AND ep.receive=pp.receive AND ep.send=pp.send AND ep.external_share=pp.external_share;

CREATE OR REPLACE VIEW effective_file_permissions AS
SELECT p.org_id, p.id AS project_id, e.id AS environment_id, m.user_id,
       CASE WHEN m.role='owner' THEN 1 ELSE coalesce(ep.receive,pp.receive,0) END AS receive,
       CASE WHEN m.role='owner' THEN 1 ELSE coalesce(ep.send,pp.send,0) END AS send,
       CASE WHEN m.role='owner' THEN 1 ELSE coalesce(ep.external_share,pp.external_share,0) END AS external_share
FROM projects p
JOIN organizations o ON o.id=p.org_id AND o.active=1
JOIN environments e ON e.project_id=p.id
JOIN memberships m ON m.org_id=p.org_id
JOIN users u ON u.id=m.user_id AND u.disabled=0
LEFT JOIN project_permissions pp ON pp.project_id=p.id AND pp.user_id=m.user_id
LEFT JOIN environment_permissions ep ON ep.environment_id=e.id AND ep.user_id=m.user_id
WHERE m.role='owner' OR EXISTS (
  SELECT 1 FROM project_teams pt JOIN teams t ON t.id=pt.team_id AND t.org_id=p.org_id
  JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=m.user_id
  WHERE pt.project_id=p.id
);
