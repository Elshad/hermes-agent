import { describe, expect, it, vi } from 'vitest'

import {
  buildGatewayProxyUrl,
  oauthLoginConnectionConfig,
  proxyPrefixes
} from './preload-client-helper'

describe('browser gateway login helper', () => {
  const location = {
    origin: 'https://desktop.example.test',
    search: '?connectionId=remote-a&profile=worker'
  }

  it('keeps the gateway private and carries the WebSocket routing scope', () => {
    const url = buildGatewayProxyUrl('/login', { connectionId: 'remote-a', profile: 'worker' }, location)

    expect(url).toBe('https://desktop.example.test/login?connectionId=remote-a&profile=worker')
    expect(url).not.toContain('gateway.example')
    expect(proxyPrefixes).toContain('/login')
  })

  it('rejects paths that are not part of the gateway proxy surface', () => {
    expect(() => buildGatewayProxyUrl('/private/credentials', {}, location)).toThrow(
      'Path is not available through the gateway proxy: /private/credentials'
    )
  })

  it('opens the public login page and resolves after the proxied session is authenticated', async () => {
    const popup = { closed: false }
    const openWindow = vi.fn(() => popup)
    let attempts = 0

    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts += 1

      return attempts === 1
        ? new Response('', { status: 401 })
        : new Response(JSON.stringify({ user: 'alice' }), { status: 200 })
    })

    const result = await oauthLoginConnectionConfig('https://gateway.example.test', {
      fetch: fetcher,
      location,
      openWindow,
      pollIntervalMs: 50,
      timeoutMs: 1_000
    })

    expect(result).toEqual({
      baseUrl: 'https://gateway.example.test',
      connected: true,
      ok: true
    })
    expect(openWindow).toHaveBeenCalledWith(
      'https://desktop.example.test/login?connectionId=remote-a&profile=worker',
      '_blank',
      'popup,width=520,height=720,resizable=yes,scrollbars=yes'
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://desktop.example.test/api/auth/me?connectionId=remote-a&profile=worker',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        method: 'GET'
      }
    )
  })

  it('fails immediately when the user closes the login window', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 401 }))

    await expect(
      oauthLoginConnectionConfig('https://gateway.example.test', {
        fetch: fetcher,
        location,
        openWindow: () => ({ closed: true })
      })
    ).rejects.toThrow('Login window closed before authentication completed.')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
