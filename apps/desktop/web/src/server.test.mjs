import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer, request as nodeRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverPath = join(process.cwd(), 'server.mjs')
const desktopPort = 0
const backendToken = 'native-backend-token-for-test'
const configSalt = randomBytes(16)
const configDigest = scryptSync('config-password', configSalt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
const configPasswordHash = ['scrypt', 2 ** 14, 8, 1, configSalt.toString('base64'), configDigest.toString('base64')].join('$')
let backend
let desktop
let desktopActualPort
let hermesHome
let backendRequests = []

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = ''
    const onData = chunk => {
      output += chunk.toString()
      if (pattern.test(output)) {
        child.stdout.off('data', onData)
        resolve(output)
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', code => reject(new Error(`Desktop Web exited before readiness (${code}): ${output}`)))
  })
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeRequest({
      hostname: '127.0.0.1',
      port: desktopActualPort,
      path,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode,
        headers: response.headers
      })))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('Desktop Web host authentication and backend isolation', () => {
  beforeAll(async () => {
    hermesHome = await mkdtemp(join(tmpdir(), 'hermes-desktop-web-test-'))
    await writeFile(join(hermesHome, 'config.yaml'), `desktop_web:\n  public_url: https://desktop.example.test\n  basic_auth:\n    username: admin\n    password_hash: ${configPasswordHash}\n    secret: test-signing-secret-with-enough-length\n    session_ttl_seconds: 3600\n`)

    backend = createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        backendRequests.push({
          path: req.url,
          token: req.headers['x-hermes-session-token'] || '',
          cookie: req.headers.cookie || ''
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
    })
    backend.listen(0, '127.0.0.1')
    await once(backend, 'listening')
    const backendPort = backend.address().port

    desktop = spawn(process.execPath, [
      serverPath,
      '--desktop-web',
      '--host', '127.0.0.1',
      '--port', String(desktopPort),
      '--backend-url', `http://127.0.0.1:${backendPort}`
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        HERMES_DESKTOP_WEB_BACKEND_TOKEN: backendToken,
        HERMES_DESKTOP_WEB_BASIC_AUTH_USERNAME: '',
        HERMES_DESKTOP_WEB_BASIC_AUTH_PASSWORD: '',
        HERMES_DESKTOP_WEB_BASIC_AUTH_PASSWORD_HASH: '',
        HERMES_DESKTOP_WEB_BASIC_AUTH_SECRET: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    desktop.stderr.on('data', () => {})
    const readyOutput = await waitForLine(desktop, /HERMES_DESKTOP_WEB_READY port=(\d+)/)
    desktopActualPort = Number(readyOutput.match(/HERMES_DESKTOP_WEB_READY port=(\d+)/)[1])
  })

  afterAll(async () => {
    desktop?.kill('SIGTERM')
    await once(desktop, 'exit').catch(() => {})
    backend?.close()
    await rm(hermesHome, { recursive: true, force: true })
  })

  it('bypasses the host gate for loopback access', async () => {
    const response = await request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ service: 'hermes-desktop-web' })
  })

  it('requires login for the configured public authority', async () => {
    const response = await request('/', { headers: { Host: 'desktop.example.test' } })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/^\/login\?next=/)

    const api = await request('/api/status', { headers: { Host: 'desktop.example.test' } })
    expect(api.status).toBe(401)
  })

  it('accepts the configured credentials and protects the session cookie', async () => {
    const login = await request('/api/desktop-web-auth/login', {
      method: 'POST',
      headers: {
        Host: 'desktop.example.test',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'username=admin&password=config-password&next=%2F'
    })
    expect(login.status).toBe(302)
    const cookie = login.headers.get('set-cookie')
    expect(cookie).toMatch(/^hermes_desktop_web_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/)

    const response = await request('/api/status?profile=test', {
      headers: { Host: 'desktop.example.test', Cookie: cookie.split(';', 1)[0] }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })

    const forwarded = backendRequests.at(-1)
    expect(forwarded.token).toBe(backendToken)
    expect(forwarded.cookie).toBe('')
  })

  it('rejects invalid credentials and forged session cookies', async () => {
    const wrong = await request('/api/desktop-web-auth/login', {
      method: 'POST',
      headers: { Host: 'desktop.example.test', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=wrong'
    })
    expect(wrong.status).toBe(401)

    const forged = await request('/api/status', {
      headers: { Host: 'desktop.example.test', Cookie: 'hermes_desktop_web_session=forged' }
    })
    expect(forged.status).toBe(401)
  })
})
