import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleResponse } from '../node_modules/chrome-devtools-mcp/build/src/daemon/client.js'
import { parseBrowserCliResult } from './browser-cli-result.mjs'

test('browser runner rejects the installed CLI error encoding even when isError is dropped', async () => {
  const encoded = await handleResponse({ isError: true, content: [{ type: 'text', text: 'Navigation failed' }] }, 'json')
  assert.equal(JSON.parse(encoded).isError, undefined)
  assert.throws(() => parseBrowserCliResult(encoded), /Navigation failed/)
  const empty = await handleResponse({ isError: true, content: [] }, 'json')
  assert.throws(() => parseBrowserCliResult(empty), /Browser CLI command failed/)
})

test('browser runner preserves structured success and legacy text response encodings', async () => {
  const structured = { pages: [{ id: '1', url: 'about:blank' }] }
  const encoded = await handleResponse({ content: [], structuredContent: structured }, 'json')
  assert.deepEqual(parseBrowserCliResult(encoded), structured)
  assert.deepEqual(parseBrowserCliResult(await handleResponse({ content: [{ type: 'text', text: 'Resized page' }] }, 'json')), ['Resized page'])
})

test('browser runner rejects explicit errors and malformed command results', () => {
  for (const result of [{ isError: true }, { error: 'Command failed' }, null, true, 42, [{ type: 'image', data: 'error' }]]) {
    assert.throws(() => parseBrowserCliResult(JSON.stringify(result)), /Browser CLI command failed/)
  }
  assert.throws(() => parseBrowserCliResult('not json'), SyntaxError)
})
