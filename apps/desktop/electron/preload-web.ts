/**
 * HTTP/WebSocket bridge for the browser-side `preload-api-client.ts` adapter.
 *
 * The main process supplies the two dispatch callbacks.  Keeping dispatch
 * injected avoids duplicating Electron IPC handlers and makes this module
 * usable with the existing main process without coupling it to one particular
 * handler registry.
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface PreloadBridgeContext {
  kind: 'invoke' | 'send'
  channel: string
  args: unknown[]
  request: IncomingMessage
}

export interface PreloadBridgeOptions {
  invoke: (channel: string, args: unknown[], context: PreloadBridgeContext) => unknown | Promise<unknown>
  send: (channel: string, args: unknown[], context: PreloadBridgeContext) => unknown | Promise<unknown>
  host?: string
  port?: number
  webApiPath?: string
  maxBodyBytes?: number
  /** Explicit browser origins allowed to call the loopback HTTP bridge. */
  allowedOrigins?: string[]
}

export interface PreloadBridgeAddress {
  host: string
  port: number
}

export interface PreloadBridge {
  readonly server: Server
  start(): Promise<PreloadBridgeAddress>
  stop(): Promise<void>
  emit(channel: string, ...args: unknown[]): void
}

interface BridgeRequest {
  channel: unknown
  args: unknown
}

interface EventSocket {
  socket: Duplex
  buffer: Buffer
  closed: boolean
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')

  return `/${trimmed.replace(/^\/+/, '') || 'web-api'}`
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown, origin?: string): void {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))

  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Access-Control-Allow-Credentials', 'true')
    response.setHeader('Vary', 'Origin')
  }

  response.end(body)
}

function errorMessage(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name || 'Error' }
  }

  return { message: String(error), name: 'Error' }
}

function websocketFrame(opcode: number, payload: Buffer): Buffer {
  const first = 0x80 | (opcode & 0x0f)

  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload])
  }

  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = first
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)

    return Buffer.concat([header, payload])
  }

  const header = Buffer.alloc(10)
  header[0] = first
  header[1] = 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)

  return Buffer.concat([header, payload])
}

function closeSocket(client: EventSocket): void {
  if (client.closed) {
    return
  }

  client.closed = true
  client.socket.destroy()
}

function sendWebsocketFrame(client: EventSocket, opcode: number, payload: Buffer): void {
  if (!client.closed && !client.socket.destroyed) {
    client.socket.write(websocketFrame(opcode, payload))
  }
}

function readWebsocketFrames(client: EventSocket): void {
  while (!client.closed && client.buffer.length >= 2) {
    const first = client.buffer[0]
    const second = client.buffer[1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    if (!masked) {
      closeSocket(client)

      return
    }

    if (length === 126) {
      if (client.buffer.length < offset + 2) {
        return
      }

      length = client.buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) {
        return
      }

      const longLength = client.buffer.readBigUInt64BE(offset)
      offset += 8

      if (longLength > BigInt(DEFAULT_MAX_BODY_BYTES)) {
        closeSocket(client)

        return
      }

      length = Number(longLength)
    }

    if (client.buffer.length < offset + 4 + length) {
      return
    }

    const mask = client.buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length))
    client.buffer = client.buffer.subarray(offset + length)

    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }

    if (opcode === 0x8) {
      sendWebsocketFrame(client, 0x8, payload)
      closeSocket(client)
    } else if (opcode === 0x9) {
      sendWebsocketFrame(client, 0xa, payload)
    }
  }
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<BridgeRequest> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0

    request.setEncoding('utf8')
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk)

      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }))
        request.destroy()

        return
      }

      body += chunk
    })
    request.once('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as BridgeRequest)
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }))
      }
    })
    request.once('error', reject)
  })
}

function validateRequest(payload: BridgeRequest): { channel: string; args: unknown[] } {
  if (typeof payload?.channel !== 'string' || payload.channel.length === 0) {
    throw Object.assign(new Error('channel must be a non-empty string'), { statusCode: 400 })
  }

  if (!Array.isArray(payload.args)) {
    throw Object.assign(new Error('args must be an array'), { statusCode: 400 })
  }

  return { channel: payload.channel, args: payload.args }
}

export function createPreloadBridge(options: PreloadBridgeOptions): PreloadBridge {
  const host = options.host || DEFAULT_HOST
  const webApiPath = normalizePath(options.webApiPath || '/web-api')
  const eventsPath = `${webApiPath}/events`
  const invokePath = `${webApiPath}/invoke`
  const sendPath = `${webApiPath}/send`
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES
  const allowedOrigins = new Set(options.allowedOrigins || [])
  const clients = new Set<EventSocket>()

  function allowedOrigin(request: IncomingMessage): string | undefined {
    const origin = request.headers.origin

    if (!origin) {
      return undefined
    }

    // Same-origin browser clients are allowed by default.  Cross-origin clients
    // still need an explicit entry in `allowedOrigins`; this keeps the bridge
    // usable when the renderer is served by the same web server without making
    // a remotely bound bridge an unrestricted cross-origin API.
    const requestHost = request.headers.host

    const sameOrigin =
      typeof requestHost === 'string' && (origin === `http://${requestHost}` || origin === `https://${requestHost}`)

    if (!sameOrigin && !allowedOrigins.has(origin)) {
      return undefined
    }

    return origin
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${options.port || 0}`}`)
    const origin = request.headers.origin
    const responseOrigin = allowedOrigin(request)

    if (origin && !responseOrigin) {
      jsonResponse(response, 403, { ok: false, error: { message: 'Origin is not allowed', name: 'Forbidden' } })

      return
    }

    if (request.method === 'OPTIONS') {
      response.statusCode = responseOrigin ? 204 : 403

      if (responseOrigin) {
        response.setHeader('Access-Control-Allow-Origin', responseOrigin)
        response.setHeader('Access-Control-Allow-Credentials', 'true')
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.setHeader('Vary', 'Origin')
      }

      response.end()

      return
    }

    if (request.method === 'GET' && url.pathname === `${webApiPath}/health`) {
      jsonResponse(response, 200, { ok: true }, responseOrigin)

      return
    }

    if (request.method !== 'POST' || ![invokePath, sendPath].includes(url.pathname)) {
      jsonResponse(response, 404, { ok: false, error: { message: 'Not found', name: 'NotFound' } }, responseOrigin)

      return
    }

    try {
      const payload = validateRequest(await readBody(request, maxBodyBytes))
      const kind = url.pathname === invokePath ? 'invoke' : 'send'
      const context: PreloadBridgeContext = { kind, channel: payload.channel, args: payload.args, request }
      const result = await options[kind](payload.channel, payload.args, context)
      jsonResponse(response, 200, { ok: true, result }, responseOrigin)
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500
      jsonResponse(
        response,
        Number.isInteger(statusCode) ? statusCode : 500,
        {
          ok: false,
          error: errorMessage(error)
        },
        responseOrigin
      )
    }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response)
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${options.port || 0}`}`)

    if (
      url.pathname !== eventsPath ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      request.headers['sec-websocket-version'] !== '13' ||
      typeof request.headers['sec-websocket-key'] !== 'string' ||
      (request.headers.origin && !allowedOrigin(request))
    ) {
      socket.destroy()

      return
    }

    const accept = websocketAccept(request.headers['sec-websocket-key'])
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n')
    )

    const client: EventSocket = { socket, buffer: head?.length ? Buffer.from(head) : Buffer.alloc(0), closed: false }
    clients.add(client)
    socket.on('data', chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk])
      readWebsocketFrames(client)
    })
    socket.on('close', () => clients.delete(client))
    socket.on('error', () => {
      clients.delete(client)
      closeSocket(client)
    })
    readWebsocketFrames(client)
  })

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }

        const onListening = () => {
          server.off('error', onError)
          const address = server.address()

          if (!address || typeof address === 'string') {
            reject(new Error('Preload bridge did not receive a TCP address'))

            return
          }

          resolve({ host, port: address.port })
        }

        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(options.port || 0, host)
      }),
    stop: () =>
      new Promise(resolve => {
        for (const client of clients) {
          closeSocket(client)
        }

        clients.clear()

        if (!server.listening) {
          resolve()

          return
        }

        server.close(() => resolve())
      }),
    emit: (channel, ...args) => {
      if (!channel) {
        return
      }

      const payload = Buffer.from(JSON.stringify({ event: channel, args }))

      for (const client of clients) {
        sendWebsocketFrame(client, 0x1, payload)
      }
    }
  }
}
