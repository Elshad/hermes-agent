import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

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
