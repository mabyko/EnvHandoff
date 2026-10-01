import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const packages = ['package.json', 'apps/web/package.json', 'apps/api/package.json', 'apps/server/package.json', 'packages/protocol/package.json']

function releaseVersion(ref) {
  const match = /^refs\/heads\/release\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(ref)
  assert(match, 'Select a release/vX.Y.Z branch, not main or a tag')
  return match[1]
}

function matchingVersions(version, versions) {
  assert.equal(versions.length, packages.length)
  assert(versions.every(value => value === version), 'All five package versions must match the release branch')
}

function matchingTag(taggedSha, sha) {
  assert(!taggedSha || taggedSha === sha, 'Existing version tag points to another commit; never move a release tag')
}

function successfulMainRun(run, sha) {
  return run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success'
}

function successfulCheck(check, sha) {
  return check.head_sha === sha && check.name === 'lint and typecheck' && check.app?.id === 15368 && check.status === 'completed' && check.conclusion === 'success'
}

if (process.argv.includes('--self-test')) {
  assert.equal(releaseVersion('refs/heads/release/v0.0.5'), '0.0.5')
  for (const ref of ['refs/heads/main', 'refs/tags/v0.0.5', 'refs/heads/release/v01.0.5', 'refs/heads/release/v0.0.5/extra']) assert.throws(() => releaseVersion(ref))
  matchingVersions('0.0.5', Array(5).fill('0.0.5'))
  assert.throws(() => matchingVersions('0.0.5', ['0.0.5', '0.0.5', '0.0.4', '0.0.5', '0.0.5']))
  matchingTag(undefined, 'sha')
  matchingTag('sha', 'sha')
  assert.throws(() => matchingTag('previous', 'sha'))
  const run = {head_sha: 'sha', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success'}
  assert(successfulMainRun(run, 'sha'))
  for (const changes of [{head_sha: 'other'}, {head_branch: 'release/v0.0.5'}, {event: 'pull_request'}, {conclusion: 'skipped'}, {conclusion: 'failure'}]) assert(!successfulMainRun({...run, ...changes}, 'sha'))
  const check = {head_sha: 'sha', name: 'lint and typecheck', app: {id: 15368}, status: 'completed', conclusion: 'success'}
  assert(successfulCheck(check, 'sha'))
  assert(!successfulCheck({...check, app: {id: 1}}, 'sha'))
  assert(!successfulCheck({...check, conclusion: 'neutral'}, 'sha'))
  console.log('Release gate self-test passed')
} else {
  const {GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository, GH_TOKEN: token} = process.env
  const version = releaseVersion(ref)
  assert(/^[a-f0-9]{40}$/.test(sha), 'Invalid deployment SHA')
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository')
  assert(token, 'Missing read-only GitHub token')
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), sha, 'Checkout must match the captured SHA')
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])
  matchingVersions(version, packages.map(path => JSON.parse(readFileSync(path, 'utf8')).version))
  const tag = `refs/tags/v${version}`
  const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', tag])
  assert(exists.status === 0 || exists.status === 1, 'Unable to inspect the existing version tag')
  matchingTag(exists.status === 0 ? execFileSync('git', ['rev-parse', `${tag}^{commit}`], {encoding: 'utf8'}).trim() : undefined, sha)
  const base = `https://api.github.com/repos/${repository}`
  async function api(url) {
    const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10'}, signal: AbortSignal.timeout(15000)})
    assert(response.ok, `GitHub verification request failed (${response.status})`)
    return response.json()
  }
  const {workflow_runs: runs} = await api(`${base}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`)
  const run = runs.find(value => value.head_sha === sha && value.head_branch === 'main' && value.event === 'push')
  assert(run && successfulMainRun(run, sha), 'Latest main-push CI must succeed for this exact SHA')
  const {jobs} = await api(`${base}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
  const job = jobs.find(value => value.name === 'lint and typecheck' && value.conclusion === 'success')
  assert(job?.steps.some(step => step.name === 'Run pnpm check' && step.conclusion === 'success'), 'CI must have completed the full pnpm check')
  assert(job.check_run_url.startsWith(`${base}/check-runs/`), 'Invalid CI check URL')
  assert(successfulCheck(await api(job.check_run_url), sha), 'CI must originate from GitHub Actions and pass on this SHA')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nref=${ref.slice('refs/heads/'.length)}\nversion=${version}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release v${version}\n\nCommit: \`${sha}\`\n\nFull CI: ${run.html_url}\n\nAwaiting production approval.\n`)
  console.log(`Verified release/v${version} at ${sha}`)
}
