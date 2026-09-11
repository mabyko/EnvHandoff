export const LIMITS = {
  files: 100,
  fileBytes: 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  bundleBytes: 16 * 1024 * 1024,
  pathBytes: 512,
} as const

const encoder = new TextEncoder()
const magic = encoder.encode('ENVHANDOFF')
const headerBytes = 24

export class BundleError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'BundleError'
  }
}

export type SourceFile = { file: File; path: string }
export type BundleFile = { path: string; bytes: Uint8Array<ArrayBuffer> }
export type OpenedBundle = {
  bundleId: string
  projectLabel: string
  environment: string
  createdAt: string
  files: BundleFile[]
}
export type SealedBundle = {
  bytes: ArrayBuffer
  code: string
  filename: string
  projectLabel: string
  environment: string
  fileCount: number
}

function fail(code: string, message: string): never {
  throw new BundleError(code, message)
}

export function validatePath(input: string): string {
  const path = input.normalize('NFC')
  // Reject control and directional characters in portable file paths.
  if (
    !path ||
    encoder.encode(path).length > LIMITS.pathBytes ||
    // eslint-disable-next-line no-control-regex
    /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(path)
  ) {
    fail('PATH', '공유 경로에 사용할 수 없는 문자가 있거나 경로가 너무 길어요.')
  }
  for (const part of path.split('/')) {
    const portable = part.normalize('NFKC')
    if (
      !part ||
      portable === '.' ||
      portable === '..' ||
      /[. ]$/.test(portable) ||
      /[\\/<>:"|?*]/.test(portable) ||
      encoder.encode(part).length > 255 ||
      portable.toLowerCase() === '.git' ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(portable)
    ) {
      fail(
        'PATH',
        '파일 이름을 포함한 상대 경로를 입력해주세요. 상위 폴더·.git·예약된 이름은 사용할 수 없어요.',
      )
    }
  }
  return path
}

export function validateFiles(files: { path: string; size: number }[]): string[] {
  if (files.length < 1 || files.length > LIMITS.files)
    fail('SIZE', '파일은 1개부터 최대 100개까지 선택할 수 있어요.')
  let total = 0
  const paths = files.map(({ path, size }) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes)
      fail('SIZE', '파일 하나의 크기는 1 MiB까지 지원해요.')
    total += size
    return validatePath(path)
  })
  if (total > LIMITS.totalBytes) fail('SIZE', '선택한 파일의 전체 크기는 10 MiB까지 지원해요.')
  const keys = paths.map((path) => path.normalize('NFKC').toUpperCase().toLowerCase())
  const unique = new Set(keys)
  for (const key of keys) {
    const parts = key.split('/')
    if (
      unique.size !== keys.length ||
      parts.some((_, i) => i > 0 && unique.has(parts.slice(0, i).join('/')))
    ) {
      fail('PATH', '서로 겹치는 공유 경로가 있어요. 대소문자가 다른 이름도 확인해주세요.')
    }
  }
  return paths
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  }
  return btoa(binary)
}

function fromBase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(LIMITS.fileBytes / 3) ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    fail('FORMAT', '공유 파일 안의 데이터 형식을 확인할 수 없어요.')
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  if (toBase64(bytes) !== value) fail('FORMAT', '공유 파일 안의 데이터 형식이 올바르지 않아요.')
  return bytes
}

function codeFromBytes(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function readCode(input: string): Uint8Array<ArrayBuffer> {
  const code = input.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) fail('CODE', '43자리 공유 코드를 빠짐없이 입력해주세요.')
  const bytes = Uint8Array.from(atob(`${code.replaceAll('-', '+').replaceAll('_', '/')}=`), (char) =>
    char.charCodeAt(0),
  )
  if (bytes.length !== 32 || codeFromBytes(bytes) !== code)
    fail('CODE', '공유 코드의 형식이 올바르지 않아요.')
  return bytes
}

function text(value: unknown, name: string, max: number): string {
  // Metadata must stay on one line and contain no control characters.
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('FORMAT', `${name}을 1~${max}자로 입력해주세요.`)
  }
  return value.trim()
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) {
    fail('FORMAT', '지원하는 공유 파일 형식이 아니에요.')
  }
  return value as Record<string, unknown>
}

function getCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle)
    fail('UNAVAILABLE', '암호화 기능을 사용할 수 없어요. HTTPS 주소로 접속해주세요.')
  return crypto.subtle
}

export async function createBundle(
  sources: SourceFile[],
  projectInput: string,
  environmentInput: string,
): Promise<SealedBundle> {
  const subtle = getCrypto()
  const projectLabel = text(projectInput, '프로젝트 표시명', 80)
  const environment = text(environmentInput, '환경 이름', 48)
  const paths = validateFiles(sources.map(({ file, path }) => ({ path, size: file.size })))
  const files = []
  for (let i = 0; i < sources.length; i++) {
    let buffer: ArrayBuffer
    try {
      buffer = await sources[i].file.arrayBuffer()
    } catch {
      fail('READ', '선택한 파일을 읽지 못했어요. 파일을 다시 선택해주세요.')
    }
    if (buffer.byteLength !== sources[i].file.size)
      fail('READ', '파일이 변경됐어요. 파일을 다시 선택해주세요.')
    files.push({ path: paths[i], contentBase64: toBase64(new Uint8Array(buffer)) })
  }
  const bundleId = crypto.randomUUID()
  const payload = encoder.encode(
    JSON.stringify({
      formatVersion: 1,
      bundleId,
      projectLabel,
      environment,
      createdAt: new Date().toISOString(),
      files,
    }),
  )
  if (payload.byteLength + headerBytes + 16 > LIMITS.bundleBytes)
    fail('SIZE', '공유 파일의 최대 크기를 넘었어요.')
  const header = new Uint8Array(headerBytes)
  header.set(magic)
  new DataView(header.buffer).setUint16(10, 1, false)
  header.set(crypto.getRandomValues(new Uint8Array(12)), 12)
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const code = codeFromBytes(rawKey)
  const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
  rawKey.fill(0)
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: header.slice(12), additionalData: header, tagLength: 128 },
    key,
    payload,
  )
  const bytes = new Uint8Array(header.byteLength + ciphertext.byteLength)
  bytes.set(header)
  bytes.set(new Uint8Array(ciphertext), header.byteLength)
  return {
    bytes: bytes.buffer,
    code,
    filename: `envhandoff-${bundleId}.envhandoff`,
    projectLabel,
    environment,
    fileCount: files.length,
  }
}

export async function openBundle(buffer: ArrayBuffer, code: string): Promise<OpenedBundle> {
  const subtle = getCrypto()
  if (buffer.byteLength > LIMITS.bundleBytes) fail('SIZE', '공유 파일은 최대 16 MiB까지 열 수 있어요.')
  if (buffer.byteLength < headerBytes + 16) fail('FORMAT', '공유 파일이 잘렸거나 올바른 형식이 아니에요.')
  const header = new Uint8Array(buffer.slice(0, headerBytes))
  if (!magic.every((byte, i) => byte === header[i])) fail('FORMAT', 'EnvHandoff 공유 파일을 선택해주세요.')
  if (new DataView(header.buffer).getUint16(10, false) !== 1)
    fail('VERSION', '이 공유 파일은 다른 형식 버전으로 만들어졌어요.')
  const rawKey = readCode(code)
  const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  rawKey.fill(0)
  let plaintext: ArrayBuffer
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: header.slice(12), additionalData: header, tagLength: 128 },
      key,
      buffer.slice(headerBytes),
    )
  } catch {
    fail('AUTH', '공유 코드가 다르거나 파일이 손상됐어요. 보낸 사람에게 확인해주세요.')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    fail('FORMAT', '공유 파일 안의 데이터를 읽을 수 없어요.')
  }
  const payload = record(decoded, [
    'formatVersion',
    'bundleId',
    'projectLabel',
    'environment',
    'createdAt',
    'files',
  ])
  if (
    payload.formatVersion !== 1 ||
    typeof payload.bundleId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.bundleId)
  )
    fail('FORMAT', '공유 파일의 버전 또는 식별자가 올바르지 않아요.')
  if (
    typeof payload.createdAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(payload.createdAt) ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    new Date(payload.createdAt).toISOString() !== payload.createdAt
  )
    fail('FORMAT', '공유 파일의 생성 시각이 올바르지 않아요.')
  if (!Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > LIMITS.files)
    fail('SIZE', '공유 파일의 파일 개수가 지원 범위를 벗어났어요.')
  const files = payload.files.map((value) => {
    const file = record(value, ['path', 'contentBase64'])
    if (typeof file.path !== 'string') fail('PATH', '공유 경로를 확인할 수 없어요.')
    return { path: file.path, bytes: fromBase64(file.contentBase64) }
  })
  const paths = validateFiles(files.map((file) => ({ path: file.path, size: file.bytes.byteLength })))
  return {
    bundleId: payload.bundleId,
    projectLabel: text(payload.projectLabel, '프로젝트 표시명', 80),
    environment: text(payload.environment, '환경 이름', 48),
    createdAt: payload.createdAt,
    files: files.map((file, i) => ({ ...file, path: paths[i] })),
  }
}

export function explainError(error: unknown): string {
  return error instanceof BundleError ? error.message : '처리하지 못했어요. 잠시 후 다시 시도해주세요.'
}
