import { Beta } from './beta.ts';
import { METADATA_LIMITS } from '@envhandoff/protocol';
import { limits } from './limits.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { invalidateRequests } from './lifecycle.ts';
import { HttpError } from './http.ts';
import type { Deletions } from './deletions.ts';
const WEEK = 7 * 24 * 60 * 60000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type GitHubAccount = {
  id: string;
  login: string;
};
type Invite = {
  id: string;
  kind: 'owner' | 'member';
  org_id: string | null;
  team_id: string | null;
  target_id: string;
  target_login: string;
  issuer_id: string | null;
  status: string;
  expires_at: number;
  accepted_by: string | null;
};
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    throw new HttpError(400, 'invalid_input');
  return value;
}
function name(value: unknown, maxLength: number = METADATA_LIMITS.project): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new HttpError(400, 'invalid_name');
  return value.trim();
}
export async function githubAccount(login: unknown, fetcher = fetch): Promise<GitHubAccount> {
  if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login))
    throw new HttpError(400, 'invalid_github_login');
  const response = await fetcher('https://api.github.com/users/' + encodeURIComponent(login), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'EnvHandoff', 'x-github-api-version': '2026-03-10' },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404)
    throw new HttpError(404, 'github_account_not_found');
  if (!response.ok)
    throw new HttpError(502, 'github_unavailable');
  const account = await response.json() as {
    id: unknown;
    login: unknown;
    type: unknown;
  };
  if (account.type !== 'User' || typeof account.id !== 'number' || !Number.isSafeInteger(account.id) || account.id < 1 || typeof account.login !== 'string' || account.login.toLowerCase() !== login.toLowerCase())
    throw new HttpError(400, 'invalid_github_account');
  return { id: String(account.id), login: account.login };
}
export class Organizations {
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly deletions?: Deletions;
  private readonly beta: Beta;
  constructor(db: Database, clock = Date.now, deletions?: Deletions, operatorId = '') {
    this.db = db;
    this.beta = new Beta(db, clock, operatorId);
    this.clock = clock;
    this.deletions = deletions;
  }
  private async user(userId: string): Promise<{
    github_id: string;
  }> {
    const row = (await this.db.get("SELECT github_id FROM users WHERE id = $1 AND disabled = 0", identifier(userId)));
    if (!row)
      throw new HttpError(401, 'session_expired');
    return row as {
      github_id: string;
    };
  }
  private async event(org: string | null, actor: string | null, target: string, event: string): Promise<void> {
    if (org) await invalidateRequests(this.db, this.clock(), { organizationId: org });
    await this.db.run("INSERT INTO organization_events (org_id,actor_id,target_id,event,created_at) VALUES ($1,$2,$3,$4,$5)", org, actor, target, event, this.clock());
  }
  async membership(userId: string, orgId: string, owner = false): Promise<{
    id: string;
    name: string;
    role: 'owner' | 'member';
  }> {
    await this.user(userId);
    const row = (await this.db.get("SELECT o.id,o.name,m.role,o.active FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE o.id=$1 AND m.user_id=$2", identifier(orgId), userId));
    if (!row)
      throw new HttpError(404, 'organization_not_found');
    if (!row.active)
      throw new HttpError(403, 'organization_inactive');
    if (owner && row.role !== 'owner')
      throw new HttpError(403, 'owner_required');
    return { id: row.id as string, name: row.name as string, role: row.role as 'owner' | 'member' };
  }
  async list(userId: string) {
    await this.user(userId);
    return (await this.db.all("SELECT o.id,o.name,o.active,m.role FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1 ORDER BY o.name,o.id", userId));
  }
  async create(userId: string, value: unknown) {
    return this.db.transaction(async () => {
      await this.beta.requireCreation(userId);
      const id = randomUUID(), teamId = randomUUID(), label = name(value);
      await this.db.run('INSERT INTO organizations(id,name) VALUES($1,$2)', id, label);
      await this.db.run("INSERT INTO teams(id,org_id,name,is_default) VALUES($1,$2,'기본 팀',1)", teamId, id);
      await this.db.run("INSERT INTO memberships VALUES($1,$2,'owner')", id, userId);
      await this.db.run('INSERT INTO team_members VALUES($1,$2)', teamId, userId);
      await this.event(id, userId, id, 'organization_created');
      return { id, name: label, role: 'owner' as const };
    });
  }
  async detail(userId: string, orgId: string) {
    const org = (await this.membership(userId, orgId));
    const teams = (await this.db.all("SELECT t.id,t.name FROM teams t WHERE t.org_id=$1 AND ($2=1 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$3)) ORDER BY t.name", orgId, org.role === 'owner' ? 1 : 0, userId));
    const members = (await this.db.all("SELECT u.id,u.login,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY u.login", orgId));
    const invitations = org.role === 'owner' ? (await this.db.all("SELECT id,target_login AS login,status,expires_at AS \"expiresAt\" FROM invitations WHERE org_id=$1 AND status='pending' AND expires_at>$2 ORDER BY created_at DESC", orgId, this.clock())) : [];
    return { ...org, teams, members, invitations };
  }
  // Operator-only entry point: no HTTP route may issue an organization-opening invitation.
  async issueOwner(target: GitHubAccount) {
    return (await this.db.transaction(async () => (await this.issue('owner', target, null, null, null))));
  }
  async cancelOpening(inviteId: string): Promise<void> {
    await this.db.transaction(async () => {
      const invite = (await this.db.get("SELECT status FROM invitations WHERE id=$1 AND kind='owner'", identifier(inviteId)));
      if (!invite)
        throw new HttpError(404, 'invitation_unavailable');
      if (invite.status === 'accepted')
        throw new HttpError(409, 'already_accepted');
      await this.db.run("UPDATE invitations SET status='cancelled' WHERE id=$1", inviteId);
      await this.event(null, null, inviteId, 'invite_cancelled');
    });
  }
  async issueMember(userId: string, orgId: string, teamId: unknown, target: GitHubAccount) {
    return (await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      if (!(await this.db.get("SELECT id FROM teams WHERE id=$1 AND org_id=$2", identifier(teamId), orgId)))
        throw new HttpError(400, 'invalid_team');
      const count = (await this.db.get("SELECT count(*) AS n FROM organization_events WHERE actor_id=$1 AND event='invited' AND created_at>$2", userId, this.clock() - 10 * 60000))!.n as number;
      if (count >= 20)
        throw new HttpError(429, 'invite_limit');
      return (await this.issue('member', target, orgId, teamId as string, userId));
    }));
  }
  private async issue(kind: 'owner' | 'member', target: GitHubAccount, org: string | null, team: string | null, issuer: string | null) {
    if (!/^[1-9][0-9]{0,15}$/.test(target.id) || !/^[A-Za-z0-9-]{1,39}$/.test(target.login))
      throw new HttpError(400, 'invalid_github_account');
    const pending = (await this.db.get("SELECT count(*) AS n FROM invitations WHERE org_id IS NOT DISTINCT FROM $1 AND status='pending' AND expires_at>$2", org, this.clock()))!.n as number;
    if (pending >= 100)
      throw new HttpError(429, 'invite_limit');
    const token = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = this.clock() + WEEK;
    await this.db.run("INSERT INTO invitations (id,token_hash,kind,org_id,team_id,target_id,target_login,issuer_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", id, hash(token), kind, org, team, target.id, target.login, issuer, this.clock(), expiresAt);
    await this.event(org, issuer, id, 'invited');
    return { id, token, expiresAt, login: target.login };
  }
  private async invitation(userId: string, token: unknown): Promise<Invite> {
    const user = (await this.user(userId));
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HttpError(400, 'invalid_invitation');
    const invite = (await this.db.get("SELECT * FROM invitations WHERE token_hash=$1", hash(token))) as Invite | undefined;
    if (!invite)
      throw new HttpError(410, 'invitation_unavailable');
    if (invite.target_id !== user.github_id)
      throw new HttpError(403, 'wrong_github_account');
    if (invite.status === 'cancelled' || (invite.status === 'pending' && invite.expires_at <= this.clock()))
      throw new HttpError(410, 'invitation_unavailable');
    if (invite.org_id) {
      if (!(await this.db.get("SELECT id FROM organizations WHERE id=$1 AND active=1", invite.org_id)))
        throw new HttpError(403, 'organization_inactive');
      if (invite.status === 'accepted' && !(await this.db.get("SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2", invite.org_id, userId)))
        throw new HttpError(410, 'invitation_unavailable');
    }
    return invite;
  }
  private async invalidateIssuedInvites(): Promise<void> {
    await this.db.run("UPDATE invitations SET status='cancelled' WHERE kind='member' AND status='pending' AND NOT EXISTS (\n      SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=invitations.org_id AND m.user_id=invitations.issuer_id AND m.role='owner' AND u.disabled=0\n    )");
  }
  async preview(userId: string, token: unknown) {
    await this.db.transaction(() => this.invalidateIssuedInvites());
    const invite = (await this.invitation(userId, token));
    return { kind: invite.kind, login: invite.target_login, expiresAt: invite.expires_at, accepted: invite.status === 'accepted',
      organization: invite.org_id ? (await this.db.get("SELECT name FROM organizations WHERE id=$1", invite.org_id))!.name : null,
      team: invite.team_id ? (await this.db.get("SELECT name FROM teams WHERE id=$1 AND org_id=$2", invite.team_id, invite.org_id))?.name ?? null : null };
  }
  async accept(userId: string, token: unknown, organizationName?: unknown) {
    await this.db.transaction(() => this.invalidateIssuedInvites());
    return (await this.db.transaction(async () => {
      const invite = (await this.invitation(userId, token));
      if (invite.status === 'accepted')
        return (await this.membership(userId, invite.org_id!));
      let orgId = invite.org_id, teamId = invite.team_id;
      if (invite.kind === 'owner') {
        await this.beta.requireCapacity(userId);
        await this.db.run('INSERT INTO beta_members(user_id,activated_at) VALUES($1,$2) ON CONFLICT DO NOTHING', userId, this.clock());
        orgId = randomUUID();
        teamId = randomUUID();
        await this.db.run("INSERT INTO organizations (id,name) VALUES ($1,$2)", orgId, name(organizationName));
        await this.db.run("INSERT INTO teams (id,org_id,name,is_default) VALUES ($1,$2,$3,1)", teamId, orgId, '기본 팀');
      }
      else {
        await this.membership(invite.issuer_id!, orgId!, true);
        if (!(await this.db.get("SELECT id FROM teams WHERE id=$1 AND org_id=$2", teamId, orgId)))
          throw new HttpError(410, 'invitation_unavailable');
      }
      const existing = (await this.db.get("SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2", orgId, userId));
      if (!existing && ((await this.db.get("SELECT count(*) AS n FROM memberships WHERE org_id=$1", orgId))!.n as number) >= limits.organizationMembers)
        throw new HttpError(409, 'member_limit');
      await this.db.run("INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", orgId, userId, invite.kind === 'owner' ? 'owner' : 'member');
      await this.db.run("INSERT INTO team_members VALUES ($1,$2) ON CONFLICT DO NOTHING", teamId, userId);
      await this.db.run("UPDATE invitations SET status='accepted',org_id=$1,team_id=$2,accepted_by=$3 WHERE id=$4 AND status='pending'", orgId, teamId, userId, invite.id);
      await this.event(orgId, userId, invite.id, 'accepted');
      return (await this.membership(userId, orgId!));
    }));
  }
  async cancel(userId: string, orgId: string, inviteId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      const invite = (await this.db.get("SELECT status FROM invitations WHERE id=$1 AND org_id=$2", identifier(inviteId), orgId));
      if (!invite)
        throw new HttpError(404, 'invitation_unavailable');
      if (invite.status === 'accepted')
        throw new HttpError(409, 'already_accepted');
      await this.db.run("UPDATE invitations SET status='cancelled' WHERE id=$1", inviteId);
      await this.event(orgId, userId, inviteId, 'invite_cancelled');
    });
  }
  async removeMember(userId: string, orgId: string, targetId: string, reauthenticate?: () => Promise<void>): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, userId !== targetId);
      const target = (await this.db.get("SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2", orgId, identifier(targetId)));
      if (!target)
        throw new HttpError(404, 'member_not_found');
      if (target.role === 'owner' && !await this.db.get("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id AND u.disabled=0 WHERE m.org_id=$1 AND m.role='owner' AND m.user_id!=$2", orgId, targetId))
        throw new HttpError(409, 'last_owner');
      if (target.role === 'owner') {
        if (!reauthenticate) throw new HttpError(403, 'reauthentication_required');
        await reauthenticate();
      }
      await this.db.run("DELETE FROM team_members WHERE user_id=$1 AND team_id IN (SELECT id FROM teams WHERE org_id=$2)", targetId, orgId);
      await this.db.run("DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", orgId, targetId);
      await this.db.run("DELETE FROM environment_permissions WHERE user_id=$1 AND environment_id IN (SELECT e.id FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.org_id=$2)", targetId, orgId);
      await this.db.run('DELETE FROM project_permissions WHERE user_id=$1 AND project_id IN (SELECT id FROM projects WHERE org_id=$2)', targetId, orgId);
      await this.db.run("UPDATE invitations SET status='cancelled' WHERE org_id=$1 AND (issuer_id=$2 OR accepted_by=$3 OR target_id=(SELECT github_id FROM users WHERE id=$4))", orgId, targetId, targetId, targetId);
      await this.event(orgId, userId, targetId, 'member_removed');
    });
  }
  async setRole(userId: string, orgId: string, targetId: string, role: unknown): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      if (role !== 'owner' && role !== 'member') throw new HttpError(400, 'invalid_input');
      const target = await this.db.get("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id AND u.disabled=0 WHERE m.org_id=$1 AND m.user_id=$2", orgId, identifier(targetId));
      if (!target) throw new HttpError(404, 'member_not_found');
      if (target.role === role) return;
      if (role === 'owner') await this.beta.requireCapacity(targetId);
      if (role === 'member' && ((await this.db.get("SELECT count(*) AS n FROM memberships m JOIN users u ON u.id=m.user_id AND u.disabled=0 WHERE m.org_id=$1 AND m.role='owner'", orgId))!.n as number) <= 1)
        throw new HttpError(409, 'last_owner');
      await this.db.run('UPDATE memberships SET role=$1 WHERE org_id=$2 AND user_id=$3', role, orgId, targetId);
      await this.invalidateIssuedInvites();
      await this.event(orgId, userId, targetId, role === 'owner' ? 'owner_promoted' : 'owner_demoted');
    });
  }
  async transferOwner(userId: string, orgId: string, targetId: unknown): Promise<void> {
    await this.db.transaction(async () => {
      const target = identifier(targetId);
      if (target === userId) throw new HttpError(400, 'invalid_input');
      await this.setRole(userId, orgId, target, 'owner');
      await this.setRole(userId, orgId, userId, 'member');
    });
  }
  async removeOrganization(userId: string, orgId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      if (!this.deletions) throw new HttpError(503, 'deletion_ledger_unavailable');
      await this.deletions.record('organization', orgId, this.clock());
      await this.deletions.sync(this.db, this.clock());
    });
  }
  private async project(userId: string, orgId: string, projectId: unknown, manage = false) {
    const member = (await this.membership(userId, orgId, manage));
    const project = (await this.db.get("SELECT id,name FROM projects WHERE id=$1 AND org_id=$2", identifier(projectId), orgId));
    if (!project || (member.role !== 'owner' && !(await this.projectMember(userId, project.id as string))))
      throw new HttpError(404, 'project_not_found');
    return project as {
      id: string;
      name: string;
    };
  }
  private async projectMember(userId: string, projectId: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 FROM project_teams pt JOIN teams t ON t.id=pt.team_id JOIN projects p ON p.id=pt.project_id\n      JOIN team_members tm ON tm.team_id=t.id WHERE p.id=$1 AND t.org_id=p.org_id AND tm.user_id=$2 LIMIT 1", projectId, userId));
  }
  private async environment(userId: string, orgId: string, environmentId: unknown, manage = false) {
    const environment = (await this.db.get("SELECT e.id,e.name,e.project_id FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=$1 AND p.org_id=$2", identifier(environmentId), identifier(orgId)));
    if (!environment)
      throw new HttpError(404, 'environment_not_found');
    await this.project(userId, orgId, environment.project_id, manage);
    return environment as {
      id: string;
      name: string;
      project_id: string;
    };
  }
  private async permissions(userId: string, projectId: string, environmentId: string) {
    const row = await this.db.get('SELECT receive,send,external_share FROM effective_file_permissions WHERE environment_id=$1 AND project_id=$2 AND user_id=$3', environmentId, projectId, userId);
    return { receive: !!row?.receive, send: !!row?.send, externalShare: !!row?.external_share };
  }
  async requireFilePermission(userId: string, orgId: string, environmentId: string, operation: 'receive' | 'send' | 'externalShare'): Promise<void> {
    if (!['receive', 'send', 'externalShare'].includes(operation))
      throw new HttpError(400, 'invalid_permission');
    const env = (await this.environment(userId, orgId, environmentId));
    if (!(await this.permissions(userId, env.project_id, env.id))[operation])
      throw new HttpError(403, 'file_permission_required');
  }
  async catalog(userId: string, orgId: string) {
    return this.db.transaction(async () => {
      const owner = (await this.membership(userId, orgId)).role === 'owner';
      type Grant = { userId: string; receive: number; send: number; externalShare: number };
      const teams = await this.db.all<{ id: string; name: string; isDefault: number }>(
        'SELECT id,name,is_default AS "isDefault" FROM teams WHERE org_id=$1 ORDER BY is_default DESC,name', orgId);
      const teamMembers = await this.db.all<{ teamId: string; userId: string }>(
        'SELECT tm.team_id AS "teamId",tm.user_id AS "userId" FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.org_id=$1 AND ($2 OR tm.user_id=$3)', orgId, owner, userId);
      const projects = await this.db.all<{ id: string; name: string }>(
        'SELECT id,name FROM projects WHERE org_id=$1 ORDER BY name', orgId);
      const projectTeams = await this.db.all<{ projectId: string; teamId: string }>(
        'SELECT pt.project_id AS "projectId",pt.team_id AS "teamId" FROM project_teams pt JOIN projects p ON p.id=pt.project_id JOIN teams t ON t.id=pt.team_id AND t.org_id=p.org_id WHERE p.org_id=$1', orgId);
      const environments = await this.db.all<{ id: string; name: string; projectId: string }>(
        'SELECT e.id,e.name,e.project_id AS "projectId" FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.org_id=$1 ORDER BY e.name', orgId);
      const overrides = await this.db.all<Grant & { environmentId: string }>(
        'SELECT ep.environment_id AS "environmentId",ep.user_id AS "userId",ep.receive,ep.send,ep.external_share AS "externalShare" FROM environment_permissions ep JOIN environments e ON e.id=ep.environment_id JOIN projects p ON p.id=e.project_id WHERE p.org_id=$1 AND ($2 OR ep.user_id=$3)', orgId, owner, userId);
      const defaults = owner ? await this.db.all<Grant & { projectId: string }>(
        'SELECT pp.project_id AS "projectId",pp.user_id AS "userId",pp.receive,pp.send,pp.external_share AS "externalShare" FROM project_permissions pp JOIN projects p ON p.id=pp.project_id WHERE p.org_id=$1', orgId) : [];
      const effective = await this.db.all<{ environmentId: string; receive: number; send: number; externalShare: number }>(
        'SELECT environment_id AS "environmentId",receive,send,external_share AS "externalShare" FROM effective_file_permissions WHERE org_id=$1 AND user_id=$2', orgId, userId);
      function group<T>(rows: T[], key: (row: T) => string) {
        const grouped = new Map<string, T[]>();
        for (const row of rows) {
          const id = key(row), values = grouped.get(id);
          if (values) values.push(row); else grouped.set(id, [row]);
        }
        return grouped;
      }
      const membersByTeam = group(teamMembers, row => row.teamId);
      const teamsByProject = group(projectTeams, row => row.projectId);
      const envsByProject = group(environments, row => row.projectId);
      const overridesByEnv = group(overrides, row => row.environmentId);
      const defaultsByProject = group(defaults, row => row.projectId);
      const effectiveByEnv = new Map(effective.map(row => [row.environmentId, row]));
      const memberTeams = new Set(teamMembers.filter(row => row.userId === userId).map(row => row.teamId));
      const grant = ({ userId, receive, send, externalShare }: Grant) => ({ userId, receive, send, externalShare });
      return {
        role: owner ? 'owner' as const : 'member' as const,
        teams: teams.filter(team => owner || memberTeams.has(team.id)).map(team => ({ ...team,
          members: owner ? (membersByTeam.get(team.id) ?? []).map(row => row.userId) : [],
        })),
        projects: projects.filter(project => owner || (teamsByProject.get(project.id) ?? []).some(row => memberTeams.has(row.teamId))).map(project => ({ ...project,
          teamIds: owner ? (teamsByProject.get(project.id) ?? []).map(row => row.teamId) : [],
          grants: owner ? (defaultsByProject.get(project.id) ?? []).map(grant) : [],
          environments: (envsByProject.get(project.id) ?? []).map(({ id, name }) => {
            const rights = effectiveByEnv.get(id), envOverrides = overridesByEnv.get(id) ?? [];
            return { id, name,
              permissions: { receive: !!rights?.receive, send: !!rights?.send, externalShare: !!rights?.externalShare },
              permissionSource: owner ? 'owner' : envOverrides.some(row => row.userId === userId) ? 'environment' : 'project',
              grants: owner ? envOverrides.map(grant) : [],
            };
          }),
        })),
      };
    });
  }
  async createTeam(userId: string, orgId: string, value: unknown) {
    return (await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      const label = name(value), id = randomUUID();
      if ((await this.db.get("SELECT id FROM teams WHERE org_id=$1 AND name=$2", orgId, label)))
        throw new HttpError(409, 'duplicate_name');
      await this.db.run("INSERT INTO teams (id,org_id,name) VALUES ($1,$2,$3)", id, orgId, label);
      await this.event(orgId, userId, id, 'team_created');
      return { id };
    }));
  }
  async setTeamMember(userId: string, orgId: string, teamId: unknown, targetId: unknown, included: unknown): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      if (typeof included !== 'boolean')
        throw new HttpError(400, 'invalid_input');
      if (!(await this.db.get("SELECT id FROM teams WHERE id=$1 AND org_id=$2", identifier(teamId), orgId)))
        throw new HttpError(404, 'team_not_found');
      if (!(await this.db.get("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE org_id=$1 AND user_id=$2 AND u.disabled=0", orgId, identifier(targetId))))
        throw new HttpError(404, 'member_not_found');
      if (included)
        await this.db.run("INSERT INTO team_members VALUES ($1,$2) ON CONFLICT DO NOTHING", teamId as string, targetId as string);
      else
        await this.db.run("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", teamId as string, targetId as string);
      await this.event(orgId, userId, targetId as string, included ? 'team_member_added' : 'team_member_removed');
    });
  }
  private async teamIds(orgId: string, value: unknown): Promise<string[]> {
    if (!Array.isArray(value) || value.length > 100)
      throw new HttpError(400, 'invalid_team');
    const ids = value.map(identifier);
    if (new Set(ids).size !== ids.length)
      throw new HttpError(400, 'invalid_team');
    for (const id of ids)
      if (!await this.db.get('SELECT id FROM teams WHERE org_id=$1 AND id=$2', orgId, id))
        throw new HttpError(400, 'invalid_team');
    return ids;
  }
  async createProject(userId: string, orgId: string, value: unknown, teamIds?: unknown) {
    return (await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      const label = name(value), id = randomUUID();
      const teams = (await this.teamIds(orgId, teamIds ?? [(await this.db.get("SELECT id FROM teams WHERE org_id=$1 AND is_default=1", orgId))?.id]));
      if ((await this.db.get("SELECT id FROM projects WHERE org_id=$1 AND name=$2", orgId, label)))
        throw new HttpError(409, 'duplicate_name');
      await this.db.run("INSERT INTO projects VALUES ($1,$2,$3)", id, orgId, label);
      for (const team of teams)
        await this.db.run("INSERT INTO project_teams VALUES ($1,$2)", id, team);
      await this.event(orgId, userId, id, 'project_created');
      return { id };
    }));
  }
  async setProjectTeams(userId: string, orgId: string, projectId: unknown, value: unknown): Promise<void> {
    await this.db.transaction(async () => {
      const project = (await this.project(userId, orgId, projectId, true)), teams = (await this.teamIds(orgId, value));
      await this.db.run("DELETE FROM project_teams WHERE project_id=$1", project.id);
      for (const team of teams)
        await this.db.run("INSERT INTO project_teams VALUES ($1,$2)", project.id, team);
      await this.event(orgId, userId, project.id, 'project_teams_changed');
    });
  }
  async createEnvironment(userId: string, orgId: string, projectId: unknown, value: unknown) {
    return (await this.db.transaction(async () => {
      const project = (await this.project(userId, orgId, projectId, true)), label = name(value, METADATA_LIMITS.environment), id = randomUUID();
      if ((await this.db.get("SELECT id FROM environments WHERE project_id=$1 AND name=$2", project.id, label)))
        throw new HttpError(409, 'duplicate_name');
      await this.db.run("INSERT INTO environments VALUES ($1,$2,$3)", id, project.id, label);
      await this.event(orgId, userId, id, 'environment_created');
      return { id };
    }));
  }
  async setPermissions(userId: string, orgId: string, environmentId: unknown, targetId: unknown, receive: unknown, send: unknown, externalShare: unknown): Promise<void> {
    await this.db.transaction(async () => {
      const env = (await this.environment(userId, orgId, environmentId, true));
      if (![receive, send, externalShare].every((value) => typeof value === 'boolean'))
        throw new HttpError(400, 'invalid_permission');
      await this.permissionMember(orgId, targetId);
      await this.db.run("INSERT INTO environment_permissions VALUES ($1,$2,$3,$4,$5) ON CONFLICT(environment_id,user_id) DO UPDATE SET receive=excluded.receive,send=excluded.send,external_share=excluded.external_share", env.id, targetId as string, Number(receive), Number(send), Number(externalShare));
      await this.event(orgId, userId, env.id, 'environment_permissions_changed');
    });
  }
  private async permissionMember(orgId: string, targetId: unknown): Promise<void> {
    const member = await this.db.get("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND u.disabled=0", orgId, identifier(targetId));
    if (!member) throw new HttpError(404, 'member_not_found');
    if (member.role === 'owner') throw new HttpError(409, 'owner_permissions_automatic');
  }
  async setProjectPermissions(userId: string, orgId: string, projectId: unknown, targetId: unknown, receive: unknown, send: unknown, externalShare: unknown): Promise<void> {
    await this.db.transaction(async () => {
      const project = await this.project(userId, orgId, projectId, true);
      if (![receive, send, externalShare].every(value => typeof value === 'boolean')) throw new HttpError(400, 'invalid_permission');
      await this.permissionMember(orgId, targetId);
      await this.db.run('INSERT INTO project_permissions VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,user_id) DO UPDATE SET receive=excluded.receive,send=excluded.send,external_share=excluded.external_share', project.id, targetId, Number(receive), Number(send), Number(externalShare));
      await this.event(orgId, userId, project.id, 'project_permissions_changed');
    });
  }
  async inheritPermissions(userId: string, orgId: string, environmentId: unknown, targetId: unknown): Promise<void> {
    await this.db.transaction(async () => {
      const env = await this.environment(userId, orgId, environmentId, true);
      await this.permissionMember(orgId, targetId);
      await this.db.run('DELETE FROM environment_permissions WHERE environment_id=$1 AND user_id=$2', env.id, targetId);
      await this.event(orgId, userId, env.id, 'environment_permissions_inherited');
    });
  }
  async rename(userId: string, orgId: string, kind: 'teams' | 'projects' | 'environments', id: unknown, value: unknown): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      identifier(id);
      const label = name(value, kind === 'environments' ? METADATA_LIMITS.environment : METADATA_LIMITS.project);
      if (!['teams', 'projects', 'environments'].includes(kind))
        throw new HttpError(400, 'invalid_input');
      const parent = kind === 'environments' ? (await this.environment(userId, orgId, id, true)).project_id : orgId;
      const scope = kind === 'environments' ? 'project_id' : 'org_id';
      if (!(await this.db.get(`SELECT id FROM ${kind} WHERE id=$1 AND ${scope}=$2`, id as string, parent)))
        throw new HttpError(404, 'item_not_found');
      if ((await this.db.get(`SELECT id FROM ${kind} WHERE ${scope}=$1 AND name=$2 AND id!=$3`, parent, label, id as string)))
        throw new HttpError(409, 'duplicate_name');
      await this.db.run(`UPDATE ${kind} SET name=$1 WHERE id=$2`, label, id as string);
      await this.event(orgId, userId, id as string, 'name_changed');
    });
  }
  async remove(userId: string, orgId: string, kind: 'teams' | 'projects' | 'environments', id: unknown): Promise<void> {
    await this.db.transaction(async () => {
      await this.membership(userId, orgId, true);
      identifier(id);
      if (kind === 'teams') {
        const team = (await this.db.get("SELECT is_default FROM teams WHERE id=$1 AND org_id=$2", id as string, orgId));
        if (!team)
          throw new HttpError(404, 'team_not_found');
        if (team.is_default)
          throw new HttpError(409, 'default_team_required');
        await this.db.run("UPDATE invitations SET status='cancelled' WHERE team_id=$1", id as string);
        await this.db.run("DELETE FROM project_teams WHERE team_id=$1", id as string);
        await this.db.run("DELETE FROM team_members WHERE team_id=$1", id as string);
        await this.db.run("DELETE FROM teams WHERE id=$1", id as string);
      }
      else if (kind === 'projects') {
        const project = (await this.project(userId, orgId, id, true));
        await this.db.run("DELETE FROM environment_permissions WHERE environment_id IN (SELECT id FROM environments WHERE project_id=$1)", project.id);
        await this.db.run("DELETE FROM environments WHERE project_id=$1", project.id);
        await this.db.run("DELETE FROM project_teams WHERE project_id=$1", project.id);
        await this.db.run("DELETE FROM projects WHERE id=$1", project.id);
      }
      else if (kind === 'environments') {
        const env = (await this.environment(userId, orgId, id, true));
        await this.db.run("DELETE FROM environment_permissions WHERE environment_id=$1", env.id);
        await this.db.run("DELETE FROM environments WHERE id=$1", env.id);
      }
      else
        throw new HttpError(400, 'invalid_input');
      await this.event(orgId, userId, id as string, kind + '_deleted');
    });
  }
}
