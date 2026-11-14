# AI Agent Orchestrator — Implementation Roadmap

Tracks completed features, pending work, blockers, test results, and commit references for the Kanban-based AI Agent Orchestrator (fork of `DanWahlin/ai-agent-board`).

## Repository & fork
- Local: `E:\MyCode\ai-agent-board`
- Fork: `https://github.com/hokandil/ai-agent-board`
- Upstream: `https://github.com/DanWahlin/ai-agent-board`
- Development branch: `development` (tracks `origin/development`)
- Baseline: `main` @ `4f2965e` (== upstream `main`, 0 ahead / 0 behind)

## Phase A (architecture assessment) — COMPLETE
- Architecture diagram in Mermaid, reuse matrix, licence assessment, backlog, acceptance criteria, fork strategy, open questions
- See prior Phase A report + addendum (recovered Hermes transcript from `state.db`)
- Hermes findings verified: `external_source`/`external_key` dedup schema, agent detection, MCP absence, read-only TerminalView (`disableStdin: true`), no approvals

## Stage 1 — Foundation integration and reliability — COMPLETE
Commits on `development`:
- `f221eb6` fix: resolve git executable on Windows when PATH holds only a .cmd shim
- `cf9444f` chore: ignore probe scripts and sqlite sidecar files
- `b6234ca` Stage 1: fix Windows worktree cleanup, OpenCode v2 provider, and harden Git invocation paths
  - Windows worktree cleanup: `inspectWorktreeProcessUse` now inspects Windows process command lines via PowerShell; non-Linux/non-Windows fail closed
  - OpenCode v2 provider fix: `opencode server listening on` → `server listening on` regex (agent-sdk-core@0.7.0); verified against real opencode v2.0.32 binary
  - `scripts/apply-agent-sdk-patches.cjs` + `postinstall` hook for reproducible patch on fresh installs
  - `gitExecFileSync()` shim-safe wrapper; replaced all bare `execFileSync('git', ...)` calls
- Milestone 1.1: `npm run gate:required` green on Windows — 91 server tests + 180 E2E (4 conditional skips) + Hermes + builds
- `git run-contract-tests.cjs` fixed for Windows (spawnSync npm.cmd EINVAL → node npm-cli.js)

Gate result (Stage 1 completion): **PASS — gate exit=0**

## Stage 2 — Generic MCP Manager — COMPLETE
Commits on `development`:
- `fac6153` Stage 2: add MCP server registry tables to SQLite and Postgres migrations
- `53cb82a` Stage 2: add MCP client service for connecting to external MCP servers
- `2916753` Stage 2: extend auth scopes for MCP (mcp:read, mcp:write, mcp:connect)
- `4a3970d` Stage 2: add MCP server routes (CRUD, connect, discover, test-tool, permissions)
- `c5bc8be` Stage 2: add MCP API client functions and types
- `ac72538` Stage 2: add Generic MCP Manager (routes, auth, client API, UI)

Implemented:
- `@modelcontextprotocol/sdk@1.32.2` (MIT, npm latest — no 2.x published)
- MCP client service: connect/disconnect over stdio, streamable-http, sse; tool discovery; tool calling
- MCP server registry: mcp_servers, mcp_tools, mcp_permissions tables (SQLite + Postgres)
- Auth scopes: mcp:read, mcp:write, mcp:connect (extends existing ServiceScope model)
- API routes: GET/POST/DELETE /api/mcp/servers, POST /connect, /disconnect, GET /tools, POST /test-tool, GET/POST/DELETE /permissions
- UI: McpServerConfig component — server list, connect/disconnect, tool discovery & test, per-agent permissions
- Client API functions + types; routing at /mcp; Header nav link
- Windows-safe subprocess resolution via gitExecFileSync pattern

Gate result (Stage 2 completion): **PASS — gate exit=0**

## Stage 3 — External task synchronization — COMPLETE
Commits on `development`:
- `cd86f3c` Stage 3: add MCP external task synchronization engine and routes
- `0b77380` Stage 3: add MCP sync UI and client API

Implemented:
- `mcp_sync_connections` table: links board tasks to external MCP tasks (external_source + external_key unique index, per-connection sync_direction, conflict_policy)
- `sync_field_mappings` table: external_field → board_field mapping with transforms (identity, lowercase, uppercase, capitalize, trim)
- `sync_conflicts` table: pending/resolved/ignored conflicts with external and board values
- `sync_state` table: last sync timestamps and sync count per connection
- Sync engine: sync() runs bidirectional import/export; importTask() creates board tasks without auto-starting execution (agentStatus stays 'idle'); exportTask() pushes board changes to external
- Conflict handling: board_wins / external_wins / manual policies; manual mode creates pending conflicts for user resolution
- API routes: GET/POST/DELETE /api/mcp/sync/connections, POST /sync, /import, /export, GET/POST/DELETE /mappings, GET /conflicts, POST /conflicts/:id/resolve, /:id/ignore, GET /state
- UI: McpSyncConfig component — connection list, sync/import/export actions, field mapping editor, conflict resolution UI
- Client API functions + types; routing at /mcp/sync; Header nav link

Gate result (Stage 3 completion): PENDING — gate running

## Stage 4 — Multi-session Agent Execution
- Agent/provider identity separate from execution-session identity
- Multiple concurrent sessions per provider; configurable concurrency limits
- Independent task assignment/start/stop/resume; per-session model selection
- Worktree isolation; real-time monitoring; execution history; crash recovery
- Prioritize working OpenCode multi-session path first

## Stage 5 — Interactive Terminal and Session Management
- node-pty + xterm.js UI; real terminal input/output
- Hide session without terminating; reattachment; scrollback recovery
- Preserve sessions across browser reloads; survive server restarts
- External session discovery only where agent supports it
- Approvals, termination, worktree cleanup safety

## Stage 6 — Agent-accessible Kanban MCP Server
- Expose board operations to agents (read tasks, claim/request assignment, request execution, report progress, submit results, request review/approvals, update authorized states)
- Narrowly scoped write permissions + explicit approval policies; agents and humans share same task logic

## Stage 7 — GitHub and Delivery Workflow
- Branches, commits, GitHub Issues, PRs and reviews, CI/check status
- Execution-to-PR associations; review and completion gates
- No assumption task IDs appear in branch names/commit messages

## Stage 8 — Product Hardening
- UX improvements; error handling; authorization; audit logs; concurrency
- SQLite + Postgres schema parity; contract/integration/E2E tests
- Third-party licensing review; generate THIRD_PARTY_NOTICES.md
- Documentation: configuration, Windows setup, development, deployment

## Definition of done per stage
Implemented + integrated + verified through the intended interface + gate:required passing + committed to `development` + pushed to fork.
