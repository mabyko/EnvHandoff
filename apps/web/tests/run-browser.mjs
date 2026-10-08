import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

// Component regressions with mocked HTTP, plus real Web Crypto/IndexedDB checks.
// This suite does not connect to an API server or use a signed-in browser profile.
const root = fileURLToPath(new URL('../', import.meta.url))
const cli = fileURLToPath(new URL('../node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools.js', import.meta.url))
const sessionId = randomUUID()
const cacheDir = fileURLToPath(new URL(`../node_modules/.tmp/browser-${sessionId}/`, import.meta.url))
const run = promisify(execFile)
const abort = new AbortController()
const timeout = 45_000
const env = { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }
let server
let started = false
let pageId

async function command(args, { json = true, cleanup = false } = {}) {
  const { stdout } = await run(process.execPath, [cli, ...args, '--sessionId', sessionId, ...(json ? ['--output-format=json'] : [])], {
    cwd: root, env, timeout: timeout + 15_000, maxBuffer: 2 * 1024 * 1024,
    ...(cleanup ? {} : { signal: abort.signal }),
  })
  const result = json ? JSON.parse(stdout) : stdout
  if (result?.isError || result?.error) throw new Error(JSON.stringify(result))
  return result
}

async function evaluate(expression) {
  const result = await command(['evaluate_script', `async () => (${expression})`, '--pageId', String(pageId)])
  // 1.10.1 returns evaluate_script's JSON value in a fenced message.
  const match = result.message?.match(/```json\n([\s\S]*)\n```/)
  if (!match) throw new Error(`Missing browser evaluation result: ${JSON.stringify(result)}`)
  return JSON.parse(match[1])
}

async function assertNoBrowserErrors(label) {
  const errors = await evaluate("window.__browserTestErrors ?? ['Browser test error collector disappeared after an unexpected reload']")
  if (errors.length) throw new Error(`${label}: ${errors.join('\n')}`)
  const messages = await command(['list_console_messages', String(pageId), '--types', 'error'])
  if (Object.keys(messages).length) throw new Error(`${label}: console error: ${JSON.stringify(messages)}`)
}

const errorCollector = `
  window.__browserTestErrors = [];
  addEventListener('error', event => window.__browserTestErrors.push(event.message || 'Resource loading error'));
  addEventListener('unhandledrejection', event => window.__browserTestErrors.push(String(event.reason?.stack || event.reason)));
`

async function navigate(url) {
  await command(['navigate_page', String(pageId), '--url', url, '--initScript', errorCollector, '--handleBeforeUnload', 'accept'])
}

async function invoke(file, name, expected = 'passed') {
  const result = await evaluate(`Promise.race([
    import(${JSON.stringify(`/tests/${file}`)}).then(module => module[${JSON.stringify(name)}]()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Browser test timed out')), ${timeout}))
  ]).then(value => ({ value }), error => ({ error: String(error?.stack || error) }))`)
  if (result.error || result.value?.[expected] !== true) throw new Error(`${file}#${name}: ${result.error || JSON.stringify(result.value)}`)
  await evaluate('new Promise(resolve => setTimeout(() => resolve(true), 50))')
  await assertNoBrowserErrors(`${file}#${name}`)
  return result.value
}

const interrupt = () => abort.abort(new Error('Browser test run interrupted'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  // Do not load the app's proxy config: an unmocked request must never hit a real API.
  server = await createServer({ configFile: false, root, cacheDir, plugins: [react()], logLevel: 'error', server: {
    host: '127.0.0.1', port: 0, hmr: false, watch: null,
    headers: { 'Content-Security-Policy': "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*" },
  } })
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test server address')
  const url = `http://127.0.0.1:${address.port}/tests/pro-qa.html`
  started = true // Stop the unique daemon even if startup fails partway through.
  await command(['start', '--headless=true', '--isolated=true', '--usageStatistics=false', '--performanceCrux=false',
    ...(process.env.BROWSER_CHROME_PATH ? ['--executablePath', process.env.BROWSER_CHROME_PATH] : [])], { json: false })
  const pages = await command(['list_pages'])
  pageId = pages.pages[0]?.id
  if (!pageId) throw new Error('Isolated Chrome did not create a page')
  await command(['resize_page', String(pageId), '1440', '1000'])
  await navigate(url)
  const files = (await readdir(new URL('./', import.meta.url))).filter(file => /\.browser\.tsx?$/.test(file)).sort()
  if (!files.length) throw new Error('No browser regression modules found')
  const suites = await evaluate(`Promise.all(${JSON.stringify(files)}.map(async file => {
    const module = await import('/tests/' + file);
    return { file, names: Object.keys(module).filter(name => /^verify/.test(name) && typeof module[name] === 'function').sort() };
  }))`)
  await assertNoBrowserErrors('Browser suite discovery')
  let passed = 0
  for (const { file, names } of suites) {
    if (!names.length) throw new Error(`${file} has no exported verify functions`)
    for (const name of names) {
      await navigate(url)
      await evaluate(`(async () => {
        localStorage.clear(); sessionStorage.clear();
        for (const {name} of await indexedDB.databases()) {
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Browser fixture database cleanup blocked'));
          });
        }
        return true;
      })()`)
      if (file === 'team-crypto.browser.ts' && name === 'verify') {
        await invoke(file, 'prepare', 'stored')
        await navigate(url) // New document, same isolated profile: tests actual key persistence.
      }
      const result = await invoke(file, name)
      passed++
      console.log(`PASS ${file}#${name}${result.checks ? ` (${result.checks.length} checks)` : ''}`)
    }
  }
  console.log(`Browser regressions: ${passed} passed across ${files.length} modules (mocked HTTP; real browser crypto and storage).`)
} catch (error) {
  console.error(error?.stack || error)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  try {
    if (started) await command(['stop'], { json: false, cleanup: true })
  } catch (error) {
    console.error('Failed to stop isolated browser daemon:', error.message)
    process.exitCode = 1
  } finally {
    try { await server?.close() }
    finally { await rm(cacheDir, { recursive: true, force: true }) }
  }
}
