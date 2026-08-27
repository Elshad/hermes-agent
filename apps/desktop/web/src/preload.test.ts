import { describe, expect, it } from 'vitest'

import { parseApiResponse } from './preload'

describe('Desktop Web preload transport', () => {
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
