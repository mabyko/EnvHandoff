import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalPath } from '../src/http.ts'

test('HTTP target validation prevents URL normalization from bypassing path rate limits', () => {
  for (const path of ['/shares/id', '/organizations/org/shares', '/organizations/org/requests/id/uploads', '/security', '/auth/github/start']) {
    assert.equal(canonicalPath(path), path)
    assert.equal(canonicalPath(path+'?next=/probe/../shares/id'), path)
    const bypass='/probe/..'+path
    assert.equal(new Request('http://localhost'+bypass).url, 'http://localhost'+path)
    assert.equal(canonicalPath(bypass), null)
    assert.equal(canonicalPath('/probe/%2e%2e'+path), null)
  }
  for (const target of ['', '//other/shares/id', '/probe/./shares/id', '/probe\\..\\shares/id', '/shares/id#fragment', '/shares/id\n', '/'+ 'a'.repeat(4096)]) {
    assert.equal(canonicalPath(target), null)
  }
})
