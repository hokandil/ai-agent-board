# Development & Product Preview

This guide covers running AI Agent Board locally, how to confirm it is ready, and
how to recover when a previous dev run did not shut down cleanly. It is written
for **Windows PowerShell**, with macOS/Linux equivalents where they differ.

## Prerequisites

- **Node.js 22+** and **npm 10+** (`node --version`).
- `npm install` at the repo root (npm workspaces installs client, server, e2e, shared).
- At least one agent CLI is only needed to *run agents*. You can preview the whole
  UI without any agent CLI (see **Product preview** below).

> Native modules: the server uses `better-sqlite3` (SQLite) and the root uses
> `node-pty`. These are native addons compiled for your Node version. If you
> switch Node versions and see `NODE_MODULE_VERSION … was compiled against a
> different Node.js version`, run `npm rebuild better-sqlite3 node-pty` (see
> Troubleshooting).

## Start the app (one command)

```powershell
npm run dev
```

This builds `shared`, then starts **both** processes with `concurrently`:

| Component | Port | What you should see |
|-----------|------|---------------------|
| API server (Express + WS) | `8080` | `[startup] phase=…` lines, then `[server] listening on http://127.0.0.1:8080` |
| Client (Vite + React) | `8081` | `VITE … ready` and `Local: http://127.0.0.1:8081/` |

Open **http://localhost:8081**.

The server runs `node --import tsx/esm --watch src/index.ts` (Node's native watch
with the tsx TypeScript loader). This is deliberate: `tsx watch`'s own child-process
/ IPC mechanism can fail to start under `npm` + `concurrently` on Windows, leaving
the server alive but never listening. Node's native `--watch` is reliable there and
still hot-reloads on source changes.

### Readiness — how to know it is actually up

The server logs each startup phase with timing, then reports readiness:

```
[startup] phase=config elapsed=…
[startup] phase=database elapsed=…
[startup] phase=worktree-reconciliation elapsed=…
[startup] phase=routes elapsed=…
[startup] phase=agents elapsed=…
[startup] phase=recovery elapsed=…
[startup] ready in …ms
[server] listening on http://127.0.0.1:8080
```

The health endpoint reports readiness explicitly, so "listening but still
initializing" is distinguishable from "fully ready":

```powershell
curl http://127.0.0.1:8080/api/health
# {"status":"ok","ready":true,"phase":"ready","uptimeMs":…,"timestamp":…}
```

The client shows **Live** once its WebSocket is open and REST calls succeed. Until
the server is listening it shows **Reconnecting… / Backend offline** and retries
with backoff — that is expected during the first few seconds of startup, not an error.

> Startup takes a few seconds. Agent CLI detection and startup worktree/task
> recovery run before the port opens; the `[startup]` phase timings show where the
> time goes. If a phase appears to hang, the last logged phase identifies it.

## Product preview (safe — does not run agents)

To review the evolving UI **without launching agents, making paid API calls, or
touching project repositories on startup**, set the preview flag before starting:

```powershell
$env:AGENTBOARD_DISABLE_AGENT_STARTUP = "1"
npm run dev
```

Then open **http://localhost:8081**.

With this flag the server:
- detects agents and lists them in the UI, but does **not** boot their SDK clients;
- **skips auto-dispatch of pending runs** and the background dispatch loop, so
  starting the app never launches an agent on its own;
- still recovers stale task state and serves the full board, projects, MCP,
  sessions, and templates UI for review.

Manual actions you take in the UI are still explicit — nothing runs automatically.
To stop the preview, press `Ctrl+C` in the terminal running `npm run dev`.

To return to normal development (agents enabled), open a **new** terminal (or clear
the variable) and run `npm run dev` again:

```powershell
Remove-Item Env:AGENTBOARD_DISABLE_AGENT_STARTUP -ErrorAction SilentlyContinue
npm run dev
```

## Run components separately

```powershell
npm run dev:server   # API only  (port 8080)
npm run dev:client   # Vite only (port 8081)
```

## Tests / required gate

```powershell
npm run gate:required   # contract tests + client build + server build + E2E
```

E2E runs an **isolated** app on ports `3002`/`4176` with
`AGENTBOARD_DISABLE_AGENT_STARTUP=1` and a throwaway database, so it never collides
with your dev server and never runs real agents.

---

## Troubleshooting

### "Port … already in use" / server never listens / client shows 502

The server now exits with an actionable message when its port is taken:

```
[server] FATAL: Port 8080 on 127.0.0.1 is already in use — … orphaned process …
```

This almost always means a **previous dev run left an orphaned process** holding the
port. Find and stop it:

```powershell
# See what is listening on the dev ports
netstat -ano | findstr ":8080 :8081"

# Stop whatever is holding 8080 and 8081 (the dev server + client)
Get-NetTCPConnection -LocalPort 8080,8081 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

Then run `npm run dev` again. If you only want to stop a specific PID from the
`netstat` output: `Stop-Process -Id <PID> -Force`.

> Always stop dev with `Ctrl+C` in the `npm run dev` terminal so both processes shut
> down cleanly. Closing the terminal window or killing only one process can leave an
> orphan behind.

### Server starts but a phase hangs

The `[startup] phase=…` log identifies the slow/stuck step. The server bounds the
risky steps so it cannot hang forever:
- each agent provider `start()` is bounded by `AGENT_START_TIMEOUT_MS` (default 30s);
- worktree git inspection is bounded (20s per git call) and treated as "blocked" on timeout.

If a provider times out it is marked unavailable and startup continues; the port
still opens.

### `NODE_MODULE_VERSION … compiled against a different Node.js version`

A native addon (`better-sqlite3`, `node-pty`) was built for a different Node version.
Rebuild it for the current Node:

```powershell
npm rebuild better-sqlite3 node-pty
```

If rebuilding from source fails on Windows (no Visual Studio C++ tools), reinstall so
the prebuilt binary for your Node version is fetched:

```powershell
npm install better-sqlite3 node-pty
```

### Client loads but every API call fails (502 / ECONNREFUSED)

The client is up but the server is not listening. Check the server terminal for the
`[startup]` phases and any `FATAL` message, then use the port-conflict steps above.
Confirm the server independently with `curl http://127.0.0.1:8080/api/health`.
