import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

vi.mock('./preload-web-helper', () => ({
  MyIpcRenderer: class {
    invoke = vi.fn()
    on = vi.fn()
    send = vi.fn()
  }
}))

import { createPreloadWebServer, ipcRendererWeb } from './preload-web'

function postJson(port: number, path: string, payload: unknown, origin: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin
        }
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode || 0, body: JSON.parse(body) })
        })
      }
    )

    request.on('error', reject)
    request.end(JSON.stringify(payload))
  })
}

describe('preload web server', () => {
  it('serves the built Desktop renderer at the browser root and preserves SPA routes', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'hermes-desktop-web-'))
    await mkdir(join(staticDir, 'assets'))
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><head></head><body><div id="root"></div></body>')
    await writeFile(join(staticDir, 'electron-preload-api-client.js'), 'window.hermesDesktop = {}')
    await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("hermes")')

    const server = createPreloadWebServer({ host: '127.0.0.1', port: 0, staticDir })
    const address = await server.start()

    try {
      const root = await fetch(`http://127.0.0.1:${address.port}/`)
      const asset = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`)
      const route = await fetch(`http://127.0.0.1:${address.port}/chat`)

      expect(root.status).toBe(200)
      expect(root.headers.get('content-type')).toContain('text/html')
      const rootBody = await root.text()
      expect(rootBody).toContain('<div id="root"></div>')
      expect(rootBody).toContain('<script src="/electron-preload-api-client.js"></script>')
      expect(asset.status).toBe(200)
      expect(await asset.text()).toContain('console.log')
      expect(route.status).toBe(200)
      expect(await route.text()).toContain('<script src="/electron-preload-api-client.js"></script>')
    } finally {
      await server.stop()
      await rm(staticDir, { recursive: true, force: true })
    }
  })

  it('dispatches browser invoke and send requests through the supplied handlers', async () => {
    const calls: Array<{ kind: string; channel: string; args: unknown[] }> = []

    const server = createPreloadWebServer({
      host: '127.0.0.1',
      port: 0,
      invoke: async (channel, args) => {
        calls.push({ kind: 'invoke', channel, args })

        return { profile: args[0] }
      },
      send: async (channel, args) => {
        calls.push({ kind: 'send', channel, args })
      }
    })

    const address = await server.start()

    try {
      const origin = `http://127.0.0.1:${address.port}`

      const invoke = await postJson(
        address.port,
        '/web-api/invoke',
        { channel: 'hermes:connection', args: ['work'] },
        origin
      )

      const send = await postJson(
        address.port,
        '/web-api/send',
        { channel: 'hermes:test', args: [{ ok: true }] },
        origin
      )

      expect(invoke).toEqual({ status: 200, body: { ok: true, result: { profile: 'work' } } })
      expect(send).toEqual({ status: 200, body: { ok: true } })
      expect(calls).toEqual([
        { kind: 'invoke', channel: 'hermes:connection', args: ['work'] },
        { kind: 'send', channel: 'hermes:test', args: [{ ok: true }] }
      ])
    } finally {
      await server.stop()
    }
  })

  it('uses ipcRendererWeb for invoke and send requests by default', async () => {
    const invoke = vi.spyOn(ipcRendererWeb, 'invoke').mockResolvedValue({ profile: 'work' })
    const send = vi.spyOn(ipcRendererWeb, 'send').mockImplementation(() => undefined)
    const server = createPreloadWebServer({ host: '127.0.0.1', port: 0 })
    const address = await server.start()

    try {
      const origin = `http://127.0.0.1:${address.port}`

      await postJson(address.port, '/web-api/invoke', { channel: 'hermes:connection', args: ['work'] }, origin)
      await postJson(address.port, '/web-api/send', { channel: 'hermes:test', args: [{ ok: true }] }, origin)

      expect(invoke).toHaveBeenCalledWith('hermes:connection', 'work')
      expect(send).toHaveBeenCalledWith('hermes:test', { ok: true })
    } finally {
      invoke.mockRestore()
      send.mockRestore()
      await server.stop()
    }
  })

  it('proxies gateway HTTP routes with the server-owned token', async () => {
    let upstreamRequest: { headers: Record<string, string | string[] | undefined>; url: string | undefined } | null = null

    const upstream = createServer((request, response) => {
      upstreamRequest = { headers: request.headers, url: request.url }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
    })

    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()

    const server = createPreloadWebServer({
      gatewayProxy: { baseUrl: `http://127.0.0.1:${(upstreamAddress as any).port}`, token: 'server-token' },
      host: '127.0.0.1',
      port: 0
    })

    const address = await server.start()

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/status?token=browser-token&check=1`, {
        headers: { Cookie: 'desktop=session', 'X-Hermes-Session-Token': 'browser-token' }
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(upstreamRequest).toMatchObject({ url: '/api/status?check=1' })
      expect(upstreamRequest?.headers['x-hermes-session-token']).toBe('server-token')
      expect(upstreamRequest?.headers.cookie).toBeUndefined()
    } finally {
      await server.stop()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('proxies gateway WebSocket upgrades and re-signs the browser handshake', async () => {
    let upstreamRequest: { headers: Record<string, string | string[] | undefined>; url: string | undefined } | null = null
    let upstreamSocket: Socket | null = null
    const upstream = createServer()
    upstream.on('upgrade', (request, socket) => {
      upstreamSocket = socket
      upstreamRequest = { headers: request.headers, url: request.url }

      if (new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('token') !== 'server-token') {
        socket.end('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n')

        return
      }

      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Accept: upstream-value',
          '',
          ''
        ].join('\r\n')
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()

    const server = createPreloadWebServer({
      gatewayProxy: { baseUrl: `http://127.0.0.1:${(upstreamAddress as any).port}`, token: 'server-token' },
      host: '127.0.0.1',
      port: 0
    })

    const address = await server.start()
    const socket = netConnect(address.port, address.host)

    try {
      await once(socket, 'connect')
      const browserKey = randomBytes(16).toString('base64')
      socket.write(
        [
          'GET /api/ws?token=browser-token&profile=default HTTP/1.1',
          `Host: ${address.host}:${address.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${browserKey}`,
          'Cookie: desktop=session',
          '',
          ''
        ].join('\r\n')
      )

      const [handshakeChunk] = await once(socket, 'data')

      const expectedAccept = createHash('sha1')
        .update(`${browserKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')

      expect(String(handshakeChunk)).toContain('101 Switching Protocols')
      expect(String(handshakeChunk)).toContain(`Sec-WebSocket-Accept: ${expectedAccept}`)
      expect(upstreamRequest).toMatchObject({ url: '/api/ws?profile=default&token=server-token' })
      expect(upstreamRequest?.headers['x-hermes-session-token']).toBe('server-token')
      expect(upstreamRequest?.headers.cookie).toBeUndefined()
    } finally {
      socket.destroy()
      upstreamSocket?.destroy()
      await server.stop()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('broadcasts emitted Electron events to web clients', async () => {
    const server = createPreloadWebServer({
      host: '127.0.0.1',
      port: 0,
      invoke: async () => undefined,
      send: async () => undefined
    })

    const address = await server.start()
    const socket = netConnect(address.port, address.host)

    try {
      await once(socket, 'connect')
      const key = randomBytes(16).toString('base64')
      socket.write(
        [
          'GET /web-api/events HTTP/1.1',
          `Host: ${address.host}:${address.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${key}`,
          '',
          ''
        ].join('\r\n')
      )

      const [handshakeChunk] = await once(socket, 'data')
      expect(String(handshakeChunk)).toContain('101 Switching Protocols')

      server.emit('hermes:browser-popout:closed', 'tab-1')
      const [eventChunk] = await once(socket, 'data')
      const frame = Buffer.from(eventChunk as Buffer)
      const payloadLength = frame[1] & 0x7f
      const payloadStart = payloadLength < 126 ? 2 : 4
      const payloadEnd = payloadStart + payloadLength

      expect(frame[0] & 0x0f).toBe(0x1)
      expect(JSON.parse(frame.subarray(payloadStart, payloadEnd).toString())).toEqual({
        event: 'hermes:browser-popout:closed',
        args: ['tab-1']
      })
    } finally {
      socket.destroy()
      await server.stop()
    }
  })
})
