# Hermes Browser Host — Phase 2A Skeleton

This is a **minimal Electron app skeleton** for the Hermes Browser Workspace
embedded browser host. Phase 2A proves that an independent Electron child
process can start, open a window, and expose a localhost health endpoint.

**It does NOT include:**
- Embedded browser surface (WebContentsView) — that is Phase 2B
- Snapshot / screenshot / DOM / clipboard extraction — that is Phase 2C
- Agent actions (click, type, submit, navigate) — those are future
- Dashboard start/stop controls — those are Phase 2B

## Quick start

```bash
cd browser-host
npm install
npm run typecheck
npm run build
npm run dev
```

## Verify health endpoint

```bash
# Read the port from the state file
cat ~/.hermes/browser-host/state.json

# Or curl directly (port 8765 or as shown in state.json)
curl http://127.0.0.1:8765/health
```

Expected response:

```json
{
  "ok": true,
  "service": "hermes-browser-host",
  "phase": "2A",
  "pid": 12345,
  "port": 8765,
  "startedAt": "2026-06-06T...",
  "features": {
    "embeddedBrowser": false,
    "snapshot": false,
    "screenshot": false,
    "agentActions": false
  }
}
```

## Stop

Press `Ctrl+C` in the terminal, or kill the process:

```bash
kill $(cat ~/.hermes/browser-host/state.json | python3 -c 'import sys,json; print(json.load(sys.stdin)["pid"])')
```

## State file

`~/.hermes/browser-host/state.json` is written on startup and cleaned up
on normal exit (SIGTERM, SIGINT, app quit). If the process crashes or is
force-killed (SIGKILL), the state file may remain stale.

## Security

- HTTP server binds `127.0.0.1` only — not accessible from other machines
- Only `GET /health` is exposed — no write/action endpoints
- No click/type/submit/navigate API
- No user-provided JavaScript execution

## Directory

```
browser-host/
  package.json
  tsconfig.json
  src/
    main.ts          ← Electron main process + health server
    renderer.html    ← Simple status window
  .gitignore
  README.md
```
