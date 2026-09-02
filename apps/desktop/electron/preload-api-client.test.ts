import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

type WebDesktopWindow = Window & {
  hermesDesktop?: {
    getConnection: (profile: unknown) => Promise<unknown>
    api: <T>(request: unknown) => Promise<T>
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'location')
})

test('exposes hermesDesktop and routes getConnection through web-api invoke', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {}
  })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://127.0.0.1:13043' }
  })

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'http://127.0.0.1:13043/web-api/invoke')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'include')
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' })

    const request = JSON.parse(String(init?.body))
    if (request.channel === 'hermes:connection') {
      assert.deepEqual(request, {
        channel: 'hermes:connection',
        args: ['work']
      })

      return new Response(JSON.stringify({ ok: true, result: { profile: 'work' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    assert.deepEqual(request, {
      channel: 'hermes:api',
      args: [{ path: '/api/config' }]
    })

    return new Response(JSON.stringify({ ok: true, result: { profile: 'work' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  vi.stubGlobal('fetch', fetchMock)

  await import('./preload-api-client')

  const desktop = (globalThis.window as WebDesktopWindow).hermesDesktop
  assert.ok(desktop)
  assert.deepEqual(await desktop!.getConnection('work'), { profile: 'work' })
  assert.deepEqual(await desktop!.api<{ profile: string }>({ path: '/api/config' }), { profile: 'work' })
  assert.equal(fetchMock.mock.calls.length, 2)
})
