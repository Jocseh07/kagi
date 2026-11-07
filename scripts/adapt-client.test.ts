import { afterEach, describe, expect, it } from 'bun:test'

import { chatJson, createTextStageSignal, generateImage, listModels, MalformedReplyError, MISSING_ENDPOINT } from '../src/lib/adapt/client'

const connection = { endpoint: 'http://localhost:8317/v1', apiKey: '' }
const originalFetch = globalThis.fetch
const originalTimeout = AbortSignal.timeout

afterEach(() => {
  globalThis.fetch = originalFetch
  AbortSignal.timeout = originalTimeout
})

function reply(content: unknown, finish_reason = 'stop') {
  return Response.json({ choices: [{ message: { content }, finish_reason }] })
}

describe('endpoint guard', () => {
  it('sends nothing when no endpoint is set', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return reply('{}') }) as unknown as typeof fetch
    const unset = { endpoint: '', apiKey: '' }
    await expect(chatJson(unset, 'model', 'system', 'user')).rejects.toThrow(MISSING_ENDPOINT)
    await expect(generateImage(unset, 'model', 'scene', '1024x1024')).rejects.toThrow(MISSING_ENDPOINT)
    await expect(listModels(unset)).rejects.toThrow(MISSING_ENDPOINT)
    expect(calls).toBe(0)
  })
})

describe('adaptation text transport', () => {
  it('reads a balanced object without treating braces inside quoted dialogue as structure', async () => {
    globalThis.fetch = (async () => reply('Note: {"line":"He said \\\"{wait}\\\".","next":{"ok":true}} ignored')) as typeof fetch
    expect(await chatJson(connection, 'model', 'system', 'user')).toEqual({ line: 'He said "{wait}".', next: { ok: true } })
  })

  it('rejects truncated output even when its prefix contains a complete object', async () => {
    globalThis.fetch = (async () => reply('{"pages":[]} trailing', 'length')) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'user')).rejects.toBeInstanceOf(MalformedReplyError)
  })

  it.each([null, {}, { choices: [null] }, { choices: [{ message: { content: [] } }] }])('rejects malformed response envelopes', async (value) => {
    globalThis.fetch = (async () => Response.json(value)) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'user')).rejects.toBeInstanceOf(MalformedReplyError)
  })

  it('retains malformed content for a corrective request', async () => {
    globalThis.fetch = (async () => reply('{"pages":[')) as typeof fetch
    try {
      await chatJson(connection, 'model', 'system', 'user')
      throw new Error('Malformed content was accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedReplyError)
      expect((error as MalformedReplyError).content).toBe('{"pages":[')
    }
  })

  it('does not issue a request after cancellation', async () => {
    let requests = 0
    globalThis.fetch = (async () => { requests++; return reply('{}') }) as typeof fetch
    const controller = new AbortController()
    controller.abort(new DOMException('Stopped', 'AbortError'))
    await expect(chatJson(connection, 'model', 'system', 'user', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(0)
  })

  it('cancels during a rate-limit wait without submitting duplicate work', async () => {
    let requests = 0
    const controller = new AbortController()
    globalThis.fetch = (async () => {
      requests++
      queueMicrotask(() => controller.abort(new DOMException('Stopped', 'AbortError')))
      return Response.json({ error: { code: 'rate_limit' } }, { status: 429, headers: { 'Retry-After': '60' } })
    }) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'user', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(1)
  })

  it('bounds stalled response bodies without restarting the generation', async () => {
    AbortSignal.timeout = () => originalTimeout(10)
    let requests = 0
    globalThis.fetch = (async (_input, init) => {
      requests++
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'user')).rejects.toMatchObject({ name: 'AdaptApiError', status: 408 })
    expect(requests).toBe(1)
  })

  it('preserves cancellation through a shared stage deadline', () => {
    const controller = new AbortController()
    const signal = createTextStageSignal(controller.signal)
    controller.abort(new DOMException('Stopped', 'AbortError'))
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe('AbortError')
  })

  it('rejects an HTML download instead of saving it as a generated panel', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      return requests === 1
        ? Response.json({ data: [{ url: 'http://localhost/generated.png' }] })
        : new Response('<html>Image expired</html>', { headers: { 'Content-Type': 'text/html' } })
    }) as typeof fetch
    await expect(generateImage(connection, 'model', 'scene', '1024x1024')).rejects.toMatchObject({ name: 'AdaptApiError' })
    expect(requests).toBe(2)
  })

  it('reports missing image data rather than crashing on a null envelope', async () => {
    globalThis.fetch = (async () => Response.json(null)) as typeof fetch
    await expect(generateImage(connection, 'model', 'scene', '1024x1024')).rejects.toMatchObject({
      name: 'AdaptApiError',
      message: 'The image model returned no image.',
    })
  })

  it('accepts an image reply past the chat reply cap', async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ b64_json: 'A'.repeat(4_000_000) }] })) as typeof fetch
    expect((await generateImage(connection, 'model', 'scene', '1024x1536')).size).toBe(3_000_000)
  })

  it('still rejects a runaway chat reply', async () => {
    globalThis.fetch = (async () => reply(`{"a":"${'x'.repeat(2_100_000)}"}`)) as typeof fetch
    await expect(chatJson(connection, 'model', 'system', 'user')).rejects.toThrow('ran past 2 million characters')
  })
})
