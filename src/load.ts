import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { StackError } from './errors.js'
import { DEFAULT_MAX_STACK_BYTES, type DshStack } from './types.js'
import { parseStackJson } from './validation.js'

/** Load and validate a Stackfile from disk or an HTTPS URL. */
export async function loadStackSource(
  source: string,
  options: { cwd?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<DshStack> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STACK_BYTES
  const raw = /^https:\/\//i.test(source)
    ? await fetchStack(source, maxBytes, options.timeoutMs ?? 10_000)
    : readStackFile(source, options.cwd ?? process.cwd(), maxBytes)
  return parseStackJson(raw)
}

function readStackFile(source: string, cwd: string, maxBytes: number): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new StackError('UNSAFE_SOURCE', 'Only local files and HTTPS Stackfile URLs are accepted.')
  }
  const path = resolve(cwd, source)
  let size: number
  try {
    size = statSync(path).size
  } catch {
    throw new StackError('SOURCE_NOT_FOUND', `Stackfile ${JSON.stringify(source)} could not be read.`)
  }
  if (size > maxBytes) throw new StackError('STACK_TOO_LARGE', `Stackfile exceeds the ${maxBytes}-byte limit.`)
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new StackError('SOURCE_NOT_FOUND', `Stackfile ${JSON.stringify(source)} could not be read.`)
  }
}

async function fetchStack(source: string, maxBytes: number, timeoutMs: number): Promise<string> {
  let response: Response
  try {
    response = await fetch(source, {
      headers: { accept: 'application/json, text/plain;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new StackError('FETCH_FAILED', 'Stackfile URL could not be fetched over HTTPS.')
  }
  if (!response.ok) throw new StackError('FETCH_FAILED', `Stackfile server returned HTTP ${response.status}.`)
  if (!response.url.startsWith('https://')) throw new StackError('UNSAFE_SOURCE', 'Stackfile redirects must remain on HTTPS.')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response.body)
    throw new StackError('STACK_TOO_LARGE', `Stackfile exceeds the ${maxBytes}-byte limit.`)
  }
  return readBoundedBody(response.body, maxBytes)
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maxBytes) {
        await cancelReader(reader)
        throw new StackError('STACK_TOO_LARGE', `Stackfile exceeds the ${maxBytes}-byte limit.`)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    if (error instanceof StackError) throw error
    await cancelReader(reader)
    throw new StackError('FETCH_FAILED', 'Stackfile response body could not be read over HTTPS.')
  } finally {
    reader.releaseLock()
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Preserve the size or transport error that made the response unusable.
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel()
  } catch {
    // The declared size remains authoritative even when cancellation fails.
  }
}
