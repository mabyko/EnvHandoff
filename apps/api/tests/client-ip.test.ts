import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientIpPolicy } from '../src/client-ip.ts'

test('origin proof gates client identity, rejects forged headers, and preserves local health probes', () => {
  const secret = 'a'.repeat(64), policy = clientIpPolicy(secret)
  const headers = { 'x-envhandoff-origin': secret, 'cf-connecting-ip': '203.0.113.7' }
  assert.equal(policy('10.0.5.1', headers, 'POST', '/organizations'), '203.0.113.7')
  assert.equal(policy('10.0.5.1', { ...headers, 'cf-connecting-ip': '203.0.113.8' }, 'POST', '/organizations'), '203.0.113.8')
  assert.equal(policy('10.0.5.1', { ...headers, 'cf-connecting-ip': '2001:0db8:0:0::1' }, 'GET', '/shares/id'), '2001:db8::1')
  for (const proof of [undefined, '', 'b'.repeat(64), 'a'.repeat(63), [secret, secret], secret + ', ' + secret]) {
    assert.equal(policy('10.0.5.1', { ...headers, 'x-envhandoff-origin': proof, 'x-real-ip': '173.245.48.1' }, 'GET', '/security'), null)
  }
  for (const client of ['', 'fake', '203.0.113.7, 203.0.113.8', ['203.0.113.7']]) {
    assert.equal(policy('10.0.5.1', { ...headers, 'cf-connecting-ip': client }, 'GET', '/security'), null)
  }
  assert.equal(policy('203.0.113.7', { 'cf-connecting-ip': '203.0.113.8', 'x-forwarded-for': '173.245.48.1' }, 'GET', '/security'), null)
  assert.equal(policy('127.0.0.1', {}, 'GET', '/auth/session'), '127.0.0.1')
  assert.equal(policy('127.0.0.1', { cookie: 'session=secret' }, 'GET', '/auth/session'), null)
  assert.equal(policy('127.0.0.1', {}, 'POST', '/auth/session'), null)
  assert.equal(policy('127.0.0.1', {}, 'GET', '/security'), null)
  assert.equal(clientIpPolicy()('203.0.113.9', headers, 'GET', '/security'), '203.0.113.9')
  assert.throws(() => clientIpPolicy('short-secret'))
})
