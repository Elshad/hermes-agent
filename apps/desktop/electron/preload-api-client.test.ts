import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

type WebDesktopWindow = Window & {
  hermesDesktop?: {
    getConnection: (profile: unknown) => Promise<unknown>
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
    assert.deepEqual(JSON.parse(String(init?.body)), {
      channel: 'hermes:connection',
      args: ['work']
    })

    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          profile: 'work',
          mode: 'local',
          baseUrl: 'http://127.0.0.1:43123',
          wsUrl: 'ws://127.0.0.1:43123/api/ws?token=internal-token',
          token: 'internal-token'
        }
      }),
      {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
      }
    )
  })

  vi.stubGlobal('fetch', fetchMock)

  await import('./preload-api-client')

  const desktop = (globalThis.window as WebDesktopWindow).hermesDesktop
  assert.ok(desktop)
  assert.deepEqual(await desktop.getConnection('work'), {
    profile: 'work',
    mode: 'local',
    baseUrl: 'http://127.0.0.1:13043',
    wsUrl: 'ws://127.0.0.1:13043/api/ws',
    token: ''
  })
  assert.equal(fetchMock.mock.calls.length, 1)
})
