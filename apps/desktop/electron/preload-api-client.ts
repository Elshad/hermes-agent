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

interface HermesApiRequest {
  path: string
  method?: string
  body?: unknown
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }
  timeoutMs?: number
  profile?: string | null
  connectionId?: string | null
}

interface WebClientWindow extends Window {
  __HERMES_WEB_API_BASE__?: string
  ipcRenderer?: typeof ipcRenderer
}

const DEFAULT_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5_000
// The browser-facing gateway endpoint. Change this one path if the web bridge
// is mounted below a different gateway namespace; the base and WebSocket URLs
// below derive from it.
const WEB_GATEWAY_BASE_PATH = '/api'

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

interface GatewayWebsocketScope {
  connectionId?: null | string
  profile?: null | string
}

function browserGatewayBaseUrl(): URL | null {
  if (typeof location === 'undefined') {
    return null
  }

  return new URL(WEB_GATEWAY_BASE_PATH, apiBaseUrl() || location.origin)
}

function browserGatewayWebsocketUrl(scope: GatewayWebsocketScope): string | null {
  const url = browserGatewayBaseUrl()

  if (!url) {
    return null
  }

  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  if (scope.connectionId) {
    url.searchParams.set('connectionId', scope.connectionId)
  }

  if (scope.profile) {
    url.searchParams.set('profile', scope.profile)
  }

  return url.toString()
}

function rewriteGatewayWebsocketUrl(value: unknown, scope: GatewayWebsocketScope): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    const target = new URL(value)

    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      return value
    }

    return browserGatewayWebsocketUrl(scope) || value
  } catch {
    return value
  }
}

function rewriteGatewayResult(value: unknown, scope: GatewayWebsocketScope): unknown {
  if (typeof value === 'string') {
    return rewriteGatewayWebsocketUrl(value, scope)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as { baseUrl?: unknown; token?: unknown; wsUrl?: unknown }
  const rewritten: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  const baseUrl = browserGatewayBaseUrl()

  if (typeof record.baseUrl === 'string' && baseUrl) {
    rewritten.baseUrl = baseUrl.toString().replace(/\/$/, '')
  }

  if (typeof record.wsUrl === 'string') {
    rewritten.wsUrl = rewriteGatewayWebsocketUrl(record.wsUrl, scope)
  }

  if ('token' in record) {
    rewritten.token = ''
  }

  return rewritten
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

/**
 * Keep the renderer contract identical to Electron's preload.  The UI calls
 * `window.hermesDesktop.*`; only the transport underneath changes in web mode:
 * every invoke/send below uses the browser-side ipcRenderer above, which posts
 * to `/web-api/invoke` or `/web-api/send`.
 */
const hermesDesktop = {
  // Browser clients do not have Electron's native glass/translucency support.
  glassSupported: false,
  translucencySupported: false,
  getConnection: (profile: null | string | undefined) =>
    ipcRenderer.invoke('hermes:connection', profile).then(result => rewriteGatewayResult(result, { profile })),
  // Registry-scoped backend resolution: { connectionId, profile } → descriptor.
  getConnectionFor: (payload: { connectionId?: null | string; profile?: null | string }) =>
    ipcRenderer.invoke('hermes:connection:for', payload).then(result => rewriteGatewayResult(result, payload)),
  getProfileRoutes: profiles => ipcRenderer.invoke('hermes:plugin-profile-routes', profiles),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: (profile: null | string | undefined) => ipcRenderer.invoke('hermes:backend:touch', profile),
  getGatewayWsUrl: (profile: null | string | undefined) =>
    ipcRenderer.invoke('hermes:gateway:ws-url', profile).then(result => rewriteGatewayResult(result, { profile })),
  // Registry-scoped fresh WS URL: { connectionId, profile } → result shape of
  // getGatewayWsUrl, minted against that connection's backend.
  getGatewayWsUrlFor: (payload: { connectionId?: null | string; profile?: null | string }) =>
    ipcRenderer.invoke('hermes:gateway:ws-url-for', payload).then(result => rewriteGatewayResult(result, payload)),
  // Union agent roster across every registered connection.
  getAgentRoster: () => ipcRenderer.invoke('hermes:agents:roster'),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openSessionInTerminal: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openInTerminal', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('hermes:window:openInstance'),
  openBrowserWindow: tabId => ipcRenderer.invoke('hermes:window:openBrowser', tabId),
  onBrowserPopoutClosed: callback => {
    const listener = (_event, tabId) => callback(tabId)
    ipcRenderer.on('hermes:browser-popout:closed', listener)

    return () => ipcRenderer.removeListener('hermes:browser-popout:closed', listener)
  },
  claimAmbientCue: key => ipcRenderer.invoke('hermes:ambient:claim', key),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('hermes:wake-indicator:get'),
    setState: state => ipcRenderer.send('hermes:wake-indicator:set', state),
    onState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('hermes:wake-indicator:state', listener)
    }
  },
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('hermes:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('hermes:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('hermes:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:control', listener)
    }
  },
  // HUD mode: the chrome-free floating chat. A full app renderer (own gateway)
  // sized as a floating bar, so it mounts the real composer. Main owns the
  // window; `onChanged` keeps every window's toggle truthful.
  hud: {
    // Browser clients do not have Electron window-drag or native HUD support.
    nativeDrag: false,
    windowing: {
      clientPlacement: true,
      controlDrag: false,
      nativeDrag: false,
      solid: false,
      workspaceTransfer: false
    },
    open: request => ipcRenderer.invoke('hermes:hud:open', request),
    close: () => ipcRenderer.invoke('hermes:hud:close'),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:hud:ignore-mouse', ignore),
    beginMove: () => ipcRenderer.send('hermes:hud:begin-move'),
    endMove: () => ipcRenderer.send('hermes:hud:end-move'),
    moveBy: delta => ipcRenderer.send('hermes:hud:move-by', delta),
    setWorkspaceTransfer: transferring => ipcRenderer.send('hermes:hud:workspace-transfer', transferring),
    setBounds: bounds => ipcRenderer.send('hermes:hud:set-bounds', bounds),
    resetLayout: () => ipcRenderer.invoke('hermes:hud:reset-layout'),
    // Whether the band covers the window below the bar. Main pairs it with the
    // user's translucency setting to decide the native frost (macOS vibrancy /
    // Windows 11 DWM backdrop) — see hudFrostFor.
    setFrost: showing => ipcRenderer.invoke('hermes:hud:frost', showing),
    // The HUD tells main which session it is on; main hands that back to the
    // app window when the HUD closes, so the app can re-home onto it.
    setSession: sessionId => ipcRenderer.send('hermes:hud:session', sessionId),
    onGoto: callback => {
      const listener = (_event, sessionId) => callback(sessionId)
      ipcRenderer.on('hermes:hud:goto', listener)

      return () => ipcRenderer.removeListener('hermes:hud:goto', listener)
    },
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:hud:changed', listener)

      return () => ipcRenderer.removeListener('hermes:hud:changed', listener)
    },
    // Linux only, and silent elsewhere: where the cursor is, in page
    // coordinates, or null when it has left the window. Stands in for the
    // mousemove that `setIgnoreMouseEvents(true, { forward: true })` delivers on
    // macOS and Windows but not here.
    onCursor: callback => {
      const listener = (_event, point) => callback(point)
      ipcRenderer.on('hermes:hud:cursor', listener)

      return () => ipcRenderer.removeListener('hermes:hud:cursor', listener)
    },
    // Main's game-overlay watch: whether a fullscreen app (a game) is under
    // the HUD, so the renderer can step back to the low-opacity overlay
    // treatment while one owns the screen.
    onGameOverlay: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:hud:game-overlay', listener)

      return () => ipcRenderer.removeListener('hermes:hud:game-overlay', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('hermes:quick-entry:settings:get'),
    setSettings: patch => ipcRenderer.invoke('hermes:quick-entry:settings:set', patch),
    submit: payload => ipcRenderer.send('hermes:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('hermes:quick-entry:dismiss'),
    // Primary renderer → main → quick window: gateway connection state + the
    // recent-session options the target picker offers. Main caches the latest
    // payload so a freshly spawned quick window starts from truth.
    pushState: payload => ipcRenderer.send('hermes:quick-entry:state', payload),
    // Quick window subscribes to those pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:state', listener)
    },
    // Main → primary renderer: a submit captured by the quick window.
    onSubmit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:submit', listener)
    },
    // Main → quick window: you were just summoned (reset draft + refocus).
    onShown: callback => {
      const listener = () => callback()
      ipcRenderer.on('hermes:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('hermes:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:test', payload),
  // Opt-in OS-keychain encryption for stored gateway secrets (default off —
  // see secret-storage-policy.ts). get never touches the OS keychain.
  getSecretStorageEncryption: () => ipcRenderer.invoke('hermes:secret-storage:get'),
  setSecretStorageEncryption: (on: boolean) => ipcRenderer.invoke('hermes:secret-storage:set', on),
  // v2 multi-connection registry: named agent sources (local / remote / cloud / ssh).
  connections: {
    list: () => ipcRenderer.invoke('hermes:connections:list'),
    save: payload => ipcRenderer.invoke('hermes:connections:save', payload),
    remove: id => ipcRenderer.invoke('hermes:connections:remove', id),
    setPrimary: id => ipcRenderer.invoke('hermes:connections:set-primary', id),
    setLaunchMode: mode => ipcRenderer.invoke('hermes:connections:set-launch-mode', mode),
    setLastUsed: id => ipcRenderer.invoke('hermes:connections:set-last-used', id),
    test: id => ipcRenderer.invoke('hermes:connections:test', id),
    updateManaged: id => ipcRenderer.invoke('hermes:connections:update-managed', id),
    // Fan out `hermes update` to every eligible registered connection.
    // Optional excludeIds skips rows the caller updates through another path.
    updateAll: options => ipcRenderer.invoke('hermes:connections:update-all', options),
    // Registry lifecycle push (main → renderer): a connection was removed or
    // materially edited, so secondaries scoped to it must be disposed (and,
    // for edits, re-dialed at the new target).
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:connections:changed', listener)

      return () => ipcRenderer.removeListener('hermes:connections:changed', listener)
    }
  },
  sshConfigHosts: () => ipcRenderer.invoke('hermes:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('hermes:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-logout', remoteUrl),
  // Hermes Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('hermes:cloud:status'),
    login: () => ipcRenderer.invoke('hermes:cloud:login'),
    logout: () => ipcRenderer.invoke('hermes:cloud:logout'),
    discover: org => ipcRenderer.invoke('hermes:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('hermes:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    remember: name => ipcRenderer.invoke('hermes:profile:remember', name),
    set: name => ipcRenderer.invoke('hermes:profile:set', name)
  },
  api: <T>(request: HermesApiRequest) => ipcRenderer.invoke<T>('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readWindowBelow: () => ipcRenderer.invoke('hermes:window:readBelow'),
  readFileDataUrl: filePath => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileDataUrlForAttach: filePath => ipcRenderer.invoke('hermes:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('hermes:data-url-read-max:get'),
    set: maxMb => ipcRenderer.invoke('hermes:data-url-read-max:set', maxMb)
  },
  readFileText: filePath => ipcRenderer.invoke('hermes:readFileText', filePath),
  readPluginSource: (filePath: string) => ipcRenderer.invoke('hermes:readPluginSource', filePath),
  selectPaths: options => ipcRenderer.invoke('hermes:selectPaths', options),
  selectSavePath: options => ipcRenderer.invoke('hermes:selectSavePath', options),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('hermes:readClipboard'),
  saveGatewayFile: payload => ipcRenderer.invoke('hermes:saveGatewayFile', payload),
  saveImageFromUrl: url => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  contextMenuEdit: command => ipcRenderer.invoke('hermes:context-menu:edit', command),
  contextMenuCopyImage: () => ipcRenderer.invoke('hermes:context-menu:copy-image'),
  contextMenuSpellcheck: action => ipcRenderer.invoke('hermes:context-menu:spellcheck', action),
  contextMenuGuestAddWord: payload => ipcRenderer.invoke('hermes:context-menu:guest-add-word', payload),
  onContextMenuSpellcheck: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:context-menu-spellcheck', listener)

    return () => ipcRenderer.removeListener('hermes:context-menu-spellcheck', listener)
  },
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return (file as File & { path?: string }).path || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  watchDirectory: dir => ipcRenderer.invoke('hermes:watchDirectory', dir),
  stopPreviewFileWatch: id => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  setActiveWork: payload => ipcRenderer.send('hermes:active-work', payload),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('hermes:keep-awake', on),
  setDisableF12: blocked => ipcRenderer.send('hermes:devtools:disable-f12', blocked),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  mcpOauth: {
    // One-shot loopback listener for MCP OAuth against remote backends: bind
    // on this machine, hand redirectUri to mcp.servers.oauth.start, then wait
    // for the provider redirect and relay code/state via oauth.callback.
    listen: () => ipcRenderer.invoke('hermes:mcp-oauth:listen'),
    wait: (id, timeoutMs) => ipcRenderer.invoke('hermes:mcp-oauth:wait', id, timeoutMs),
    cancel: id => ipcRenderer.invoke('hermes:mcp-oauth:cancel', id)
  },
  openPreviewInBrowser: url => ipcRenderer.invoke('hermes:openPreviewInBrowser', url),
  reachPreviewUrl: url => ipcRenderer.invoke('hermes:preview:reach', url),
  setActiveConnectionRoute: route => ipcRenderer.send('hermes:connection:active-route', route),
  fetchLinkTitle: url => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  resolveFavicon: url => ipcRenderer.invoke('hermes:resolveFavicon', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    // Synchronous zoom factor (1 = 100%). Coordinate math needs it in the
    // same tick as the event it converts, so no IPC round-trip here.
    factor: () => (typeof visualViewport !== 'undefined' && visualViewport.scale > 0 ? visualViewport.scale : 1),
    setPercent: percent => ipcRenderer.send('hermes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('hermes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  // Fire-and-forget: persists a renderer error-boundary catch (with component
  // stack) to desktop.log so crashes survive the window (#79428).
  reportRendererError: report => ipcRenderer.send('hermes:logs:renderer-error', report),
  readDir: dirPath => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('hermes:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('hermes:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('hermes:fs:desktopPluginsRoot'),
  logsRoot: () => ipcRenderer.invoke('hermes:fs:logsRoot'),
  agentPluginsRoot: () => ipcRenderer.invoke('hermes:fs:agentPluginsRoot'),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('hermes:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('hermes:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('hermes:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('hermes:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('hermes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('hermes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('hermes:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('hermes:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('hermes:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('hermes:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('hermes:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('hermes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('hermes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('hermes:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('hermes:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('hermes:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('hermes:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('hermes:git:review:shipInfo', repoPath),
      prList: (repoPath, branches, numbers) =>
        ipcRenderer.invoke('hermes:git:review:prList', repoPath, branches, numbers),
      fetchPrComment: (repoPath, url) => ipcRenderer.invoke('hermes:git:review:fetchPrComment', repoPath, url),
      createPr: repoPath => ipcRenderer.invoke('hermes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('hermes:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onPreviewNav: callback => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('hermes:preview-nav', listener)

    return () => ipcRenderer.removeListener('hermes:preview-nav', listener)
  },
  onOpenFolderRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('hermes:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)

    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)

    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  probePluginRepo: payload => ipcRenderer.invoke('hermes:plugin:probe', payload),
  installDesktopPlugin: payload => ipcRenderer.invoke('hermes:plugin:installDesktop', payload),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)

    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)

    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onNotificationActivate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-activate', listener)

    return () => ipcRenderer.removeListener('hermes:notification-activate', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)

    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:connection:applied', listener)

    return () => ipcRenderer.removeListener('hermes:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)

    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  // AC ↔ battery transitions; renderers slow their backstop polls on battery.
  getOnBattery: () => ipcRenderer.invoke('hermes:power-battery:get'),
  onBatteryChanged: callback => {
    const listener = (_event, onBattery) => callback(Boolean(onBattery))
    ipcRenderer.on('hermes:power-battery', listener)

    return () => ipcRenderer.removeListener('hermes:power-battery', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)

    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('hermes:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: opts => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('hermes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)

      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  },
  // Find-in-page (Ctrl/Cmd+F): delegates to Electron's
  // webContents.findInPage on the IPC sender's window so a Cmd+F pressed
  // in a secondary session window searches THAT window, not the primary.
  // `onFoundInPage` returns the unsubscribe fn; the renderer wires it via
  // `initFindInPageListener` in store/find-in-page.ts and tears it down
  // when the FindBar unmounts.
  findInPage: (query, options) => ipcRenderer.invoke('hermes:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('hermes:stop-find-in-page'),
  onFoundInPage: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('hermes:found-in-page', listener)

    return () => ipcRenderer.removeListener('hermes:found-in-page', listener)
  },
  // Main-process `before-input-event` forwards Ctrl/Cmd+F here so renderer
  // can open the FindBar even when the GTK compositor has already grabbed
  // the chord at the windowing layer (#81727).
  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('hermes:open-find-bar', listener)
  }
}

// When bundled as a browser script, expose both the compatibility transport and
// the unchanged Desktop API expected by the renderer.
if (typeof window !== 'undefined' && !(window as Window & { hermesDesktop?: unknown }).hermesDesktop) {
  Object.assign(window, { ipcRenderer, hermesDesktop })
}
