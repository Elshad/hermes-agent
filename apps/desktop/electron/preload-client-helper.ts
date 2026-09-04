/**
 * Browser-side login helper for Desktop-Web.
 *
 * The remote gateway URL stays on the server.  The browser only opens the
 * public Desktop-Web origin and carries the same connection scope that the
 * WebSocket relay uses.  The server is responsible for proxying the request
 * to the selected gateway and for storing its HttpOnly session cookie.
 */

export const proxyPrefixes = [
  '/api/',
  '/api',
  '/auth/',
  '/auth',
  '/login',
  '/logout',
  '/oauth/',
  '/oauth'
] as const

export interface BrowserGatewayScope {
  connectionId?: null | string
  profile?: null | string
}

export interface BrowserOauthLoginResult {
  ok: boolean
  baseUrl: string
  connected: boolean
}

interface BrowserLocation {
  origin: string
  search?: string
}

interface WebClientWindow extends Window {
  __HERMES_WEB_API_BASE__?: string
}

interface LoginWindow {
  readonly closed: boolean
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type OpenLoginWindow = (url: string, target: string, features: string) => LoginWindow | null

export interface BrowserOauthLoginOptions {
  fetch?: FetchLike
  location?: BrowserLocation
  openWindow?: OpenLoginWindow
  pollIntervalMs?: number
  timeoutMs?: number
  scope?: BrowserGatewayScope
}

const LOGIN_PATH = '/login'
const AUTH_STATUS_PATH = '/api/auth/me'
const DEFAULT_POLL_INTERVAL_MS = 750
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const LOGIN_WINDOW_FEATURES = 'popup,width=520,height=720,resizable=yes,scrollbars=yes'

function nonEmpty(value: unknown): undefined | string {
  const normalized = typeof value === 'string' ? value.trim() : ''

  return normalized || undefined
}

function browserLocation(): BrowserLocation {
  if (typeof location === 'undefined' || !location.origin || location.origin === 'null') {
    throw new Error('Desktop-Web login requires a browser origin.')
  }

  return location
}

function loginScope(options: BrowserOauthLoginOptions, currentLocation: BrowserLocation): BrowserGatewayScope {
  const query = new URLSearchParams(currentLocation.search || '')
  const scope = options.scope || {}

  return {
    connectionId: nonEmpty(scope.connectionId) || nonEmpty(query.get('connectionId')),
    profile: nonEmpty(scope.profile) || nonEmpty(query.get('profile'))
  }
}

function publicOrigin(currentLocation: BrowserLocation): string {
  const configured = (globalThis as unknown as WebClientWindow).__HERMES_WEB_API_BASE__

  return configured?.replace(/\/$/, '') || currentLocation.origin
}

function isProxyPath(pathname: string): boolean {
  return proxyPrefixes.some(prefix => {
    if (prefix.endsWith('/')) {
      return pathname.startsWith(prefix)
    }

    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}

/** Build a same-origin URL for one of the server's remote-gateway proxy paths. */
export function buildGatewayProxyUrl(
  path: string,
  scope: BrowserGatewayScope = {},
  currentLocation: BrowserLocation = browserLocation()
): string {
  if (!path.startsWith('/')) {
    throw new Error('Gateway proxy paths must be absolute.')
  }

  const origin = publicOrigin(currentLocation)
  const url = new URL(path, origin)

  if (url.origin !== new URL(origin).origin || !isProxyPath(url.pathname)) {
    throw new Error(`Path is not available through the gateway proxy: ${url.pathname}`)
  }

  const connectionId = nonEmpty(scope.connectionId)
  const profile = nonEmpty(scope.profile)

  if (connectionId) {
    url.searchParams.set('connectionId', connectionId)
  }

  if (profile) {
    url.searchParams.set('profile', profile)
  }

  return url.toString()
}

function defaultOpenLoginWindow(url: string, target: string, features: string): LoginWindow | null {
  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    return null
  }

  return window.open(url, target, features)
}

function popupClosed(popup: LoginWindow): boolean {
  try {
    return popup.closed
  } catch {
    // A browser may temporarily reject access to a popup while it navigates.
    // Treat that as still open; completion is decided by the authenticated
    // status request below.
    return false
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function isGatewayLoginComplete(
  url: string,
  popup: LoginWindow,
  fetcher: FetchLike
): Promise<boolean> {
  if (popupClosed(popup)) {
    throw new Error('Login window closed before authentication completed.')
  }

  try {
    const response = await fetcher(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      method: 'GET'
    })

    if (response.ok) {
      return true
    }

    // 401/403 are the expected pre-login responses.  Other responses are
    // transient during an upstream redirect and are retried until the bound.
    return false
  } catch {
    // The popup can be in the middle of a cross-origin redirect while the
    // proxy is establishing its session.  Keep polling until the bound.
    return false
  }
}

/**
 * Open the remote gateway login page through Desktop-Web's public origin.
 *
 * `remoteUrl` is retained only for the renderer-facing API contract and the
 * result DTO.  It is deliberately never placed in the popup URL: connection
 * selection is made by the server from connectionId/profile scope.
 */
export async function oauthLoginConnectionConfig(
  remoteUrl: string,
  options: BrowserOauthLoginOptions = {}
): Promise<BrowserOauthLoginResult> {
  const baseUrl = remoteUrl.trim()

  if (!baseUrl) {
    throw new Error('Remote gateway URL is required.')
  }

  const currentLocation = options.location || browserLocation()
  const scope = loginScope(options, currentLocation)
  const loginUrl = buildGatewayProxyUrl(LOGIN_PATH, scope, currentLocation)
  const statusUrl = buildGatewayProxyUrl(AUTH_STATUS_PATH, scope, currentLocation)
  const openWindow = options.openWindow || defaultOpenLoginWindow
  const fetcher = options.fetch || fetch
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const timeoutMs = Math.max(pollIntervalMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const popup = openWindow(loginUrl, '_blank', LOGIN_WINDOW_FEATURES)

  if (!popup) {
    throw new Error('Unable to open the gateway login window. Please allow popups and try again.')
  }

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await isGatewayLoginComplete(statusUrl, popup, fetcher)) {
      return { baseUrl, connected: true, ok: true }
    }

    if (popupClosed(popup)) {
      throw new Error('Login window closed before authentication completed.')
    }

    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }

  return { baseUrl, connected: false, ok: false }
}
