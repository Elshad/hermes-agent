#!/usr/bin/env node
// bundle-electron-main-web.mjs — bundles electron/main-web.ts and electron/preload-web.ts
// into self-contained js files in dist/ so the packaged app doesn't need
// node_modules/ or tsx at runtime.
//
// Output:
//   dist/electron-main-web.mjs            (MJS bundle — app entry point)
//   dist/electron-preload-web.js          (ESM bundle — child HTTP/WebSocket server)
//   dist/electron-preload-api-client.js   (CJS bundle — BrowserWindow preload)
//
// `electron` and `node-pty` are external (provided by the runtime / staged
// separately via stage-native-deps).
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const distDir = resolve(root, 'dist')
mkdirSync(distDir, { recursive: true })

const mainEntry = resolve(root, 'electron/main-web.ts')
const mainOut = resolve(distDir, 'electron-main-web.mjs')
const preloadEntry = resolve(root, 'electron/preload-web.ts')
const preloadOut = resolve(distDir, 'electron-preload-web.js')
const apiClientEntry = resolve(root, 'electron/preload-api-client.ts')
const apiClientOut = resolve(distDir, 'electron-preload-api-client.js')

const external = ['electron', 'node-pty', 'get-windows', 'fs']
// Production bundles bake packaged=true so unpackaged `electron .` still
// behaves like a packaged build. Dev bundles (`--dev`) leave the env alone
// so HERMES_DESKTOP_DEV_SERVER / source-tree resolution keep working.
const isDev = process.argv.includes('--dev')
const define = isDev
  ? {}
  : { 'process.env.HERMES_DESKTOP_IS_PACKAGED': JSON.stringify(true) }

// Bundle main.ts → dist/electron-main.mjs
await build({
  entryPoints: [mainEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: mainOut,
  external,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  define,
  logLevel: 'info',
})
console.log(`bundled ${mainOut}${isDev ? ' (dev)' : ''}`)

// Bundle preload-web.ts → dist/electron-preload-web.js
await build({
  entryPoints: [preloadEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: preloadOut,
  external,
  define,
  logLevel: 'info',
})
console.log(`bundled ${preloadOut}${isDev ? ' (dev)' : ''}`)

// Bundle preload-api-client.ts → dist/electron-preload-api-client.js
await build({
  entryPoints: [apiClientEntry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: apiClientOut,
  external,
  define,
  logLevel: 'info'
})
console.log(`bundled ${apiClientOut}${isDev ? ' (dev)' : ''}`)
