import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const REGISTRY_VERSION = 2 as const
export type ConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'
export type LaunchMode = 'last-used' | 'primary'

export interface RegistryConnection {
  id: string
  kind: ConnectionKind
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  /** Opaque Desktop safeStorage envelope. Never returned to the browser. */
  token?: unknown
  /** Opaque encrypted header values. Never returned to the browser. */
  headers?: Record<string, unknown>
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
}

export interface ConnectionRegistry {
  version: typeof REGISTRY_VERSION
  primary: string
  launchMode: LaunchMode
  lastUsed: string
  connections: RegistryConnection[]
}

export interface SafeRegistryConnection extends Omit<RegistryConnection, 'headers' | 'token'> {
  tokenSet: boolean
  tokenPreview: null
}

export interface SafeConnectionRegistry {
  version: typeof REGISTRY_VERSION
  primary: string
  launchMode: LaunchMode
  lastUsed: string
  secureTokenStorage: boolean
  connections: SafeRegistryConnection[]
}

export interface RegistryInput {
  id?: string
  kind: ConnectionKind
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  token?: string
  headers?: Record<string, string | null>
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
}

const LABEL_MAX = 64
const URL_KINDS = new Set<ConnectionKind>(['cloud', 'remote'])

// Browser-entered credentials are held only for the running server process.
// Desktop safeStorage envelopes remain opaque and are never copied into a web
// response. A future OS-keyring adapter can replace this map without changing
// the registry or proxy contracts.
const runtimeSecrets = new Map<string, { headers: Record<string, string>; token?: string }>()

function configDir() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/** The same Linux Electron userData default used by the Desktop app. */
export function desktopUserDataDir() {
  return process.env.HERMES_DESKTOP_USER_DATA || join(configDir(), 'Hermes')
}

export function registryPath() {
  return join(desktopUserDataDir(), 'connections.json')
}

function labelKey(label: string) {
  return label.trim().toLowerCase()
}

const REMOTE_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_REMOTE_HEADER_NAMES = new Set([
  'authorization', 'connection', 'content-length', 'content-type', 'cookie',
  'host', 'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'x-hermes-session-token'
])

/** Adapted from upstream electron/connection-config.ts: user headers must not
 * be able to rewrite proxy framing, origin, cookies, or Hermes auth. */
export function normalizeRemoteHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  for (const [name, rawValue] of Object.entries(raw)) {
    const headerName = String(name || '').trim()
    const lower = headerName.toLowerCase()
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!headerName || !value || !REMOTE_HEADER_NAME_RE.test(headerName) || FORBIDDEN_REMOTE_HEADER_NAMES.has(lower)) continue
    result[headerName] = value
  }
  return result
}

function emptyRegistry(): ConnectionRegistry {
  return {
    version: REGISTRY_VERSION,
    primary: '',
    launchMode: 'primary',
    lastUsed: '',
    connections: []
  }
}

function validUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeConnection(value: unknown): RegistryConnection | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const kind = row.kind
  if (kind !== 'local' && kind !== 'remote' && kind !== 'cloud' && kind !== 'ssh') return null
  // The Web build must never operate Hermes Desktop's managed localhost
  // gateway. Ignore legacy local rows rather than reviving them on read.
  if (kind === 'local') return null
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : randomUUID()
  const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, LABEL_MAX) : id
  const result: RegistryConnection = { id, kind, label }
  if (kind === 'remote' || kind === 'cloud') {
    if (!validUrl(row.url)) return null
    result.url = String(row.url).trim()
  }
  for (const key of ['org', 'host', 'user', 'keyPath', 'remoteHermesPath', 'remoteProfile'] as const) {
    if (typeof row[key] === 'string' && row[key].trim()) result[key] = row[key].trim()
  }
  if (typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0 && row.port <= 65535) result.port = row.port
  if (row.authMode === 'oauth' || row.authMode === 'token') result.authMode = row.authMode
  if (row.token !== undefined) result.token = row.token
  if (row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)) result.headers = row.headers as Record<string, unknown>
  return result
}

export function normalizeRegistry(value: unknown): ConnectionRegistry {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const raw = Array.isArray(source.connections) ? source.connections : []
  const connections: RegistryConnection[] = []
  const ids = new Set<string>()
  const labels = new Set<string>()

  for (let i = 0; i < raw.length; i += 1) {
    const row = normalizeConnection(raw[i])
    if (!row || ids.has(row.id) || labels.has(labelKey(row.label))) continue
    ids.add(row.id)
    labels.add(labelKey(row.label))
    connections.push(row)
  }

  const has = (id: unknown) => typeof id === 'string' && connections.some(connection => connection.id === id)
  const primary = has(source.primary) ? source.primary as string : connections[0]?.id || ''
  const lastUsed = has(source.lastUsed) ? source.lastUsed as string : primary
  const launchMode = source.launchMode === 'last-used' ? 'last-used' : 'primary'
  return { version: REGISTRY_VERSION, primary, launchMode, lastUsed, connections }
}

function readRawRegistry() {
  try {
    if (!existsSync(registryPath())) return null
    return JSON.parse(readFileSync(registryPath(), 'utf8'))
  } catch {
    return null
  }
}

export function readRegistry() {
  return normalizeRegistry(readRawRegistry() || emptyRegistry())
}

export function safeRegistry(registry = readRegistry()): SafeConnectionRegistry {
  return {
    version: REGISTRY_VERSION,
    primary: registry.primary,
    launchMode: registry.launchMode,
    lastUsed: registry.lastUsed,
    secureTokenStorage: true,
    connections: registry.connections.map(({ token, headers, ...connection }) => ({
      ...connection,
      tokenSet: token !== undefined || runtimeSecrets.has(connection.id),
      tokenPreview: null
    }))
  }
}

function writeRegistry(registry: ConnectionRegistry) {
  const path = registryPath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function normalizedInput(input: RegistryInput) {
  const label = input.label.trim().slice(0, LABEL_MAX)
  if (!label) throw new Error('Connection label is required.')
  if (input.kind === 'local') throw new Error('Local gateway connections are unavailable in Hermes Web.')
  if (URL_KINDS.has(input.kind) && !validUrl(input.url)) throw new Error('A valid http(s) gateway URL is required.')
  if (input.kind === 'ssh' && !input.host?.trim()) throw new Error('SSH host is required.')
  return { ...input, label, url: input.url?.trim(), host: input.host?.trim() }
}

/** Save connection metadata in the Desktop-compatible file without exposing secrets. */
export function saveConnection(input: RegistryInput) {
  const current = readRegistry()
  const next = normalizedInput(input)
  const existing = next.id ? current.connections.find(connection => connection.id === next.id) : undefined
  const duplicate = current.connections.find(connection => connection.id !== next.id && labelKey(connection.label) === labelKey(next.label))
  if (duplicate) throw new Error(`Connection label must be unique; already used by ${duplicate.label}.`)

  const connection: RegistryConnection = {
    ...(existing || {}),
    id: next.id || `${next.kind}-${randomUUID()}`,
    kind: next.kind,
    label: next.label
  }
  for (const key of ['url', 'org', 'host', 'user', 'keyPath', 'remoteHermesPath', 'remoteProfile'] as const) {
    if (next[key]) connection[key] = next[key]
    else delete connection[key]
  }
  if (typeof next.port === 'number' && Number.isInteger(next.port) && next.port > 0 && next.port <= 65535) connection.port = next.port
  else delete connection.port
  if (next.authMode) connection.authMode = next.authMode
  if (next.token?.trim()) {
    const prior = runtimeSecrets.get(connection.id)
    runtimeSecrets.set(connection.id, { token: next.token.trim(), headers: prior?.headers || {} })
  }
  if (next.headers) {
    const prior = runtimeSecrets.get(connection.id)
    const headers = normalizeRemoteHeaders(next.headers)
    runtimeSecrets.set(connection.id, { token: prior?.token, headers })
  }
  const connections = existing ? current.connections.map(row => row.id === connection.id ? connection : row) : [...current.connections, connection]
  const registry = normalizeRegistry({ ...current, connections })
  writeRegistry(registry)
  return { connection, registry }
}

export function removeConnection(id: string) {
  const current = readRegistry()
  if (!current.connections.some(connection => connection.id === id)) throw new Error('Connection not found.')
  runtimeSecrets.delete(id)
  const registry = normalizeRegistry({
    ...current,
    connections: current.connections.filter(connection => connection.id !== id),
    primary: current.primary === id ? '' : current.primary,
    lastUsed: current.lastUsed === id ? '' : current.lastUsed
  })
  writeRegistry(registry)
  return registry
}

export function setPrimary(id: string) {
  const current = readRegistry()
  if (!current.connections.some(connection => connection.id === id)) throw new Error('Connection not found.')
  const registry = { ...current, primary: id }
  writeRegistry(registry)
  return registry
}

export function setLaunchMode(mode: LaunchMode) {
  const registry = { ...readRegistry(), launchMode: mode }
  writeRegistry(registry)
  return registry
}

export function setLastUsed(id: string) {
  const current = readRegistry()
  if (!current.connections.some(connection => connection.id === id)) throw new Error('Connection not found.')
  const registry = { ...current, lastUsed: id }
  writeRegistry(registry)
  return registry
}

export function connectionFor(id?: string | null) {
  const registry = readRegistry()
  const requested = id?.trim()
  const selected = requested || (registry.launchMode === 'last-used' ? registry.lastUsed : registry.primary)
  const connection = registry.connections.find(row => row.id === selected)
  if (requested && !connection) throw new Error('Connection not found.')
  if (!connection) throw new Error('No Hermes gateway connection configured. Add a connection first.')
  return connection
}

/** Resolve a profile-scoped settings entry when one has been registered. */
export function connectionForProfile(profile?: string | null) {
  const key = profile?.trim()
  if (!key) return connectionFor()
  const registry = readRegistry()
  return registry.connections.find(connection => connection.remoteProfile === key) || connectionFor()
}

export function connectionTarget(connection: RegistryConnection) {
  if (connection.kind === 'remote' || connection.kind === 'cloud') return connection.url as string
  throw new Error('SSH connections require an SSH forwarding process and cannot be proxied yet.')
}

export function connectionConfig(connection?: RegistryConnection, profile?: string | null) {
  return {
    envOverride: Boolean(process.env.HERMES_DESKTOP_REMOTE_URL || process.env.HERMES_DESKTOP_REMOTE_TOKEN),
    connectionId: connection?.id || null,
    mode: connection?.kind === 'cloud' || connection?.kind === 'ssh' ? connection.kind : 'remote',
    profile: profile?.trim() || connection?.remoteProfile || null,
    remoteAuthMode: connection?.authMode || 'oauth',
    remoteOauthConnected: false,
    remoteTokenPreview: null,
    remoteTokenSet: connection ? connection.token !== undefined || runtimeSecrets.has(connection.id) : false,
    secureTokenStorage: true,
    remoteTokenPlainText: false,
    remoteUrl: connection?.url || '',
    cloudOrg: connection?.org || '',
    sshHost: connection?.host || '',
    sshUser: connection?.user || '',
    sshPort: connection?.port || null,
    sshKeyPath: connection?.keyPath || '',
    sshRemoteHermesPath: connection?.remoteHermesPath || '',
    sshRemoteProfile: connection?.remoteProfile || ''
  }
}

export function connectionSecret(id: string) {
  return runtimeSecrets.get(id)
}
