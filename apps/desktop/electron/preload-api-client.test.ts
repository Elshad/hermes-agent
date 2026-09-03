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
  Reflect.deleteProperty(globalThis, '__HERMES_WEB_API_BASE__')
})

test('exposes hermesDesktop and routes getConnection through web-api invoke', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {}
  })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://browser-origin.invalid' }
  })
  Object.defineProperty(globalThis, '__HERMES_WEB_API_BASE__', {
    configurable: true,
    value: 'http://127.0.0.1:13043'
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

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            profile: 'work',
            baseUrl: 'https://remote-gateway.example/api',
            wsUrl: 'wss://remote-gateway.example/api/ws?ticket=test-ticket',
            token: 'server-only-token'
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
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
  assert.deepEqual(await desktop!.getConnection('work'), {
    profile: 'work',
    baseUrl: 'http://127.0.0.1:13043/api',
    wsUrl: 'ws://127.0.0.1:13043/api/ws?profile=work',
    token: ''
  })
  assert.deepEqual(await desktop!.api<{ profile: string }>({ path: '/api/config' }), { profile: 'work' })
  assert.equal(fetchMock.mock.calls.length, 2)
})
