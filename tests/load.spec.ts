import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatStackJson } from '../src/export.js'
import { loadStackSource } from '../src/load.js'
import { makeStack } from './fixtures.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('remote Stackfile loading', () => {
  it('parses a streamed HTTPS Stackfile within the byte limit', async () => {
    const raw = formatStackJson(makeStack())
    const encoded = new TextEncoder().encode(raw)
    const midpoint = Math.floor(encoded.byteLength / 2)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, midpoint))
        controller.enqueue(encoded.subarray(midpoint))
        controller.close()
      },
    })
    stubFetch(body)

    const stack = await loadStackSource('https://example.test/stack.json', {
      maxBytes: encoded.byteLength,
    })

    expect(stack.name).toBe('Test Stack')
  })

  it('cancels an undeclared oversized response before reading another chunk', async () => {
    let reads = 0
    let cancelled = false
    let released = false
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1
          if (reads > 1) throw new Error('oversized response was read again')
          return { done: false as const, value: new Uint8Array(9) }
        },
        cancel: async () => {
          cancelled = true
        },
        releaseLock: () => {
          released = true
        },
      }),
    } as unknown as ReadableStream<Uint8Array>
    stubFetch(body)

    await expect(loadStackSource('https://example.test/large.json', { maxBytes: 8 }))
      .rejects.toMatchObject({ code: 'STACK_TOO_LARGE' })
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
    expect(released).toBe(true)
  })

  it('cancels a response whose declared size already exceeds the limit', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    stubFetch(body, new Headers({ 'content-length': '9' }))

    await expect(loadStackSource('https://example.test/declared-large.json', { maxBytes: 8 }))
      .rejects.toMatchObject({ code: 'STACK_TOO_LARGE' })
    expect(cancelled).toBe(true)
  })

  it('maps response-stream failures to a safe fetch error', async () => {
    let cancelled = false
    const body = {
      getReader: () => ({
        read: async () => {
          throw new Error('socket included a sensitive diagnostic')
        },
        cancel: async () => {
          cancelled = true
        },
        releaseLock: () => {},
      }),
    } as unknown as ReadableStream<Uint8Array>
    stubFetch(body)

    await expect(loadStackSource('https://example.test/interrupted.json'))
      .rejects.toMatchObject({
        code: 'FETCH_FAILED',
        message: 'Stackfile response body could not be read over HTTPS.',
      })
    expect(cancelled).toBe(true)
  })
})

function stubFetch(body: ReadableStream<Uint8Array> | null, headers = new Headers()): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    url: 'https://example.test/stack.json',
    headers,
    body,
  } as Response)))
}
