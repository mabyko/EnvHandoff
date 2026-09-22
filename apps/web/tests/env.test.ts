import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { BundleError, createBundle, explainError, LIMITS, openBundle } from '../src/lib/bundle.ts'
import { createEnvFile } from '../src/lib/env.ts'

const isError = (code: string) => (error: unknown) => error instanceof BundleError && error.code === code

test('preserves entered values through an independent .env parser and encrypted sharing', async () => {
  const values = {
    EMPTY: '',
    SPACES: ' \t preserved \t ',
    COMMENT: 'secret#part',
    QUOTES: `both 'single' and "double" # quotes`,
    ALL_QUOTES: 'prefix\'"`suffix',
    DOUBLE_QUOTED: "apostrophe's # and `backtick`",
    LITERAL_ESCAPES: 'C:\\new\\root\\',
    QUOTED_ESCAPES: '# literal \\n and \\r',
    MULTILINE: '\nline one\nFAKE_KEY=still part of the value\n',
    UNICODE: '한글 🔑',
    constructor: 'ordinary valid key',
  }
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }))
  const file = createEnvFile([{ key: '', value: '' }, ...rows, { key: '  TRIMMED_KEY  ', value: ' value ' }])
  assert.equal(file.name, '.env')
  const expected = { ...values, TRIMMED_KEY: ' value ' }
  assert.deepEqual(parseEnv(await file.text()), expected)

  const sealed = await createBundle([{ file, path: file.name }], 'demo', 'development')
  const opened = await openBundle(sealed.bytes, sealed.code)
  assert.equal(opened.files.length, 1)
  assert.equal(opened.files[0].path, '.env')
  assert.deepEqual(parseEnv(new TextDecoder().decode(opened.files[0].bytes)), expected)
})

test('rejects missing, invalid, and duplicate keys without exposing values in errors', () => {
  assert.throws(() => createEnvFile([{ key: ' ', value: '' }]), isError('ENV_EMPTY'))
  for (const key of ['', '1KEY', 'KEY-NAME', 'KEY NAME', '한글', 'KEY\nINJECTED']) {
    assert.throws(() => createEnvFile([{ key, value: 'private-value' }]), (error) => {
      assert(isError('ENV_KEY')(error))
      assert(!explainError(error).includes('private-value'))
      return true
    })
  }
  assert.throws(() => createEnvFile([{ key: 'KEY', value: '' }, { key: ' KEY ', value: '' }]), isError('ENV_KEY'))
})

test('refuses values that common parsers cannot preserve instead of silently changing secrets', () => {
  for (const value of ['carriage\rreturn', 'nul\u0000byte', '\ud800', '# all \'"` quotes', ' # trailing\\']) {
    assert.throws(() => createEnvFile([{ key: 'KEY', value }]), isError('ENV_VALUE'))
  }
})

test('applies existing file size and path collision limits to generated files', async () => {
  assert.throws(() => createEnvFile([{ key: 'KEY', value: 'x'.repeat(LIMITS.fileBytes) }]), isError('SIZE'))
  const file = createEnvFile([{ key: 'KEY', value: 'value' }])
  await assert.rejects(createBundle([{ file, path: '.env' }, { file, path: '.ENV' }], 'demo', 'test'), isError('PATH'))
  await assert.rejects(createBundle([{ file, path: '../.env' }], 'demo', 'test'), isError('PATH'))
})
