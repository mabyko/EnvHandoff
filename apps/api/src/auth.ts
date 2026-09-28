import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from './database.ts';
import { fields, HttpError, jsonBody } from './http.ts';
import { githubAccount, Organizations } from './organizations.ts';
import { Transfers } from './transfers.ts';
import { Shares } from './shares.ts';
import { Requests } from './requests.ts';
import { SecurityApi } from './security.ts';
import { Deletions } from './deletions.ts';
import { disableUser } from './disable-account.ts';
const MINUTE = 60000;
const IDLE = 12 * 60 * MINUTE;
const LIFETIME = 7 * 24 * 60 * MINUTE;
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const validToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const equal = (a: string, b: string) => validToken(a) && validToken(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export type AuthConfig = {
  webOrigin: string;
  apiOrigin: string;
  clientId: string;
  clientSecret: string;
  development: boolean;
  totpEncryptionKey?: string;
  fileStoragePath?: string;
  deletionLedgerPath?: string;
  acceptNewTransfers?: boolean;
};
type Session = {
  token_hash: string;
  user_id: string;
  login: string;
  csrf: string;
  created_at: number;
  last_seen: number;
};
type Flow = {
  verifier: string;
  previous_session: string | null;
};
// Reject duplicate cookies rather than choosing between an attacker-controlled and host cookie.
function cookie(request: Request, name: string): string {
  const values = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(name + '='));
  const value = values.length === 1 ? values[0]!.slice(name.length + 1) : '';
  return validToken(value) ? value : '';
}
export class AuthApi {
  private readonly db: Database;
  private readonly config: AuthConfig;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly flowCookie: string;
  private readonly organizations: Organizations;
  private readonly security: SecurityApi;
  private readonly requests: Requests;
  private readonly transfers: Transfers;
  private readonly shares: Shares;
  private readonly deletions?: Deletions;
  constructor(db: Database, config: AuthConfig, fetcher = fetch, clock = Date.now) {
    for (const origin of [config.webOrigin, config.apiOrigin]) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password ||
        !(url.protocol === 'https:' || (config.development && url.protocol === 'http:' && url.hostname === 'localhost')))
        throw new Error('Invalid auth origin');
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(config.clientId) || !/^[A-Za-z0-9_]{1,256}$/.test(config.clientSecret))
      throw new Error('Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in apps/api/.env');
    if (new URL(config.webOrigin).protocol !== new URL(config.apiOrigin).protocol)
      throw new Error('Web and API must use the same scheme');
    this.db = db;
    this.config = { ...config };
    this.fetcher = fetcher;
    this.clock = clock;
    this.secure = config.apiOrigin.startsWith('https:');
    this.sessionCookie = this.secure ? '__Host-envhandoff-session' : 'envhandoff-dev-session';
    this.flowCookie = this.secure ? '__Host-envhandoff-oauth' : 'envhandoff-dev-oauth';
    if (config.deletionLedgerPath) this.deletions = new Deletions(config.deletionLedgerPath);
    this.organizations = new Organizations(db, clock, this.deletions);
    this.transfers = new Transfers(db, config.fileStoragePath, clock, config.acceptNewTransfers);
    this.shares = new Shares(db, config.fileStoragePath, clock, config.acceptNewTransfers, () => this.deletions?.sync(this.db, this.clock()));
    this.requests = new Requests(db, this.organizations, clock, config.acceptNewTransfers);
    this.security = new SecurityApi(db, config.webOrigin, config.totpEncryptionKey, clock);
  }
  private setCookie(headers: Headers, name: string, value: string, seconds: number): void {
    headers.append('set-cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`);
  }
  private async event(userId: string, event: string): Promise<void> {
    await this.db.run("INSERT INTO auth_events (user_id, event, created_at) VALUES ($1, $2, $3)", userId, event, this.clock());
  }
  private async session(request: Request): Promise<Session | undefined> {
    await this.deletions?.sync(this.db, this.clock());
    const token = cookie(request, this.sessionCookie);
    if (!token)
      return undefined;
    const row = (await this.db.get("SELECT s.*, u.login, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = $1", hash(token))) as (Session & {
      disabled: number;
    }) | undefined;
    if (!row)
      return undefined;
    const now = this.clock();
    if (row.disabled || now < row.created_at || now < row.last_seen || now - row.last_seen >= IDLE || now - row.created_at >= LIFETIME) {
      return undefined;
    }
    return row;
  }
  // Called by the operator/account lifecycle, never exposed as a public self-service route.
  async disableUser(userId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.deletions?.sync(this.db, this.clock());
      await disableUser(this.db, userId, this.clock());
    });
  }
  async prune(): Promise<void> {
    await this.deletions?.sync(this.db, this.clock());
    await this.db.transaction(async () => {
      await this.db.run("DELETE FROM oauth_flows WHERE expires_at <= $1", this.clock());
      await this.db.run("INSERT INTO auth_events (user_id, event, created_at) SELECT user_id, 'session_expired', $1 FROM sessions WHERE last_seen <= $2 OR created_at <= $3", this.clock(), this.clock() - IDLE, this.clock() - LIFETIME);
      await this.db.run("DELETE FROM sessions WHERE last_seen <= $1 OR created_at <= $2", this.clock() - IDLE, this.clock() - LIFETIME);
      await this.db.run("DELETE FROM auth_events WHERE created_at <= $1", this.clock() - 30 * 24 * 60 * MINUTE);
      await this.db.run("DELETE FROM organization_events WHERE created_at <= $1", this.clock() - 30 * 24 * 60 * MINUTE);
      await this.db.run("DELETE FROM management_recoveries WHERE created_at <= $1", this.clock() - 30 * 24 * 60 * MINUTE);
      await this.db.run("DELETE FROM invitations WHERE expires_at <= $1", this.clock() - 30 * 24 * 60 * MINUTE);
    });
    await this.security.prune();
    await this.transfers.prune();
    await this.shares.prune();
    await this.requests.prune();
  }
  private async start(request: Request, headers: Headers): Promise<Response> {
    return this.db.transaction(async () => {
      const session = (await this.session(request));
      if (session && !equal(request.headers.get('x-csrf-token') ?? '', session.csrf))
        throw new HttpError(403);
      const state = random(), browser = random(), verifier = random();
      await this.db.transaction(async () => {
        await this.db.run("DELETE FROM oauth_flows WHERE expires_at <= $1 OR browser_hash = $2", this.clock(), hash(cookie(request, this.flowCookie)));
        if (((await this.db.get("SELECT count(*) AS n FROM oauth_flows"))!.n as number) >= 1000)
          throw new HttpError(429);
        await this.db.run("INSERT INTO oauth_flows VALUES ($1, $2, $3, $4, $5)", hash(state), hash(browser), verifier, session?.token_hash ?? null, this.clock() + 10 * MINUTE);
      });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.apiOrigin + '/auth/github/callback', scope: '', state,
        code_challenge: hash(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
      this.setCookie(headers, this.flowCookie, browser, 600);
      return Response.json({ url: url.href }, { headers });
    });
  }
  private async githubIdentity(code: string, verifier: string): Promise<{
    id: string;
    login: string;
  }> {
    const response = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret,
        code, code_verifier: verifier, redirect_uri: this.config.apiOrigin + '/auth/github/callback' }),
    });
    if (!response.ok)
      throw new HttpError(502);
    const token = await response.json() as {
      access_token?: unknown;
      token_type?: unknown;
      scope?: unknown;
    };
    if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9_]{1,512}$/.test(token.access_token))
      throw new HttpError(502);
    const githubHeaders = { accept: 'application/vnd.github+json', 'user-agent': 'EnvHandoff', 'x-github-api-version': '2026-03-10' };
    let identity: {
      id: string;
      login: string;
    } | undefined;
    try {
      if (token.token_type !== 'bearer' || token.scope !== '')
        throw new HttpError(502);
      const profile = await this.fetcher('https://api.github.com/user', { headers: { ...githubHeaders, authorization: 'Bearer ' + token.access_token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!profile.ok)
        throw new HttpError(502);
      const user = await profile.json() as {
        id?: unknown;
        login?: unknown;
      };
      if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login))
        throw new HttpError(502);
      identity = { id: String(user.id), login: user.login };
    }
    catch { /* Still revoke the provider grant when profile validation fails. */ }
    // Dedicated identity-only OAuth app: revoke the grant, including all provider tokens.
    // Never persist access/refresh tokens or return them to the browser.
    const revoked = await this.fetcher(`https://api.github.com/applications/${this.config.clientId}/grant`, {
      method: 'DELETE', headers: { ...githubHeaders, authorization: 'Basic ' + Buffer.from(this.config.clientId + ':' + this.config.clientSecret).toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token.access_token }), redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (revoked.status !== 204 || !identity)
      throw new HttpError(502);
    return identity;
  }
  private async callback(request: Request, headers: Headers): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const state = params.get('state') ?? '', browser = cookie(request, this.flowCookie);
    if (!validToken(state) || !browser || params.getAll('state').length !== 1)
      throw new HttpError(400);
    const flow = (await this.db.get("DELETE FROM oauth_flows WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > $3 RETURNING verifier, previous_session", hash(state), hash(browser), this.clock())) as Flow | undefined;
    if (!flow)
      throw new HttpError(400);
    this.setCookie(headers, this.flowCookie, '', 0);
    try {
      const code = params.get('code') ?? '';
      if (params.has('error') || params.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{1,512}$/.test(code))
        throw new HttpError(400);
      const prior = (await this.session(request));
      if ((prior?.token_hash ?? null) !== flow.previous_session)
        throw new HttpError(401);
      const identity = await this.githubIdentity(code, flow.verifier);
      const token = random(), now = this.clock();
      await this.db.transaction(async () => {
        // Logout, expiry or disabling while GitHub responds must prevent a new session.
        const current = (await this.session(request));
        if ((current?.token_hash ?? null) !== flow.previous_session)
          throw new HttpError(401);
        const existing = (await this.db.get("SELECT id, disabled FROM users WHERE github_id = $1", identity.id));
        if (existing?.disabled)
          throw new HttpError(403);
        const userId = existing?.id as string | undefined ?? randomUUID();
        await this.db.run("INSERT INTO users (id, github_id, login) VALUES ($1, $2, $3) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login", userId, identity.id, identity.login);
        if (current) {
          await this.db.run("DELETE FROM sessions WHERE token_hash = $1", current.token_hash);
          await this.event(current.user_id, 'session_rotated');
        }
        await this.db.run("INSERT INTO sessions VALUES ($1, $2, $3, $4, $5)", hash(token), userId, random(), now, now);
        await this.event(userId, 'login');
      });
      this.setCookie(headers, this.sessionCookie, token, LIFETIME / 1000);
      headers.set('location', this.config.webOrigin + '/pro');
    }
    catch {
      headers.set('location', this.config.webOrigin + '/pro?auth=failed');
    }
    return new Response(null, { status: 303, headers });
  }
  private async requireSession(request: Request): Promise<Session> {
    const session = (await this.session(request));
    if (!session)
      throw new HttpError(401, 'session_expired');
    if (request.method !== 'GET' && !equal(request.headers.get('x-csrf-token') ?? '', session.csrf))
      throw new HttpError(403, 'csrf_failed');
    return session;
  }
  private async organizationRequest(request: Request): Promise<unknown> {
    const auth = (await this.requireSession(request)), path = new URL(request.url).pathname;
    if (request.method === 'GET')
      return this.db.transaction(async () => {
        if ((await this.requireSession(request)).token_hash !== auth.token_hash)
          throw new HttpError(401, 'session_expired');
        await this.db.run("UPDATE sessions SET last_seen=$1 WHERE token_hash=$2", this.clock(), auth.token_hash);
        if (path === '/organizations')
          return (await this.organizations.list(auth.user_id));
        const catalog = /^\/organizations\/([^/]+)\/catalog$/.exec(path);
        if (catalog)
          return (await this.organizations.catalog(auth.user_id, catalog[1]!));
        const detail = /^\/organizations\/([^/]+)$/.exec(path);
        if (detail)
          return (await this.organizations.detail(auth.user_id, detail[1]!));
        throw new HttpError(404);
      });
    if (request.method !== 'POST')
      throw new HttpError(405);
    const body = await jsonBody(request);
    const issue = /^\/organizations\/([^/]+)\/invitations$/.exec(path);
    let target: Awaited<ReturnType<typeof githubAccount>> | undefined;
    if (issue) {
      fields(body, ['login', 'teamId']);
      await this.db.transaction(async () => {
        if ((await this.requireSession(request)).token_hash !== auth.token_hash)
          throw new HttpError(401, 'session_expired');
        await this.organizations.membership(auth.user_id, issue[1]!, true);
      });
      target = await githubAccount(body.login, this.fetcher);
    }
    return this.db.transaction(async () => {
      if ((await this.requireSession(request)).token_hash !== auth.token_hash)
        throw new HttpError(401, 'session_expired');
      const role = /^\/organizations\/([^/]+)\/members\/([^/]+)\/role$/.exec(path);
      if (role) {
        fields(body, ['role']);
        await this.organizations.membership(auth.user_id, role[1]!, true);
        await this.security.requireRecent(auth);
        await this.organizations.setRole(auth.user_id, role[1]!, role[2]!, body.role);
        return { ok: true };
      }
      const lifecycle = /^\/organizations\/([^/]+)\/(owner-transfer|remove)$/.exec(path);
      if (lifecycle) {
        fields(body, lifecycle[2] === 'owner-transfer' ? ['userId'] : []);
        await this.organizations.membership(auth.user_id, lifecycle[1]!, true);
        await this.security.requireRecent(auth);
        if (lifecycle[2] === 'owner-transfer') await this.organizations.transferOwner(auth.user_id, lifecycle[1]!, body.userId);
        else await this.organizations.removeOrganization(auth.user_id, lifecycle[1]!);
        return { ok: true };
      }
      const resource = /^\/organizations\/([^/]+)\/(teams|projects|environments)(?:\/([^/]+))?(?:\/(members|teams|environments|permissions|rename|remove))?$/.exec(path);
      if (resource) {
        const orgId = resource[1]!, kind = resource[2] as 'teams' | 'projects' | 'environments', id = resource[3], action = resource[4];
        if (!id && kind === 'teams') {
          fields(body, ['name']);
          return (await this.organizations.createTeam(auth.user_id, orgId, body.name));
        }
        if (!id && kind === 'projects') {
          fields(body, ['name', 'teamIds']);
          return (await this.organizations.createProject(auth.user_id, orgId, body.name, body.teamIds));
        }
        if (id && action === 'rename') {
          fields(body, ['name']);
          await this.organizations.rename(auth.user_id, orgId, kind, id, body.name);
          return { ok: true };
        }
        if (id && action === 'remove') {
          fields(body, []);
          await this.organizations.remove(auth.user_id, orgId, kind, id);
          return { ok: true };
        }
        if (id && kind === 'teams' && action === 'members') {
          fields(body, ['userId', 'included']);
          await this.organizations.setTeamMember(auth.user_id, orgId, id, body.userId, body.included);
          return { ok: true };
        }
        if (id && kind === 'projects' && action === 'teams') {
          fields(body, ['teamIds']);
          await this.organizations.setProjectTeams(auth.user_id, orgId, id, body.teamIds);
          return { ok: true };
        }
        if (id && kind === 'projects' && action === 'environments') {
          fields(body, ['name']);
          return (await this.organizations.createEnvironment(auth.user_id, orgId, id, body.name));
        }
        if (id && kind === 'environments' && action === 'permissions') {
          fields(body, ['userId', 'receive', 'send', 'externalShare']);
          await this.organizations.setPermissions(auth.user_id, orgId, id, body.userId, body.receive, body.send, body.externalShare);
          return { ok: true };
        }
        throw new HttpError(404);
      }
      if (path === '/organizations/invitations/preview') {
        fields(body, ['token']);
        return (await this.organizations.preview(auth.user_id, body.token));
      }
      if (path === '/organizations/invitations/accept') {
        fields(body, ['token', 'name']);
        return (await this.organizations.accept(auth.user_id, body.token, body.name));
      }
      if (issue && target) {
        const invite = (await this.organizations.issueMember(auth.user_id, issue[1]!, body.teamId, target));
        return { ...invite, url: this.config.webOrigin + '/pro#invite=' + invite.token };
      }
      const cancel = /^\/organizations\/([^/]+)\/invitations\/([^/]+)\/cancel$/.exec(path);
      if (cancel) {
        fields(body, []);
        await this.organizations.cancel(auth.user_id, cancel[1]!, cancel[2]!);
        return { ok: true };
      }
      const remove = /^\/organizations\/([^/]+)\/members\/([^/]+)\/remove$/.exec(path);
      if (remove) {
        fields(body, []);
        await this.organizations.removeMember(auth.user_id, remove[1]!, remove[2]!, () => this.security.requireRecent(auth));
        return { ok: true };
      }
      throw new HttpError(404);
    });
  }
  async handle(request: Request): Promise<Response> {
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', vary: 'Origin' });
    const origin = request.headers.get('origin');
    try {
      const url = new URL(request.url);
      if (url.origin !== this.config.apiOrigin)
        throw new HttpError(400);
      if (origin && origin !== this.config.webOrigin)
        throw new HttpError(403);
      if (origin === this.config.webOrigin) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-credentials', 'true');
        headers.set('access-control-expose-headers', 'Retry-After');
      }
      if (request.method === 'OPTIONS') {
        if (origin !== this.config.webOrigin || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '') ||
          (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').some((name) => name.trim() && !['content-type', 'x-csrf-token', 'x-device-challenge', 'x-device-proof', 'x-share-token'].includes(name.trim())))
          throw new HttpError(403);
        headers.set('access-control-allow-methods', 'GET, POST');
        headers.set('access-control-allow-headers', 'Content-Type, X-CSRF-Token, X-Device-Challenge, X-Device-Proof, X-Share-Token');
        return new Response(null, { status: 204, headers });
      }
      if (request.method === 'POST' && origin !== this.config.webOrigin)
        throw new HttpError(403);
      await this.deletions?.sync(this.db, this.clock());
      if (url.pathname.startsWith('/shares/')) {
        const response = await this.shares.public(request);
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
      }
      if (/^\/organizations\/[^/]+\/shares(?:\/|$)/.test(url.pathname)) {
        const response = await this.shares.handle(request, () => this.requireSession(request));
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
      }
      if (/^\/organizations\/[^/]+\/requests\/[^/]+\/(?:transfer|uploads)(?:\/|$)/.test(url.pathname)) {
        const response = await this.transfers.handle(request, () => this.requireSession(request));
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
      }
      if (/^\/organizations\/[^/]+\/requests(?:\/|$)/.test(url.pathname))
        return Response.json(await this.requests.handle(request, () => this.requireSession(request)), { headers });
      if (url.pathname === '/organizations' || url.pathname.startsWith('/organizations/'))
        return Response.json(await this.organizationRequest(request), { headers });
      if (url.pathname === '/security' || url.pathname.startsWith('/security/'))
        return Response.json(await this.security.handle(request, () => this.requireSession(request)), { headers });
      if (url.pathname === '/auth/github/start' && request.method === 'POST')
        return (await this.start(request, headers));
      if (url.pathname === '/auth/github/callback' && request.method === 'GET')
        return await this.callback(request, headers);
      if (url.pathname === '/auth/session' && request.method === 'GET')
        return await this.db.transaction(async () => {
          const session = (await this.session(request));
          if (!session)
            throw new HttpError(401);
          await this.db.run("UPDATE sessions SET last_seen = $1 WHERE token_hash = $2", this.clock(), session.token_hash);
          return Response.json({ acceptNewTransfers: this.config.acceptNewTransfers !== false, user: { id: session.user_id, login: session.login }, csrf: session.csrf, expiresAt: Math.min(this.clock() + IDLE, session.created_at + LIFETIME) }, { headers });
        });
      if (url.pathname === '/auth/account/remove' && request.method === 'POST') {
        const body = await jsonBody(request); fields(body, []);
        return await this.db.transaction(async () => {
          const session = await this.requireSession(request);
          await this.security.requireRecent(session);
          if (await this.db.get(`SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.org_id AND o.active=1
            WHERE m.user_id=$1 AND m.role='owner' AND NOT EXISTS(
              SELECT 1 FROM memberships other JOIN users u ON u.id=other.user_id AND u.disabled=0
              WHERE other.org_id=m.org_id AND other.role='owner' AND other.user_id!=$1)`, session.user_id))
            throw new HttpError(409, 'last_owner');
          if (!this.deletions) throw new HttpError(503, 'deletion_ledger_unavailable');
          await this.deletions.record('user', session.user_id, this.clock());
          await this.deletions.sync(this.db, this.clock());
          this.setCookie(headers, this.sessionCookie, '', 0);
          this.setCookie(headers, this.flowCookie, '', 0);
          return new Response(null, { status: 204, headers });
        });
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST')
        return await this.db.transaction(async () => {
          const session = (await this.session(request));
          if (!session)
            throw new HttpError(401);
          if (!equal(request.headers.get('x-csrf-token') ?? '', session.csrf))
            throw new HttpError(403);
          await this.db.transaction(async () => {
            await this.db.run("DELETE FROM sessions WHERE token_hash = $1", session.token_hash);
            await this.db.run("DELETE FROM oauth_flows WHERE previous_session = $1", session.token_hash);
            await this.event(session.user_id, 'logout');
          });
          this.setCookie(headers, this.sessionCookie, '', 0);
          this.setCookie(headers, this.flowCookie, '', 0);
          return new Response(null, { status: 204, headers });
        });
      throw new HttpError(404);
    }
    catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.message : 'request_failed' }, { status: error instanceof HttpError ? error.status : 503, headers });
    }
  }
}
