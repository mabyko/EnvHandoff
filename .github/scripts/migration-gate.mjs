import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const baseline = 'c4cbc4d6c9a15f246f515ac6d14ac32049a2eb6c'
const manifestPath = '.github/release-migrations/v0.0.7.json'
const migrationPaths = ['apps/api/sql/010-project-permissions.sql', 'apps/api/sql/011-upload-cancellations.sql']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

// expectedBaseline is overridden only by the isolated self-test; no CLI/env override exists.
function gate(env, cwd = process.cwd(), expectedBaseline = baseline) {
  const { CURRENT_DEPLOY_SHA: current, DEPLOY_SHA: target, DEPLOY_REF: ref, DEPLOY_VERSION: version, MIGRATION_PREFLIGHT_SHA: acknowledgement } = env
  assert(/^[a-f0-9]{40}$/.test(current ?? '') && /^[a-f0-9]{40}$/.test(target ?? ''), 'Invalid deployment commit SHA')
  assert.equal(git(cwd, 'rev-parse', 'HEAD').toString().trim(), target, 'Checkout must match the deployment SHA')
  for (const sha of [current, target]) git(cwd, 'cat-file', '-e', `${sha}^{commit}`)
  const changes = paths => git(cwd, 'diff', '--no-renames', '--name-status', current, target, '--', ...paths).toString().trim()
  assert.equal(changes(['compose.production.yaml']), '', 'Compose changes require a separately reviewed procedure')
  const delta = changes(['apps/api/sql'])
  if (!delta) return 'none'
  assert.equal(current, expectedBaseline, 'Unreviewed migration baseline')
  assert.equal(ref, 'release/v0.0.7', 'Unreviewed migration release')
  assert.equal(version, '0.0.7', 'Unreviewed migration version')
  assert.equal(acknowledgement, target, 'Exact deployment SHA requires completed manual migration preflight')
  git(cwd, 'merge-base', '--is-ancestor', current, target)
  assert.deepEqual(delta.split('\n').sort(), migrationPaths.map(path => `A\t${path}`).sort(), 'Only the two reviewed migration additions are permitted')
  const manifest = JSON.parse(git(cwd, 'show', `${target}:${manifestPath}`).toString())
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.release, 'v0.0.7')
  assert.equal(manifest.baselineSha, current, 'Stale migration manifest baseline')
  assert.equal(manifest.deployRef, ref)
  assert.equal(manifest.deployVersion, version)
  assert.deepEqual(Object.keys(manifest.migrations).sort(), [...migrationPaths].sort(), 'Unexpected migration manifest entries')
  assert(Array.isArray(manifest.manualPreflight) && manifest.manualPreflight.length > 0, 'Missing reviewed preflight procedure')
  for (const path of migrationPaths) {
    assert(git(cwd, 'ls-tree', target, '--', path).toString().startsWith('100644 blob '), 'Migration must be a regular SQL file')
    assert(/^[a-f0-9]{64}$/.test(manifest.migrations[path]), 'Invalid pinned migration digest')
    assert.equal(digest(git(cwd, 'show', `${target}:${path}`)), manifest.migrations[path], 'Migration content differs from its reviewed digest')
  }
  return 'v0.0.7'
}

function selfTest() {
  const manifest = JSON.parse(readFileSync(new URL('../release-migrations/v0.0.7.json', import.meta.url), 'utf8'))
  for (const path of migrationPaths) assert.equal(digest(readFileSync(new URL('../../' + path, import.meta.url))), manifest.migrations[path], 'Checked-out SQL must match the release manifest')
  const cwd = mkdtempSync(join(tmpdir(), 'envhandoff-migration-gate-'))
  const put = (path, content) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content) }
  const commit = () => {
    git(cwd, 'add', '--all'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture')
    return git(cwd, 'rev-parse', 'HEAD').toString().trim()
  }
  try {
    git(cwd, 'init', '--quiet'); git(cwd, 'config', 'user.name', 'Gate test'); git(cwd, 'config', 'user.email', 'gate@example.invalid')
    git(cwd, 'config', 'core.hooksPath', '/dev/null')
    put('compose.production.yaml', 'services: {}\n'); put('apps/api/sql/001-initial.sql', 'SELECT 1;\n')
    const base = commit()
    const env = { CURRENT_DEPLOY_SHA: base, DEPLOY_SHA: base }
    assert.equal(gate(env, cwd, base), 'none')
    put('unrelated.txt', 'An unreviewed current deployment\n'); const wrongBaseline = commit()
    const sql = ['SELECT 10;\n', 'SELECT 11;\n']
    manifest.baselineSha = base
    for (const [index, path] of migrationPaths.entries()) { put(path, sql[index]); manifest.migrations[path] = digest(sql[index]) }
    put(manifestPath, JSON.stringify(manifest)); const candidate = commit()
    Object.assign(env, { DEPLOY_SHA: candidate, DEPLOY_REF: 'release/v0.0.7', DEPLOY_VERSION: '0.0.7', MIGRATION_PREFLIGHT_SHA: candidate })
    assert.equal(gate(env, cwd, base), 'v0.0.7')
    for (const mutation of [
      { CURRENT_DEPLOY_SHA: candidate }, { DEPLOY_REF: 'release/v0.0.8' }, { DEPLOY_VERSION: '0.0.8' },
      { MIGRATION_PREFLIGHT_SHA: '' }, { MIGRATION_PREFLIGHT_SHA: base }, { DEPLOY_SHA: base },
    ]) {
      // No SQL delta is an ordinary redeploy, regardless of preflight inputs.
      if (mutation.CURRENT_DEPLOY_SHA) assert.equal(gate({ ...env, ...mutation }, cwd, base), 'none')
      else assert.throws(() => gate({ ...env, ...mutation }, cwd, base))
    }
    assert.throws(() => gate(env, cwd, '0'.repeat(40)), /baseline/)
    assert.throws(() => gate({ ...env, CURRENT_DEPLOY_SHA: wrongBaseline }, cwd, base), /baseline/)
    const rejectChange = (path, contents) => {
      git(cwd, 'reset', '--hard', candidate); git(cwd, 'clean', '-fd')
      if (contents === null) rmSync(join(cwd, path)); else put(path, contents)
      const target = commit()
      assert.throws(() => gate({ ...env, DEPLOY_SHA: target, MIGRATION_PREFLIGHT_SHA: target }, cwd, base))
    }
    rejectChange(migrationPaths[0], 'SELECT 12;\n')
    rejectChange(migrationPaths[1], null)
    rejectChange('apps/api/sql/012-unreviewed.sql', 'SELECT 12;\n')
    rejectChange('apps/api/sql/001-initial.sql', 'SELECT 2;\n')
    rejectChange('compose.production.yaml', 'services: {changed: {}}\n')
    rejectChange(manifestPath, JSON.stringify({ ...manifest, baselineSha: '0'.repeat(40) }))
    rejectChange(manifestPath, JSON.stringify({ ...manifest, migrations: { ...manifest.migrations, [migrationPaths[0]]: '0'.repeat(64) } }))
    rejectChange(manifestPath, JSON.stringify({ ...manifest, deployRef: 'release/v0.0.8' }))
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest()
  else { assert.equal(process.argv.length, 2, 'Unsupported migration gate arguments'); console.log(gate(process.env)) }
} catch (error) { console.error('Migration gate rejected: ' + (error instanceof Error ? error.message : 'verification failed')); process.exitCode = 1 }
