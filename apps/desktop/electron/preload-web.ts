/**
 * Browser-side ipcRenderer compatibility layer for Desktop-Web.
 *
 * This file intentionally has no Electron or Node imports.  It can be bundled
 * into a web client and exposes the small part of Electron's ipcRenderer API
 * that the web client needs over the local `/web-api` bridge.
 */

export interface IpcRendererEvent {
  channel: string
}

export type IpcRendererListener = (event: IpcRendererEvent, ...args: unknown[]) => void

interface WebApiError {
  message?: string
  name?: string
}

interface WebApiResponse<T> {
  ok: boolean
  result?: T
  error?: WebApiError
}

interface WebApiEvent {
  event: string
  args?: unknown[]
  data?: unknown
}

interface WebClientWindow extends Window {
  __HERMES_WEB_API_BASE__?: string
  ipcRenderer?: typeof ipcRenderer
}

const DEFAULT_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5_000

function apiBaseUrl(): string {
  const configured = (globalThis as unknown as WebClientWindow).__HERMES_WEB_API_BASE__

  if (configured) {
    return configured.replace(/\/$/, '')
  }

  if (typeof location !== 'undefined' && location.origin !== 'null') {
    return location.origin
  }

  return ''
}

function apiUrl(path: string): string {
  const base = apiBaseUrl()

  return base ? `${base}${path}` : path
}

function socketUrl(): string {
  const base = apiBaseUrl()

  if (base) {
    const url = new URL('/web-api/events', base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    return url.toString()
  }

  if (typeof location !== 'undefined') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

    return `${protocol}//${location.host}/web-api/events`
  }

  return 'ws://127.0.0.1/web-api/events'
}

async function post<T>(path: string, channel: string, args: unknown[]): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })

  let payload: WebApiResponse<T>

  try {
    payload = (await response.json()) as WebApiResponse<T>
  } catch {
    throw new Error(`Web API request failed with HTTP ${response.status}`)
  }

  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error?.message || `Web API request failed with HTTP ${response.status}`)
    error.name = payload.error?.name || 'WebApiError'
    throw error
  }

  return payload.result as T
}

class WebIpcRenderer {
  private readonly listeners = new Map<string, Set<IpcRendererListener>>()
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = DEFAULT_RECONNECT_DELAY_MS
  private closed = false

  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return post<T>('/web-api/invoke', channel, args)
  }

  /**
   * Electron's send is fire-and-forget.  The web transport still returns a
   * Promise so callers that need delivery/error confirmation can await it;
   * existing callers may safely ignore the returned Promise.
   */
  send(channel: string, ...args: unknown[]): Promise<void> {
    return post('/web-api/send', channel, args).then(() => undefined)
  }

  sendSync(): never {
    throw new Error('ipcRenderer.sendSync is not available in the web client; use invoke instead')
  }

  on(channel: string, listener: IpcRendererListener): this {
    let channelListeners = this.listeners.get(channel)

    if (!channelListeners) {
      channelListeners = new Set()
      this.listeners.set(channel, channelListeners)
    }

    channelListeners.add(listener)
    this.closed = false
    this.ensureSocket()

    return this
  }

  once(channel: string, listener: IpcRendererListener): this {
    const onceListener: IpcRendererListener = (event, ...args) => {
      this.removeListener(channel, onceListener)
      listener(event, ...args)
    }

    return this.on(channel, onceListener)
  }

  removeListener(channel: string, listener: IpcRendererListener): this {
    const channelListeners = this.listeners.get(channel)

    if (!channelListeners) {
      return this
    }

    channelListeners.delete(listener)

    if (channelListeners.size === 0) {
      this.listeners.delete(channel)
    }

    this.closeSocketWhenUnused()

    return this
  }

  off(channel: string, listener: IpcRendererListener): this {
    return this.removeListener(channel, listener)
  }

  removeAllListeners(channel?: string): this {
    if (channel === undefined) {
      this.listeners.clear()
    } else {
      this.listeners.delete(channel)
    }

    this.closeSocketWhenUnused()

    return this
  }

  private ensureSocket(): void {
    if (this.socket || this.reconnectTimer || this.closed || this.listeners.size === 0) {
      return
    }

    const socket = new WebSocket(socketUrl())
    this.socket = socket

    socket.addEventListener('open', () => {
      this.reconnectDelay = DEFAULT_RECONNECT_DELAY_MS
    })

    socket.addEventListener('message', event => {
      this.handleEventMessage(event.data)
    })

    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null
      }

      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      // The close event performs cleanup and schedules the bounded retry.
    })
  }

  private handleEventMessage(raw: unknown): void {
    let message: WebApiEvent

    try {
      message = JSON.parse(String(raw)) as WebApiEvent
    } catch {
      return
    }

    if (!message || typeof message.event !== 'string') {
      return
    }

    const channelListeners = this.listeners.get(message.event)

    if (!channelListeners) {
      return
    }

    const args = Array.isArray(message.args) ? message.args : 'data' in message ? [message.data] : []
    const event: IpcRendererEvent = { channel: message.event }

    for (const listener of [...channelListeners]) {
      listener(event, ...args)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.listeners.size === 0 || this.reconnectTimer) {
      return
    }

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ensureSocket()
    }, delay)
  }

  private closeSocketWhenUnused(): void {
    if (this.listeners.size !== 0) {
      return
    }

    this.closed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.socket?.close()
    this.socket = null
  }
}

export const ipcRenderer = new WebIpcRenderer()

// When bundled as a browser script, make the compatibility object available
// under the familiar global name.  The explicit export also supports normal
// ESM imports and keeps this file usable in tests.
if (typeof window !== 'undefined') {
  Object.assign(window, { ipcRenderer })
}
