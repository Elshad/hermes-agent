# Hermes Desktop Web

Browser host for the complete Hermes Desktop renderer.

The UI is imported directly from `../src`; it is not copied into this folder and
it is not modified for the web host. `src/main.ts` installs the browser
`window.hermesDesktop` adapter before dynamically importing `@desktop/main`.

## Run through Hermes

From the repository root:

```bash
hermes desktop-web
```

Defaults:

```text
host: 127.0.0.1
port: 13043
```

Dashboard-style lifecycle options:

```bash
hermes desktop-web --help
hermes desktop-web --status
hermes desktop-web --stop
hermes desktop-web --no-open
hermes desktop-web --skip-build
hermes desktop-web --host 127.0.0.1 --port 13043
```

`desktop-web` builds this package with the existing Desktop workspace toolchain,
then reuses the existing Hermes Dashboard server lifecycle with
`HERMES_WEB_DIST` pointing at this package's `dist`. It does not launch
Electron and does not start a separate agent implementation in the browser.
The Dashboard server remains authoritative for authentication, profiles,
sessions, Gateway WebSocket traffic, filesystem routes, Git routes, and agent
execution.

## Development commands

```bash
npm install --workspace apps/desktop/web
npm run typecheck --workspace apps/desktop/web
npm test --workspace apps/desktop/web
npm run build --workspace apps/desktop/web
```

The typecheck project is `../tsconfig.web.json`. It includes the imported Desktop
renderer graph but excludes Electron sources. TypeScript's `noCheck` mode is
intentional here because the current upstream renderer graph has declaration and
union diagnostics unrelated to the web adapter; Vite remains the actual full
module/syntax/build check.

## Browser bridge

`src/preload.ts` implements the renderer's `window.hermesDesktop` contract.
Backend-owned operations use the existing Dashboard API and Gateway contracts:

- HTTP requests use same-origin `fetch` with cookies;
- OAuth WebSocket connections mint fresh `/api/auth/ws-ticket` tickets;
- filesystem methods use `/api/fs/*`;
- Git/review methods use `/api/git/*` with Electron-compatible response shapes;
- clipboard, notifications, microphone, file selection, downloads, and external
  links use browser APIs where safe.

Electron-only operations such as native PTY terminals, HUD/pet windows, native
file-manager dialogs, updater, bootstrap, and OS-level window inspection reject
with a controlled capability error. They must not be replaced with arbitrary
command execution or fake absolute browser filesystem paths.

## Build configuration

`vite.config.ts` reuses the Desktop React Compiler, Tailwind, Vite, dependency
aliases, public assets, fonts, emoji data, and driver.js handling. The aliases
resolve `@desktop` and `@` to the live `apps/desktop/src` tree. Do not add a
second UI implementation or edit the authoritative Desktop renderer to solve a
web-host issue.

## Security

- default listener is loopback-only;
- Dashboard authentication remains in force;
- WebSocket upgrades go through the Dashboard server;
- browser credentials are not placed in source or localStorage;
- unsafe custom connection headers are filtered;
- explicit unknown connection IDs fail closed;
- filesystem/Git validation remains server-side;
- no unauthenticated arbitrary command endpoint is provided.

See `plan001.md` for the complete parity matrix, implementation plan, browser
limitations, verification commands, and upstream-update procedure.
