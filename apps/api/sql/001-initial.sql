CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
        created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
        previous_session TEXT, expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_events (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, event TEXT NOT NULL, created_at BIGINT NOT NULL
      );

CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
      CREATE TABLE IF NOT EXISTS memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(org_id,user_id));
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), UNIQUE(org_id,name));
      CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(team_id,user_id));
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('owner','member')),
        org_id TEXT, team_id TEXT, target_id TEXT NOT NULL, target_login TEXT NOT NULL, issuer_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')),
        created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, accepted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS invitations_org ON invitations(org_id);
      CREATE TABLE IF NOT EXISTS organization_events (id BIGSERIAL PRIMARY KEY, org_id TEXT, actor_id TEXT, target_id TEXT NOT NULL, event TEXT NOT NULL, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(org_id,name));
      CREATE TABLE IF NOT EXISTS project_teams (project_id TEXT NOT NULL, team_id TEXT NOT NULL, PRIMARY KEY(project_id,team_id));
      CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(project_id,name));
      CREATE TABLE IF NOT EXISTS environment_permissions (
        environment_id TEXT NOT NULL, user_id TEXT NOT NULL,
        receive INTEGER NOT NULL CHECK(receive IN (0,1)), send INTEGER NOT NULL CHECK(send IN (0,1)),
        external_share INTEGER NOT NULL CHECK(external_share IN (0,1)), PRIMARY KEY(environment_id,user_id)
      );

CREATE UNIQUE INDEX default_team ON teams(org_id) WHERE is_default=1;

CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, identity TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','active','revoked'))
      );
      CREATE TABLE IF NOT EXISTS device_challenges (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL,
        secret_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed BIGINT
      );
      CREATE TABLE IF NOT EXISTS device_events (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        event TEXT NOT NULL, created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_proofs (
        challenge_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        proof TEXT NOT NULL, created_at BIGINT NOT NULL
      );
