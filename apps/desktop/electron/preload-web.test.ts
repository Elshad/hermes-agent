import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPreloadBridge, startPreloadWebServer } from './preload-web'

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

function getText(port: number, path: string, origin?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: origin ? { Origin: origin } : undefined
        },
        response => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            body += chunk
          })
          response.on('end', () => {
            resolve({ status: response.statusCode || 0, headers: response.headers, body })
          })
        }
      )

      request.on('error', reject)
      request.end()
    }
  )
}

describe('preload bridge', () => {
  it('starts in the preload process and forwards requests through ipcRenderer', async () => {
    const calls: Array<{ method: string; channel: string; args: unknown[] }> = []
    const listeners = new Map<string, (...args: unknown[]) => void>()

    const ipc = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ method: 'invoke', channel, args })

        return { ok: true }
      },
      send: (channel: string, ...args: unknown[]) => {
        calls.push({ method: 'send', channel, args })
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener)
      }
    }

    const server = startPreloadWebServer(ipc, { host: '127.0.0.1', port: 0 })
    const address = await server.ready

    try {
      const invoke = await postJson(
        address.port,
        '/web-api/invoke',
        { channel: 'hermes:connection', args: ['work'] },
        `http://${address.host}:${address.port}`
      )

      const send = await postJson(
        address.port,
        '/web-api/send',
        { channel: 'hermes:test', args: [{ ok: true }] },
        `http://${address.host}:${address.port}`
      )

      expect(invoke.body).toEqual({ ok: true, result: { ok: true } })
      expect(send.body).toEqual({ ok: true })
      expect(calls).toEqual([
        { method: 'invoke', channel: 'hermes:connection', args: ['work'] },
        { method: 'send', channel: 'hermes:test', args: [{ ok: true }] }
      ])
      expect(listeners.has('hermes:boot-progress')).toBe(true)
      expect(listeners.has('hermes:bootstrap:event')).toBe(true)
      expect(listeners.has('hermes:updates:progress')).toBe(true)
      expect(listeners.has('hermes:backend-exit')).toBe(true)
    } finally {
      await server.bridge.stop()
    }
  })

  it('dispatches browser invoke and send requests through the supplied handlers', async () => {
    const calls: Array<{ kind: string; channel: string; args: unknown[] }> = []

    const bridge = createPreloadBridge({
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

    const address = await bridge.start()

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
      await bridge.stop()
    }
  })

  it('serves the shared renderer build and keeps the API namespace separate', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'hermes-desktop-web-'))
    const index = '<!doctype html><html><body>Desktop UI</body></html>'

    await mkdir(join(staticRoot, 'assets'))
    await writeFile(join(staticRoot, 'index.html'), index)
    await writeFile(join(staticRoot, 'assets', 'app.js'), 'console.log("desktop")')
    await writeFile(join(staticRoot, 'outside.txt'), 'must not be exposed')

    const bridge = createPreloadBridge({
      host: '127.0.0.1',
      port: 0,
      staticRoot,
      browserBridgePath: '/electron-preload-api-client.js',
      invoke: async () => undefined,
      send: async () => undefined
    })

    const address = await bridge.start()

    try {
      const origin = `http://127.0.0.1:${address.port}`
      const root = await getText(address.port, '/', origin)
      const asset = await getText(address.port, '/assets/app.js', origin)
      const route = await getText(address.port, '/settings', origin)
      const traversal = await getText(address.port, '/%2e%2e/outside.txt', origin)
      const api = await getText(address.port, '/web-api/health', origin)

      expect(root.status).toBe(200)
      expect(root.body).toContain('<script type="module" src="/electron-preload-api-client.js"></script>')
      expect(root.body).toContain('Desktop UI')
      expect(root.headers['content-type']).toContain('text/html')
      expect(asset).toMatchObject({ status: 200, body: 'console.log("desktop")' })
      expect(route).toMatchObject({ status: 200 })
      expect(route.body).toContain('Desktop UI')
      expect(traversal.status).toBe(400)
      expect(traversal.body).toContain('Bad request')
      expect(api).toEqual(expect.objectContaining({ status: 200, body: '{"ok":true}' }))
    } finally {
      await bridge.stop()
      await rm(staticRoot, { recursive: true, force: true })
    }
  })

  it('broadcasts emitted Electron events to web clients', async () => {
    const bridge = createPreloadBridge({
      host: '127.0.0.1',
      port: 0,
      invoke: async () => undefined,
      send: async () => undefined
    })

    const address = await bridge.start()
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

      bridge.emit('hermes:browser-popout:closed', 'tab-1')
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
      await bridge.stop()
    }
  })
})
