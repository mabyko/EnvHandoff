// CLI 1.10.1 serializes MCP errors as content objects, dropping isError.
// Successful legacy text responses are arrays of strings instead.
export function parseBrowserCliResult(stdout) {
  const result = JSON.parse(stdout)
  const contentError = Array.isArray(result)
    && (result.length === 0 || result.some(entry => typeof entry !== 'string'))
  if (result === null || typeof result !== 'object' || result.isError || result.error || contentError) {
    throw new Error(`Browser CLI command failed: ${JSON.stringify(result)}`)
  }
  return result
}
