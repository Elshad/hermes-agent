/**
 * HTTP/WebSocket server for the browser-side `preload-api-client.ts` adapter.
 *
 * This module runs in the dedicated Desktop-Web child process. The Electron
 * main process supplies the dispatch callbacks through the process IPC
 * protocol below. Keeping dispatch injected avoids duplicating Electron IPC
 * handlers and keeps this server independent from Electron.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'

import { MyIpcRenderer } from './preload-web-helper'

export const ipcRendererWeb = new MyIpcRenderer()

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Gateway routes that must be reachable from the browser-facing origin. */
export const PROXY_PREFIXES = ['/api/', '/api', '/auth/', '/auth', '/login', '/logout', '/oauth/', '/oauth']

export interface PreloadWebRequestContext {
  kind: 'invoke' | 'send'
  channel: string
  args: unknown[]
  request?: IncomingMessage
}

export interface PreloadWebServerOptions {
  invoke?: (channel: string, args: unknown[], context: PreloadWebRequestContext) => unknown | Promise<unknown>
  send?: (channel: string, args: unknown[], context: PreloadWebRequestContext) => unknown | Promise<unknown>
  host?: string
  port?: number
  webApiPath?: string
  maxBodyBytes?: number
  /** Built Desktop renderer directory served at the browser-facing root. */
  staticDir?: string
  /** Explicit browser origins allowed to call the loopback HTTP server. */
  allowedOrigins?: string[]
  /** Server-owned local gateway target. The token never leaves this process. */
  gatewayProxy?: PreloadWebGatewayProxy | null
}

export interface PreloadWebGatewayProxy {
  baseUrl: string
  token: string
  /** Server-owned auth material for OAuth/custom-header remotes. */
  headers?: Record<string, string>
  /** Fresh server-owned OAuth WS URL, including its one-use ticket. */
  wsUrl?: string
}

export interface PreloadWebServerAddress {
  host: string
  port: number
}

export interface PreloadWebServer {
  readonly server: Server
  start(): Promise<PreloadWebServerAddress>
  stop(): Promise<void>
  emit(channel: string, ...args: unknown[]): void
  setGatewayProxy(target: PreloadWebGatewayProxy | null): void
}

interface WebApiRequest {
  channel: unknown
  args: unknown
}

interface EventSocket {
  socket: Duplex
  buffer: Buffer
  closed: boolean
}

export type PreloadWebProcessMessage =
  | { type: 'ready'; host: string; port: number }
  | { type: 'request'; id: number; kind: 'invoke' | 'send'; channel: string; args: unknown[] }
  | {
      type: 'response'
      id: number
      ok: boolean
      result?: unknown
      error?: { message: string; name: string; statusCode?: number }
    }
  | { type: 'event'; channel: string; args: unknown[] }
  | { type: 'gateway-config'; gateway: PreloadWebGatewayProxy | null }
  | { type: 'stop' }
  | { type: 'fatal'; error: { message: string; name: string; statusCode?: number } }

/** @deprecated Use PreloadWebProcessMessage. */
export type PreloadWebChildMessage = PreloadWebProcessMessage

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

function isProxyPath(pathname: string): boolean {
  return PROXY_PREFIXES.some(prefix => pathname === prefix || (prefix.endsWith('/') && pathname.startsWith(prefix)))
}

function proxyUrl(
  target: PreloadWebGatewayProxy,
  requestUrl: string,
  host: string,
  includeWebsocketToken = false
): URL {
  const authenticatedWebsocketUrl = includeWebsocketToken && target.wsUrl ? new URL(target.wsUrl) : null
  const base = authenticatedWebsocketUrl || new URL(target.baseUrl)
  const incoming = new URL(requestUrl || '/', `http://${host}`)

  if (authenticatedWebsocketUrl) {
    // The fresh OAuth URL already contains the gateway's exact WS path and
    // one-use ticket. Only carry non-credential routing parameters from the
    // browser-facing request into that private URL.
    const query = new URLSearchParams(base.search)

    for (const [name, value] of incoming.searchParams) {
      if (name !== 'token' && name !== 'ticket') {
        query.append(name, value)
      }
    }

    base.search = query.toString()
  } else {
    const basePath = base.pathname.replace(/\/+$/, '')

    base.pathname = `${basePath}${incoming.pathname}` || '/'
    base.search = incoming.search
  }

  base.hash = ''
  // Credentials are always supplied by the server-owned target. A browser
  // must not be able to replace them through a stale query string.

  if (!authenticatedWebsocketUrl) {
    base.searchParams.delete('token')
    base.searchParams.delete('ticket')
  }

  // The loopback gateway authenticates /api/ws with its query token (the HTTP
  // API accepts the session-token header, but the WebSocket handshake does not).
  // Add the server-owned credential only to this private upstream URL; it is
  // never sent back in the browser-facing response or descriptor.
  if (includeWebsocketToken && !authenticatedWebsocketUrl) {
    base.searchParams.set('token', target.token)
  }

  return base
}

function proxyHeaders(
  request: IncomingMessage,
  target: URL,
  gateway: PreloadWebGatewayProxy
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      ['authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-hermes-session-token'].includes(name)
    ) {
      continue
    }

    headers[name] = value
  }

  for (const [name, value] of Object.entries(gateway.headers || {})) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = value
    }
  }

  headers.host = target.host
  headers.origin = target.origin
  headers['x-hermes-session-token'] = gateway.token

  return headers
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  target: PreloadWebGatewayProxy,
  host: string,
  responseOrigin?: string
): void {
  let destination: URL

  try {
    destination = proxyUrl(target, request.url || '/', host)
  } catch {
    jsonResponse(response, 502, { ok: false, error: { message: 'Configured Hermes backend is unavailable.', name: 'BadGateway' } }, responseOrigin)

    return
  }

  const headers = proxyHeaders(request, destination, target)
  const client = destination.protocol === 'https:' ? httpsRequest : httpRequest

  const upstream = client(
    destination,
    { method: request.method, headers },
    upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    }
  )

  upstream.once('error', () => {
    if (!response.headersSent) {
      jsonResponse(
        response,
        502,
        { ok: false, error: { message: 'Configured Hermes backend is unavailable.', name: 'BadGateway' } },
        responseOrigin
      )
    } else {
      response.destroy()
    }
  })
  request.once('aborted', () => upstream.destroy())
  request.pipe(upstream)
}

function websocketProxyHeaders(request: IncomingMessage, target: URL, key: string, gateway: PreloadWebGatewayProxy): string {
  const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Origin: ${target.origin}`]

  for (const [name, value] of Object.entries(gateway.headers || {})) {
    if (value !== undefined && !['host', 'origin', 'connection', 'upgrade', 'x-hermes-session-token'].includes(name.toLowerCase())) {
      lines.push(`${name}: ${value}`)
    }
  }

  if (gateway.token) {
    lines.push(`X-Hermes-Session-Token: ${gateway.token}`)
  }

  for (const name of ['sec-websocket-protocol', 'sec-websocket-extensions', 'user-agent']) {
    const value = request.headers[name]

    if (typeof value === 'string') {
      lines.push(`${name}: ${value}`)
    }
  }

  return `${lines.join('\r\n')}\r\n\r\n`
}

const MAX_WEBSOCKET_FRAME_BYTES = 16 * 1024 * 1024

function forwardWebsocketFrames(buffer: Buffer, destination: Duplex, maskOutput: boolean): Buffer | null {
  let remaining = buffer

  while (remaining.length >= 2) {
    const firstByte = remaining[0]
    const secondByte = remaining[1]
    const isMasked = (secondByte & 0x80) !== 0
    const lengthCode = secondByte & 0x7f
    let headerLength = 2
    let payloadLength: number

    if (lengthCode < 126) {
      payloadLength = lengthCode
    } else if (lengthCode === 126) {
      if (remaining.length < 4) {
        return remaining
      }

      payloadLength = remaining.readUInt16BE(2)
      headerLength = 4
    } else {
      if (remaining.length < 10) {
        return remaining
      }

      const extendedLength = remaining.readBigUInt64BE(2)

      if (extendedLength > BigInt(MAX_WEBSOCKET_FRAME_BYTES)) {
        return null
      }

      payloadLength = Number(extendedLength)
      headerLength = 10
    }

    if (payloadLength > MAX_WEBSOCKET_FRAME_BYTES) {
      return null
    }

    if (isMasked && remaining.length < headerLength + 4) {
      return remaining
    }

    const maskLength = isMasked ? 4 : 0
    const frameLength = headerLength + maskLength + payloadLength

    if (remaining.length < frameLength) {
      return remaining
    }

    const mask = isMasked ? remaining.subarray(headerLength, headerLength + 4) : null
    const payloadStart = headerLength + maskLength
    const payload = Buffer.from(remaining.subarray(payloadStart, frameLength))

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4]
      }
    }

    const extendedOutputLength = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8
    const outputMask = maskOutput ? randomBytes(4) : null
    const output = Buffer.alloc(2 + extendedOutputLength + (outputMask ? 4 : 0) + payload.length)
    output[0] = firstByte

    if (payload.length < 126) {
      output[1] = (maskOutput ? 0x80 : 0) | payload.length
    } else if (payload.length <= 0xffff) {
      output[1] = (maskOutput ? 0x80 : 0) | 126
      output.writeUInt16BE(payload.length, 2)
    } else {
      output[1] = (maskOutput ? 0x80 : 0) | 127
      output.writeBigUInt64BE(BigInt(payload.length), 2)
    }

    const outputPayloadStart = 2 + extendedOutputLength

    if (outputMask) {
      outputMask.copy(output, outputPayloadStart)

      for (let index = 0; index < payload.length; index += 1) {
        output[outputPayloadStart + 4 + index] = payload[index] ^ outputMask[index % 4]
      }
    } else {
      payload.copy(output, outputPayloadStart)
    }

    destination.write(output)
    remaining = remaining.subarray(frameLength)
  }

  return remaining
}

function proxyWebsocket(request: IncomingMessage, socket: Duplex, head: Buffer, target: PreloadWebGatewayProxy, host: string): void {
  let destination: URL
  const browserKey = request.headers['sec-websocket-key']

  if (typeof browserKey !== 'string') {
    socket.destroy()

    return
  }

  try {
    destination = proxyUrl(target, request.url || '/', host, true)
  } catch {
    socket.destroy()

    return
  }

  const upstreamKey = randomBytes(16).toString('base64')
  let upstream: Duplex
  let responseBuffer = Buffer.alloc(0)
  let browserFrameBuffer: Buffer<ArrayBufferLike> = head
  let upstreamFrameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let established = false
  let handshakeSent = false

  const sendHandshake = () => {
    if (handshakeSent) {
      return
    }

    handshakeSent = true
    upstream.write(websocketProxyHeaders(request, destination, upstreamKey, target))
  }

  upstream =
    destination.protocol === 'https:'
      ? tlsConnect({ host: destination.hostname, port: Number(destination.port) || 443, servername: destination.hostname })
      : netConnect({ host: destination.hostname, port: Number(destination.port) || 80 }, sendHandshake)

  const fail = () => {
    socket.destroy()
    upstream.destroy()
  }

  const flushBrowserFrames = () => {
    const remaining = forwardWebsocketFrames(browserFrameBuffer, upstream, true)

    if (remaining === null) {
      fail()

      return
    }

    browserFrameBuffer = remaining
  }

  const flushUpstreamFrames = () => {
    const remaining = forwardWebsocketFrames(upstreamFrameBuffer, socket, false)

    if (remaining === null) {
      fail()

      return
    }

    upstreamFrameBuffer = remaining
  }

  socket.on('data', chunk => {
    browserFrameBuffer = Buffer.concat([browserFrameBuffer, chunk])

    if (established) {
      flushBrowserFrames()
    }
  })

  if (destination.protocol === 'https:') {
    upstream.once('secureConnect', sendHandshake)
  }

  upstream.on('data', chunk => {
    if (established) {
      upstreamFrameBuffer = Buffer.concat([upstreamFrameBuffer, chunk])
      flushUpstreamFrames()

      return
    }

    responseBuffer = Buffer.concat([responseBuffer, chunk])
    const headerEnd = responseBuffer.indexOf('\r\n\r\n')

    if (headerEnd < 0) {
      return
    }

    const headerText = responseBuffer.subarray(0, headerEnd).toString('latin1')

    if (!/^HTTP\/1\.1 101(?:\s|$)/i.test(headerText)) {
      fail()

      return
    }

    const responseLines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${websocketAccept(browserKey)}`]

    for (const line of headerText.split('\r\n').slice(1)) {
      if (/^sec-websocket-(protocol|extensions):/i.test(line)) {
        responseLines.push(line)
      }
    }

    socket.write(`${responseLines.join('\r\n')}\r\n\r\n`)
    established = true

    const remainder = responseBuffer.subarray(headerEnd + 4)

    if (remainder.length) {
      upstreamFrameBuffer = Buffer.concat([upstreamFrameBuffer, remainder])
    }

    flushUpstreamFrames()
    flushBrowserFrames()
  })
  upstream.once('error', fail)
  upstream.once('close', () => {
    if (!socket.destroyed) {
      socket.destroy()
    }
  })
  socket.once('error', () => upstream.destroy())
  socket.once('close', () => upstream.destroy())
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<WebApiRequest> {
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
        resolve(JSON.parse(body || '{}') as WebApiRequest)
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }))
      }
    })
    request.once('error', reject)
  })
}

function validateRequest(payload: WebApiRequest): { channel: string; args: unknown[] } {
  if (typeof payload?.channel !== 'string' || payload.channel.length === 0) {
    throw Object.assign(new Error('channel must be a non-empty string'), { statusCode: 400 })
  }

  if (!Array.isArray(payload.args)) {
    throw Object.assign(new Error('args must be an array'), { statusCode: 400 })
  }

  return { channel: payload.channel, args: payload.args }
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function staticFilePath(staticDir: string, pathname: string): string | null {
  let decodedPath: string

  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (decodedPath.includes('\0')) {
    return null
  }

  const root = resolve(staticDir)
  const candidate = resolve(root, `.${decodedPath}`)
  const candidateRelative = relative(root, candidate)

  if (candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`)) {
    return null
  }

  return candidate
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  staticDir: string | undefined
): Promise<boolean> {
  if (!staticDir || !['GET', 'HEAD'].includes(request.method || '')) {
    return false
  }

  let decodedPath: string

  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    response.statusCode = 400
    response.end('Bad request')

    return true
  }

  let filePath = staticFilePath(staticDir, pathname)

  if (!filePath) {
    response.statusCode = 400
    response.end('Bad request')

    return true
  }

  try {
    if (!statSync(filePath).isFile()) {
      filePath = join(filePath, 'index.html')
    }

    if (!statSync(filePath).isFile()) {
      throw new Error('not a file')
    }
  } catch {
    // Client-side routes such as `/chat` are handled by the same renderer
    // entrypoint. Do not turn missing asset requests (`.js`, `.css`, etc.)
    // into HTML, because that hides broken bundles behind a misleading MIME
    // error in the browser.
    if (extname(decodedPath)) {
      return false
    }

    filePath = join(resolve(staticDir), 'index.html')

    try {
      if (!statSync(filePath).isFile()) {
        return false
      }
    } catch {
      return false
    }
  }

  const contentType = STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
  response.statusCode = 200
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000')

  if (request.method === 'HEAD') {
    response.end()
  } else if (extname(filePath).toLowerCase() === '.html') {
    const html = readFileSync(filePath, 'utf8')
    const bridgeScript = '<script src="/electron-preload-api-client.js"></script>'

    const body = html.includes(bridgeScript)
      ? html
      : html.replace(/<\/head>/i, `  ${bridgeScript}\n</head>`)

    response.setHeader('Content-Length', Buffer.byteLength(body))
    response.end(body)
  } else {
    createReadStream(filePath).pipe(response)
  }

  return true
}

export function createPreloadWebServer(options: PreloadWebServerOptions): PreloadWebServer {
  const host = options.host || DEFAULT_HOST
  const webApiPath = normalizePath(options.webApiPath || '/web-api')
  const eventsPath = `${webApiPath}/events`
  const invokePath = `${webApiPath}/invoke`
  const sendPath = `${webApiPath}/send`
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES
  const allowedOrigins = new Set(options.allowedOrigins || [])
  const clients = new Set<EventSocket>()
  const invoke = options.invoke || ((channel: string, args: unknown[]) => ipcRendererWeb.invoke(channel, ...args))

  const send =
    options.send ||
    ((channel: string, args: unknown[]) => {
      ipcRendererWeb.send(channel, ...args)
    })

  const staticDir = options.staticDir
  let gatewayProxy = options.gatewayProxy || null

  function allowedOrigin(request: IncomingMessage): string | undefined {
    const origin = request.headers.origin

    if (!origin) {
      return undefined
    }

    // Same-origin browser clients are allowed by default.  Cross-origin clients
    // still need an explicit entry in `allowedOrigins`; this keeps the web server
    // usable when the renderer is served by the same web server without making
    // a remotely bound web server an unrestricted cross-origin API.
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

    if (isProxyPath(url.pathname)) {
      if (!gatewayProxy) {
        jsonResponse(
          response,
          503,
          { ok: false, error: { message: 'Hermes gateway is not ready.', name: 'ServiceUnavailable' } },
          responseOrigin
        )

        return
      }

      proxyHttp(request, response, gatewayProxy, request.headers.host || `${host}:${options.port || 0}`, responseOrigin)

      return
    }

    if (!url.pathname.startsWith(webApiPath) && (await serveStatic(request, response, url.pathname, staticDir))) {
      return
    }

    if (request.method !== 'POST' || ![invokePath, sendPath].includes(url.pathname)) {
      jsonResponse(response, 404, { ok: false, error: { message: 'Not found', name: 'NotFound' } }, responseOrigin)

      return
    }

    try {
      const payload = validateRequest(await readBody(request, maxBodyBytes))
      const kind = url.pathname === invokePath ? 'invoke' : 'send'
      const context: PreloadWebRequestContext = { kind, channel: payload.channel, args: payload.args, request }
      const result = await (kind === 'invoke' ? invoke : send)(payload.channel, payload.args, context)
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
      isProxyPath(url.pathname) &&
      gatewayProxy &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      request.headers['sec-websocket-version'] === '13' &&
      typeof request.headers['sec-websocket-key'] === 'string' &&
      !(request.headers.origin && !allowedOrigin(request))
    ) {
      proxyWebsocket(request, socket, head, gatewayProxy, request.headers.host || `${host}:${options.port || 0}`)

      return
    }

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
    setGatewayProxy: target => {
      gatewayProxy = target
    },
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
            reject(new Error('Preload web server did not receive a TCP address'))

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

function childPort(): number {
  const value = Number(process.env.HERMES_DESKTOP_WEB_PORT)

  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 13043
}

function childAllowedOrigins(): string[] {
  return (process.env.HERMES_DESKTOP_WEB_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

const WEB_EVENT_CHANNELS = [
  'hermes:browser-popout:closed',
  'hermes:wake-indicator:state',
  'hermes:pet-overlay:state',
  'hermes:pet-overlay:control',
  'hermes:hud:goto',
  'hermes:hud:changed',
  'hermes:hud:cursor',
  'hermes:hud:game-overlay',
  'hermes:quick-entry:state',
  'hermes:quick-entry:submit',
  'hermes:quick-entry:shown',
  'hermes:connections:changed',
  'hermes:context-menu-spellcheck',
  'hermes:zoom:changed',
  'hermes:close-preview-requested',
  'hermes:preview-nav',
  'hermes:open-folder-requested',
  'hermes:open-updates',
  'hermes:deep-link',
  'hermes:window-state-changed',
  'hermes:focus-session',
  'hermes:notification-action',
  'hermes:notification-activate',
  'hermes:preview-file-changed',
  'hermes:backend-exit',
  'hermes:connection:applied',
  'hermes:power-resume',
  'hermes:power-battery',
  'hermes:boot-progress',
  'hermes:bootstrap:event',
  'hermes:updates:progress',
  'hermes:found-in-page',
  'hermes:open-find-bar'
] as const

/** Run the HTTP/WebSocket server as a standalone child process. */
export async function runPreloadWebServerProcess(): Promise<void> {
  const webServer = createPreloadWebServer({
    host: process.env.HERMES_DESKTOP_WEB_HOST || DEFAULT_HOST,
    port: childPort(),
    staticDir: process.env.HERMES_DESKTOP_WEB_DIST,
    allowedOrigins: childAllowedOrigins()
  })

  for (const channel of WEB_EVENT_CHANNELS) {
    ipcRendererWeb.on(channel, (...args) => webServer.emit(channel, ...args))
  }

  const shutdown = async (): Promise<void> => {
    await webServer.stop()
    process.exit(0)
  }

  process.on('message', (message: PreloadWebProcessMessage) => {
    if (message?.type === 'gateway-config') {
      webServer.setGatewayProxy(message.gateway)

      return
    }

    if (message?.type === 'stop') {
      void shutdown()
    }
  })
  process.once('disconnect', () => {
    void shutdown()
  })

  try {
    const address = await webServer.start()

    if (typeof process.send !== 'function' || !process.connected) {
      throw new Error('Desktop-Web server parent process is unavailable')
    }

    process.send({ type: 'ready', ...address })
    await new Promise<void>(() => undefined)
  } catch (error) {
    if (typeof process.send === 'function' && process.connected) {
      process.send({
        type: 'fatal',
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error'
        }
      })
    }

    throw error
  }
}

if (process.env.HERMES_DESKTOP_WEB_BRIDGE_PROCESS === '1') {
  void runPreloadWebServerProcess()
}
