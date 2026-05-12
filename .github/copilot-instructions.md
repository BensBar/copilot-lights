# copilot-lights — Copilot instructions

Ambient smart-light status for the GitHub Copilot CLI. A long-running daemon
aggregates Copilot CLI hook events over a Unix socket and drives lights via
pluggable adapters (Home Assistant, Hue, Mock).

## Commands

```bash
npm ci
npm run build         # tsc -p tsconfig.json → dist/
npm run dev           # tsc --watch
npm run lint          # eslint src/**/*.ts test/**/*.ts
npm run format        # prettier --write
npm test              # vitest run

# single test file / name filter
npx vitest run test/unit/state.test.ts
npx vitest run -t "aggregator"
```

Node `>=20`, ESM (`"type": "module"`). The published CLI is `dist/cli.js`
exposed as the `copilot-lights` bin.

The macOS menu bar app under `macos/` is a separate SwiftPM build:
`bash macos/Scripts/package_app.sh release` (reads `macos/version.env`).

## Architecture

Three processes / boundaries that must stay decoupled:

1. **Hook binary** (`src/bridge/hook-bin.ts` → `src/bridge/hook.ts` →
   `src/bridge/client.ts`). Invoked by Copilot CLI on every hook event. Has a
   **hard 200 ms socket budget and always exits 0** so the CLI is never
   blocked or failed by us. Sends one newline-delimited JSON message per
   connection.
2. **Daemon** (`src/daemon/`). `server.ts` is the Unix-socket JSON-line
   server; `state.ts` is a multi-session counter aggregator + state resolver
   (`ready`/`thinking`/`awaiting_input`/`error`/`done`/`off`); `scheduler.ts`
   runs a 10 fps frame loop applying `steady`/`breathe`/`pulse`/`flash`
   effects and pushes frames to the active adapter.
3. **Adapters** (`src/adapters/`) all implement one `LightAdapter` interface.
   New surfaces (Hue, HA, Mock, future) plug in here — do not leak adapter
   specifics into the daemon or scheduler.

`src/cli.ts` uses commander and is a thin shell over testable `cmd*`
functions — keep new subcommands following that split so they can be unit
tested without spawning a process.

### Wire format (Unix socket, also HTTP `POST /event` if `http.port` set)

Newline-delimited JSON, **one message per connection**:

- Event:  `{kind:"event", event, sessionId, ts, toolName?, notificationType?}`
- Query:  `{kind:"query", query:"status"}`
- Reload: `{kind:"reload"}` (sent by the macOS settings UI after writing config)

**Never** put prompt text, tool arguments, or notification bodies on the
wire. Only the minimal fields above. This is a privacy contract.

## Conventions

- **Config**: zod schema + loader in `src/config/`. Tokens in
  `~/.copilot-lights/config.json` may be inline strings, `env:VARNAME`, or
  `keychain:NAME` (macOS); resolution happens in the loader, not at call
  sites.
- **Hook installer** writes the **absolute path of the currently-running
  binary** into `~/.copilot/hooks.json`. Re-running `copilot-lights install`
  is the supported way to fix up paths after `npm link` / relocation. Keep
  `install`/`uninstall` idempotent.
- **Autostart** generators (`src/autostart/`) emit launchd plist / systemd
  user unit files directly — **do not shell out** to `launchctl` /
  `systemctl` from generator code; that's the caller's job.
- **Color math** lives in `src/util/color.ts` (hex/HSV/CIE-xy + lerp +
  brightness scaling). Adapters consume normalized color, not hex strings.
- **No new build/lint/test tooling** without a reason — stick to tsc +
  eslint + prettier + vitest.
- Tests live in `test/unit/` mirroring `src/` layout; fixtures in
  `test/fixtures/`. Socket tests use `.test-sockets/`.
