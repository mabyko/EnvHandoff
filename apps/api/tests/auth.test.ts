import { testDatabase } from './database.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AuthApi } from '../src/auth.ts';
import type { AuthConfig } from '../src/auth.ts';
const config: AuthConfig = { development: false, webOrigin: 'https://envhandoff.mabyko.com', apiOrigin: 'https://api.envhandoff.mabyko.com', clientId: 'testClient', clientSecret: 'testSecret' };
const time = 1800000000000, hour = 3600000;
const cookie = (response: Response, suffix: string) => response.headers.getSetCookie().find((value) => value.startsWith('__Host-envhandoff-' + suffix + '='))!.split(';')[0]!;
const request = (path: string, method = 'GET', cookies = '', extra: Record<string, string> = {}) => new Request(config.apiOrigin + path, { method, headers: { origin: config.webOrigin, cookie: cookies, ...extra } });
function provider() {
  const state = { id: 123, login: 'octocat', scope: '', revoked: 0, calls: 0, failRevoke: false, failProfile: false, duringProfile: async () => { }, verifier: '' };
  const fetcher: typeof fetch = async (input, init) => {
    state.calls++;
    assert.equal(init?.redirect, 'error');
    if (input === 'https://github.com/login/oauth/access_token') {
      const body = init!.body as URLSearchParams;
      assert.equal(body.get('redirect_uri'), config.apiOrigin + '/auth/github/callback');
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), state.verifier);
      return Response.json({ access_token: 'gho_test', refresh_token: 'ghr_never_store', token_type: 'bearer', scope: state.scope });
    }
    if (input === 'https://api.github.com/user') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer gho_test');
      await state.duringProfile();
      return state.failProfile ? new Response(null, { status: 500 }) : Response.json({ id: state.id, login: state.login });
    }
    assert.equal(input, 'https://api.github.com/applications/testClient/grant');
    assert.equal(init?.method, 'DELETE');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from('testClient:testSecret').toString('base64'));
    state.revoked++;
    return new Response(null, { status: state.failRevoke ? 500 : 204 });
  };
  return { state, fetcher };
}
async function begin(api: AuthApi, upstream: ReturnType<typeof provider>, cookies = '', csrf = '') {
  const response = await api.handle(request('/auth/github/start', 'POST', cookies, csrf ? { 'x-csrf-token': csrf } : {}));
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  upstream.state.verifier = url.searchParams.get('code_challenge')!;
  return { cookies: [cookies, cookie(response, 'oauth')].filter(Boolean).join('; '), path: '/auth/github/callback?code=test_code&state=' + url.searchParams.get('state') };
}
async function login(api: AuthApi, upstream: ReturnType<typeof provider>, cookies = '', csrf = '') {
  const flow = await begin(api, upstream, cookies, csrf);
  const response = await api.handle(request(flow.path, 'GET', flow.cookies));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), config.webOrigin + '/pro');
  const sessionCookie = cookie(response, 'session');
  const session = await api.handle(request('/auth/session', 'GET', sessionCookie));
  return { response, cookies: sessionCookie, session: await session.json() as {
      user: {
        id: string;
        login: string;
      };
      csrf: string;
      expiresAt: number;
    }, flow };
}
test('login survives restart, rotates sessions, binds immutable GitHub ID and revokes provider tokens', async (t) => {
  const testDb = await testDatabase(t);
  let db = testDb.connect();
  const upstream = provider();
  let api = new AuthApi(db, config, upstream.fetcher, () => time);
  try {
    const first = await login(api, upstream);
    assert.match(first.session.user.id, /^[0-9a-f-]{36}$/);
    for (const value of first.response.headers.getSetCookie()) {
      assert.match(value, /Secure/);
      assert.match(value, /HttpOnly/);
      assert.match(value, /SameSite=Lax/);
      assert.doesNotMatch(value, /Domain=/);
    }
    const persisted = JSON.stringify((await db.all("SELECT * FROM sessions")));
    assert.ok(!persisted.includes(first.cookies.split('=')[1]!));
    assert.doesNotMatch(persisted, /gho_test|ghr_never_store/);
    assert.equal(upstream.state.revoked, 1);
    const calls = upstream.state.calls;
    assert.equal((await api.handle(request(first.flow.path, 'GET', first.flow.cookies))).status, 400);
    assert.equal(upstream.state.calls, calls);
    await db.close();
    db = testDb.connect();
    api = new AuthApi(db, config, upstream.fetcher, () => time);
    assert.equal((await api.handle(request('/auth/session', 'GET', first.cookies))).status, 200);
    upstream.state.login = 'renamed';
    const second = await login(api, upstream, first.cookies, first.session.csrf);
    assert.equal(second.session.user.id, first.session.user.id);
    assert.equal(second.session.user.login, 'renamed');
    assert.notEqual(second.cookies, first.cookies);
    assert.notEqual(second.session.csrf, first.session.csrf);
    assert.equal((await api.handle(request('/auth/session', 'GET', first.cookies))).status, 401);
    upstream.state.id = 456;
    const third = await login(api, upstream, second.cookies, second.session.csrf);
    assert.notEqual(third.session.user.id, second.session.user.id);
    assert.equal((await api.handle(request('/auth/session', 'GET', second.cookies))).status, 401);
    assert.equal((await db.get("SELECT count(*) AS n FROM users"))!.n, 2);
    assert.equal((await api.handle(request('/auth/logout', 'POST', third.cookies, { 'x-csrf-token': third.session.csrf }))).status, 204);
    assert.equal((await api.handle(request('/auth/session', 'GET', third.cookies))).status, 401);
  }
  finally {
    await db.close();
  }
});
test('blocks foreign Origin, CSRF, browser/state substitution, duplicate cookies and concurrent replay', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect(), upstream = provider(), api = new AuthApi(db, config, upstream.fetcher, () => time);
  try {
    const foreign = await api.handle(request('/auth/github/start', 'POST', '', { origin: 'https://evil.example' }));
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    assert.equal((await api.handle(new Request(config.apiOrigin + '/auth/github/start', { method: 'POST' }))).status, 403);
    const flow = await begin(api, upstream);
    assert.equal((await api.handle(request(flow.path))).status, 400);
    assert.equal((await api.handle(request(flow.path, 'GET', flow.cookies + '; ' + flow.cookies))).status, 400);
    assert.equal((await api.handle(request(flow.path + '&state=bad', 'GET', flow.cookies))).status, 400);
    assert.equal(upstream.state.calls, 0);
    const results = await Promise.all([api.handle(request(flow.path, 'GET', flow.cookies)), api.handle(request(flow.path, 'GET', flow.cookies))]);
    assert.deepEqual(results.map((value) => value.status).sort(), [303, 400]);
    const cookies = cookie(results.find((value) => value.status === 303)!, 'session');
    const response = await api.handle(request('/auth/session', 'GET', cookies));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), config.webOrigin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    const { csrf } = await response.json();
    assert.equal((await api.handle(request('/auth/logout', 'POST', cookies))).status, 403);
    assert.equal((await api.handle(request('/auth/github/start', 'POST', cookies))).status, 403);
    assert.equal((await api.handle(request('/auth/logout', 'GET', cookies))).status, 404);
    assert.equal((await api.handle(request('/auth/logout', 'POST', cookies, { 'x-csrf-token': csrf, origin: 'null' }))).status, 403);
    assert.equal((await api.handle(request('/auth/session', 'GET', cookies + '; ' + cookies))).status, 401);
    assert.equal((await api.handle(request('/auth/logout', 'OPTIONS', '', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-csrf-token' }))).status, 204);
    assert.equal((await api.handle(request('/auth/logout', 'OPTIONS', '', { 'access-control-request-method': 'DELETE' }))).status, 403);
  }
  finally {
    await db.close();
  }
});
test('expires idle/absolute sessions and pending flows, blocks disabled accounts and prunes records', async (t) => {
  const testDb = await testDatabase(t);
  let now = time;
  const db = testDb.connect(), upstream = provider(), api = new AuthApi(db, config, upstream.fetcher, () => now);
  try {
    const expiredFlow = await begin(api, upstream);
    now += 10 * 60000;
    assert.equal((await api.handle(request(expiredFlow.path, 'GET', expiredFlow.cookies))).status, 400);
    assert.equal(upstream.state.calls, 0);
    const first = await login(api, upstream);
    now += 12 * hour;
    assert.equal((await api.handle(request('/auth/session', 'GET', first.cookies))).status, 401);
    const second = await login(api, upstream);
    for (let i = 0; i < 7 * 24 - 1; i++) {
      now += hour;
      assert.equal((await api.handle(request('/auth/session', 'GET', second.cookies))).status, 200);
    }
    now += hour;
    assert.equal((await api.handle(request('/auth/session', 'GET', second.cookies))).status, 401);
    const third = await login(api, upstream);
    await api.disableUser(third.session.user.id);
    assert.equal((await api.handle(request('/auth/session', 'GET', third.cookies))).status, 401);
    const flow = await begin(api, upstream);
    assert.equal((await api.handle(request(flow.path, 'GET', flow.cookies))).headers.get('location'), config.webOrigin + '/pro?auth=failed');
    assert.equal((await db.get("SELECT count(*) AS n FROM sessions"))!.n, 0);
    now += 31 * 24 * hour;
    await api.prune();
    assert.equal((await db.get("SELECT count(*) AS n FROM oauth_flows"))!.n, 0);
    assert.equal((await db.get("SELECT count(*) AS n FROM auth_events"))!.n, 0);
  }
  finally {
    await db.close();
  }
});
test('provider failures issue no sessions; revokes tokens on failure; logout wins an in-flight callback', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect(), upstream = provider(), api = new AuthApi(db, config, upstream.fetcher, () => time);
  try {
    for (const failure of ['scope', 'failProfile', 'failRevoke'] as const) {
      upstream.state.scope = failure === 'scope' ? 'repo' : '';
      upstream.state.failProfile = failure === 'failProfile';
      upstream.state.failRevoke = failure === 'failRevoke';
      const flow = await begin(api, upstream);
      const response = await api.handle(request(flow.path, 'GET', flow.cookies));
      assert.equal(response.headers.get('location'), config.webOrigin + '/pro?auth=failed');
      assert.ok(!response.headers.getSetCookie().some((value) => value.startsWith('__Host-envhandoff-session=')));
      assert.equal((await db.get("SELECT count(*) AS n FROM sessions"))!.n, 0);
    }
    assert.equal(upstream.state.revoked, 3);
    upstream.state.failRevoke = false;
    const first = await login(api, upstream);
    const pending = await begin(api, upstream, first.cookies, first.session.csrf);
    upstream.state.duringProfile = async () => { await api.handle(request('/auth/logout', 'POST', first.cookies, { 'x-csrf-token': first.session.csrf })); };
    const response = await api.handle(request(pending.path, 'GET', pending.cookies));
    assert.equal(response.headers.get('location'), config.webOrigin + '/pro?auth=failed');
    assert.equal((await db.get("SELECT count(*) AS n FROM sessions"))!.n, 0);
  }
  finally {
    await db.close();
  }
});
test('HTTP requires explicit localhost development; fixed callback ignores return URLs', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect(), upstream = provider();
  try {
    assert.throws(() => new AuthApi(db, { ...config, apiOrigin: 'http://localhost:3001' }));
    assert.throws(() => new AuthApi(db, { ...config, development: true, apiOrigin: 'http://evil.example' }));
    assert.throws(() => new AuthApi(db, { ...config, webOrigin: config.webOrigin + '/path' }));
    const api = new AuthApi(db, config, upstream.fetcher, () => time);
    const response = await api.handle(request('/auth/github/start?returnTo=https://evil.example', 'POST'));
    const url = new URL((await response.json()).url);
    assert.equal(url.searchParams.get('redirect_uri'), config.apiOrigin + '/auth/github/callback');
    assert.equal(url.searchParams.has('returnTo'), false);
    const local = new AuthApi(db, { ...config, development: true, apiOrigin: 'http://localhost:3001', webOrigin: 'http://localhost:5173' });
    const dev = await local.handle(new Request('http://localhost:3001/auth/github/start', { method: 'POST', headers: { origin: 'http://localhost:5173' } }));
    assert.equal(dev.status, 200);
    assert.match(dev.headers.get('set-cookie')!, /^envhandoff-dev-oauth=/);
  }
  finally {
    await db.close();
  }
});
