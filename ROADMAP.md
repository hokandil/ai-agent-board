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

## Stage 2 — Generic MCP Manager — IN PROGRESS
Implement a first-class MCP Host/Client on top of `@modelcontextprotocol/sdk@1.32.2` (pinned stable, MIT).

Requirements:
- Configure arbitrary compatible MCP servers through the UI (stdio, Streamable HTTP, legacy transports)
- Connect, disconnect, test, discover tools/resources/prompts; display tool schemas and errors
- Configure permissions per agent/session; never auto-grant all agents access
- Protect stored credentials; prevent credential leakage
- Extend existing auth scopes (ServiceScope in middleware/auth.ts) instead of parallel authorization
- Test Windows-specific subprocess resolution

Planned files:
- `packages/server/src/db.ts` — mcp_servers, mcp_tools, mcp_permissions tables (SQLite + Postgres)
- `packages/server/src/repositories/types.ts` — MCP repository interfaces
- `packages/server/src/services/mcp-client.ts` — MCP client manager
- `packages/server/src/services/mcp-permissions.ts` — permission checking
- `packages/server/src/routes/mcp.ts` — MCP server CRUD, discover, test-tool routes
- `packages/server/src/middleware/auth.ts` — extend ServiceScope (mcp:read, mcp:write, mcp:connect)
- `packages/client/src/lib/api.ts` — MCP API client functions
- `packages/client/src/components/McpServerConfig.tsx`, `McpPermissions.tsx` — UI
- `packages/client/src/App.tsx` — routing
- Tests: route-level + Windows subprocess resolution

Blockers:
- `@modelcontextprotocol/sdk` v2 is git-only; npm has no 2.x → pin `1.32.2` (MIT)
- OpenCode v2 detection fix depends on agent-sdk-core patch being applied via postinstall

## Stage 3 — External task synchronization
- Mapping external task fields to board fields; import without auto-starting execution
- External identifier preservation + deduplication (reuse existing `external_source`/`external_key` + unique index)
- Bidirectional sync where supported; field ownership; conflict detection; safe retry
- Task dependencies + blocked-state behavior

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
