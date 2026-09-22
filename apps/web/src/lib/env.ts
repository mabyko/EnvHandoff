import { BundleError, validateFiles } from './bundle.ts'

export type EnvEntry = { key: string; value: string }

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
