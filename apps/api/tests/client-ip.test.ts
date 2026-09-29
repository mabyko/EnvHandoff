import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientIpPolicy } from '../src/client-ip.ts'

test('Cloudflare client identity requires both trusted hops; direct and forged origin traffic fails closed', () => {
  const policy = clientIpPolicy('10.0.5.1')
  const headers = { 'x-real-ip': '173.245.48.1', 'cf-connecting-ip': '203.0.113.7' }
  assert.equal(policy('10.0.5.1', headers, 'POST', '/organizations'), '203.0.113.7')
  assert.equal(policy('::ffff:10.0.5.1', { ...headers, 'cf-connecting-ip': '203.0.113.8' }, 'POST', '/organizations'), '203.0.113.8')
  assert.equal(policy('10.0.5.1', { ...headers, 'x-real-ip': '2606:4700::1', 'cf-connecting-ip': '2001:0db8:0:0::1' }, 'GET', '/shares/id'), '2001:db8::1')
  for (const remote of ['203.0.113.7', '10.0.5.2', undefined]) assert.equal(policy(remote, headers, 'GET', '/security'), null)
  for (const edge of ['203.0.113.7', '173.245.47.255', '173.245.64.0', '', '173.245.48.1, 203.0.113.7']) {
    assert.equal(policy('10.0.5.1', { ...headers, 'x-real-ip': edge }, 'GET', '/security'), null)
  }
  for (const client of ['', 'fake', '203.0.113.7, 203.0.113.8', ['203.0.113.7']]) {
    assert.equal(policy('10.0.5.1', { ...headers, 'cf-connecting-ip': client }, 'GET', '/security'), null)
  }
  assert.equal(policy('10.0.5.1', { 'x-forwarded-for': '203.0.113.7' }, 'GET', '/security'), null)
  assert.equal(policy('127.0.0.1', {}, 'GET', '/auth/session'), '127.0.0.1')
  assert.equal(policy('127.0.0.1', { cookie: 'session=secret' }, 'GET', '/auth/session'), null)
  assert.equal(policy('127.0.0.1', {}, 'POST', '/auth/session'), null)
  assert.equal(policy('127.0.0.1', {}, 'GET', '/security'), null)
  assert.equal(clientIpPolicy()('203.0.113.9', headers, 'GET', '/security'), '203.0.113.9')
  assert.throws(() => clientIpPolicy('10.0.5.0/24'))
})
