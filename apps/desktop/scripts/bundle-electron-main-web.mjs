#!/usr/bin/env node
// bundle-electron-main-web.mjs — bundles the Desktop-Web Electron entrypoints
// into self-contained js files in dist/ so the packaged app doesn't need
// node_modules/ or tsx at runtime.
//
// Output:
//   dist/electron-main-web.mjs            (MJS bundle — app entry point)
//   dist/electron-preload.js              (CJS bundle — native BrowserWindow preload)
//   dist/electron-preload-web.js          (ESM bundle — child HTTP/WebSocket server)
//   dist/electron-preload-api-client.js   (IIFE bundle — browser-side Web API client)
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
const nativePreloadEntry = resolve(root, 'electron/preload.ts')
const nativePreloadOut = resolve(distDir, 'electron-preload.js')
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

// Bundle preload.ts → dist/electron-preload.js. main-web.ts loads this native
// contextBridge preload for every Electron BrowserWindow; it is distinct from
// the browser-side API client below.
await build({
  entryPoints: [nativePreloadEntry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: nativePreloadOut,
  external,
  define,
  logLevel: 'info'
})
console.log(`bundled ${nativePreloadOut}${isDev ? ' (dev)' : ''}`)

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

// Bundle preload-api-client.ts → dist/electron-preload-api-client.js. This is
// loaded by the browser-facing HTML, so it must be a standalone browser script
// rather than the CommonJS format used by Electron's native preload.
await build({
  entryPoints: [apiClientEntry],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: apiClientOut,
  external,
  define,
  logLevel: 'info'
})
console.log(`bundled ${apiClientOut}${isDev ? ' (dev)' : ''}`)
