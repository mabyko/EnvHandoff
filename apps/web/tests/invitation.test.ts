import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invitationToken } from '../src/lib/invitation.ts'

test('invitation parsing accepts its own fragment link or token without following foreign URLs', () => {
  const token = 'a'.repeat(43), origin = 'https://envhandoff.mabyko.com'
  assert.equal(invitationToken(origin + '/pro#invite=' + token, origin), token)
  assert.equal(invitationToken(' ' + token + ' ', origin), token)
  for (const value of ['https://evil.example/pro#invite=' + token, origin + '/pro?invite=' + token, origin + '/pro#invite=' + token + '&invite=' + token, origin + '/#invite=' + token, 'a'.repeat(42), 'javascript:alert(1)']) assert.equal(invitationToken(value, origin), null)
})
