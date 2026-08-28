import { describe, expect, it } from 'vitest'

import { connection, isLocalConnection, parseApiResponse } from './preload'

describe('Desktop Web preload transport', () => {
  it('keeps the owned local connection on native token auth', () => {
    expect(isLocalConnection()).toBe(true)
    expect(isLocalConnection('local')).toBe(true)
    expect(isLocalConnection('remote-1')).toBe(false)
    expect(connection('default', 'local')).toMatchObject({ authMode: 'token', mode: 'local', token: '' })
    expect(connection('default', 'remote-1')).toMatchObject({ authMode: 'oauth', mode: 'remote' })
  })

  it('parses JSON success responses', async () => {
    const result = await parseApiResponse<{ ok: boolean }>(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    expect(result).toEqual({ ok: true })
  })

  it('does not expose HTML proxy pages as parser noise', async () => {
    await expect(
      parseApiResponse(new Response('<html>login</html>', { status: 401, headers: { 'content-type': 'text/html' } }))
    ).rejects.toMatchObject({ statusCode: 401, message: '401' })
  })

  it('rejects non-JSON successful API responses', async () => {
    await expect(
      parseApiResponse(new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }))
    ).rejects.toThrow('Expected a JSON response')
  })
})
