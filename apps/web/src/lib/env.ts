import { BundleError, validateFiles } from './bundle.ts'

export type EnvEntry = { key: string; value: string }

type EditableEntry = EnvEntry & { start: number; end: number; quote: "'" | '"' | null }
export type EditableEnv = { text: string; entries: EditableEntry[] }

const unsafeEnv = () => new BundleError('ENV_FORMAT', '이 .env 파일은 변수별로 안전하게 수정할 수 없어요. 파일 전체를 다시 올려주세요.')

export function parseEditableEnv(bytes: Uint8Array): EditableEnv {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw unsafeEnv()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw unsafeEnv()
  }
  if (/\r(?!\n)/.test(text)) throw unsafeEnv()
  const entries: EditableEntry[] = []
  const keys = new Set<string>()
  const lines = text.split(/(\r?\n)/)
  let offset = 0
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]
    if (!/^\s*(?:#.*)?$/.test(line)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!match || keys.has(match[1])) throw unsafeEnv()
      const raw = match[2]
      const quote = raw[0] === "'" || raw[0] === '"' ? raw[0] : null
      const value = quote ? raw.slice(1, -1) : raw
      if (quote ? raw.length < 2 || !raw.endsWith(quote) || value.includes(quote) || value.includes('\\')
        : /[\s#'"`]/.test(value)) throw unsafeEnv()
      keys.add(match[1])
      entries.push({ key: match[1], value, start: offset + match[1].length + 1, end: offset + line.length, quote })
    }
    offset += line.length + (lines[index + 1]?.length ?? 0)
  }
  if (!entries.length) throw unsafeEnv()
  return { text, entries }
}

export function previewEnvEdit(source: EditableEnv, values: string[]): { text: string; changed: string[] } {
  if (values.length !== source.entries.length) throw unsafeEnv()
  let text = source.text
  const changed: string[] = []
  for (let index = source.entries.length - 1; index >= 0; index--) {
    const entry = source.entries[index]
    const value = values[index]
    if (value === entry.value) continue
    // ponytail: preserve existing quote style; add parser-aware rewriting if broader .env syntax is needed.
    // eslint-disable-next-line no-control-regex
    if (/\u0000|\r|\n|\p{Surrogate}/u.test(value) || (entry.quote
      ? value.includes(entry.quote) || value.includes('\\')
      : /[\s#'"`]/.test(value))) {
      throw new BundleError('ENV_VALUE', `${entry.key} 값은 이 파일 형식에 안전하게 저장할 수 없어요. 파일 전체를 다시 올려주세요.`)
    }
    text = text.slice(0, entry.start) + (entry.quote ? `${entry.quote}${value}${entry.quote}` : value) + text.slice(entry.end)
    changed.unshift(entry.key)
  }
  if (!changed.length) throw new BundleError('ENV_EMPTY', '변경한 변수가 없어요.')
  return { text, changed }
}

export function createEnvFile(rows: EnvEntry[]): File {
  const keys = new Set<string>()
  const lines: string[] = []
  for (const [index, row] of rows.entries()) {
    const key = row.key.trim()
    const value = row.value
    if (!key && !value) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new BundleError('ENV_KEY', `${index + 1}번째 키는 영문자나 밑줄로 시작하고 영문자·숫자·밑줄만 사용할 수 있어요.`)
    }
    if (keys.has(key)) throw new BundleError('ENV_KEY', `${key} 키가 중복됐어요.`)
    keys.add(key)

    // CR is normalized by .env parsers; File replaces unpaired Unicode surrogates.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000\r\p{Surrogate}]/u.test(value)) {
      throw new BundleError('ENV_VALUE', `${key} 값에 그대로 저장할 수 없는 문자가 있어요. 원본 파일을 추가해주세요.`)
    }
    let encoded = value
    if (value !== value.trim() || /[#\n]/.test(value) || /^["'`]/.test(value)) {
      // ponytail: use common Node/dotenv quoting; add parser-specific export only if needed.
      const quote = ["'", '"', '`'].find(
        (candidate) => !value.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(value)),
      )
      // dotenv may consume the next line when a closing quote follows a backslash.
      if (!quote || value.endsWith('\\')) {
        throw new BundleError('ENV_VALUE', `${key} 값의 따옴표·역슬래시 조합을 안전하게 저장할 수 없어요. 원본 파일을 추가해주세요.`)
      }
      encoded = `${quote}${value}${quote}`
    }
    lines.push(`${key}=${encoded}`)
  }
  if (!lines.length) throw new BundleError('ENV_EMPTY', '환경변수를 하나 이상 입력해주세요.')
  const file = new File([`${lines.join('\n')}\n`], '.env', { type: 'text/plain;charset=utf-8' })
  validateFiles([{ path: file.name, size: file.size }])
  return file
}
