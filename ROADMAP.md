# AI Agent Board — Roadmap & Implementation Status

**Branch:** `development` · **Fork:** `hokandil/ai-agent-board`
**Rule:** green CI is **not** proof of functional completeness. A feature is only
"live-verified" when it has been exercised through its intended interface against real
behavior (not a stub). E2E runs with `AGENTBOARD_DISABLE_AGENT_STARTUP=1`, so it
live-verifies the **UI/API** but **not real agent execution**.

---

## Implementation status matrix

Status legend: ✅ implemented & live-verified · 🟡 implemented, partial/live-unverified ·
🔴 implemented but broken at runtime (mocked tests pass) · ⬜ unimplemented · ⛔ blocked.

| # | Feature | Status | Evidence | Mocked vs live | Missing work | Dependency | Seq |
|---|---------|--------|----------|----------------|--------------|------------|-----|
| 1 | Task CRUD + board + drag/drop + transitions | ✅ | `board.spec.ts` E2E; `routes/tasks.ts` | Live (real browser+API) | — | — | done |
| 2 | Task Groups (parallelism, aggregate, auto-advance) | ✅ | `groups.spec.ts` E2E; `GroupQueue` | Live | — | — | done |
| 3 | Task templates | ✅ | `templates.spec.ts` E2E | Live | — | — | done |
| 4 | Projects (local/GitHub detection, defaults, clone) | ✅ | `projects.spec.ts` E2E; `repo-status` | Live | — | — | done |
| 5 | Orchestration facade (idempotent, provenance) | ✅ | `projects.spec.ts`, orchestration tests | Live | — | — | done |
| 6 | Auth: API_KEY + SERVICE_TOKENS scopes | 🟡 | `scoped-auth.test.ts` | Live | Fix `/mcp/server` vs `/mcp/servers` scope overlap; enforce `mcp:board:execute/approve` | — | E0 |
| 7 | MCP credential encryption at rest | ✅ | `credential-encryption.test.ts`, migration tests | Live | Document `MCP_ENCRYPTION_KEY` as required in prod (plaintext fallback) | — | done |
| 8 | MCP server register/connect/disconnect/tools | ✅ | `mcp-server.spec.ts` E2E + manual | Live | — | — | done |
| 9 | MCP tool calling | 🟡 | manual echo/calculator/secret_tool | Live (manual) | **Enforce permissions at runtime** (currently display-only) | MCP→session bridge | E1 |
| 10 | MCP tools available to agent sessions | ⬜ | `AgentSessionConfig` has no MCP field; only Hermes `mcpServers` | — | MCP→session bridge + per-task/group binding | SDK or per-provider wiring | E1 |
| 11 | Board-as-MCP-server (8 `board.*` tools) | 🟡 | `mcp-board-server.ts`, audited | Route-level | Live external-agent verification | external MCP client | E1 |
| 12 | External MCP task sync (import/export) | 🔴 | `syncEngine` built with **stub repos** (`mcp-sync.ts` ~L212) → throws at runtime | Mocked only | Wire real repos; live end-to-end sync test | real MCP task server | E0 |
| 13 | GitHub integration (Issues/PRs/CI) | 🔴 | server routes exist; **client methods dead code** (`api.ts` ~L713); needs `gh` auth | Mocked/unverified | Move methods into `api`; `gh` CLI auth; live test | `gh` CLI + GitHub repo | E0 |
| 14 | Agent execution (Copilot/Claude/Hermes) | 🟡 | manual Copilot+Hermes; `agent-sdk.spec.ts`/`group-integration.spec.ts` **skipped** | Manual only | Automated real-agent verification | authenticated CLIs + test repo | later |
| 15 | Multi-session / OpenCode concurrency | ⛔ | OpenCode CLI not installed | — | Install OpenCode or mark out-of-scope | OpenCode CLI | later |
| 16 | PTY terminal | 🟡 | session create/input verified; `pty-sessions.ts` | Partial live | Automated reattachment test | — | later |
| 17 | Worktree isolation/cleanup/reconciliation | ✅ | `worktree-cleanup` tests (Windows) | Live (platform-dependent) | — | — | done |
| 18 | Client connection-status / backend-unavailable | ✅ | `backend-connectivity.spec.ts` | Live | — | — | done |
| 19 | Local dev runtime (Windows) | ✅ | fixed this cycle: `node --watch`, listen-error handler, readiness | Live | — | — | done |
| 20 | Extension system (A–E) | ⬜ | design in `docs/EXTENSION_ARCHITECTURE.md` | — | Phases E0–E4 | approval | E0→E4 |

### Product-owner feedback (UI-01 … UI-09)
Resolved in the remediation cycle (commits `51faf75`…`1eb5f56`): MCP edit/auth UX,
connection state, sync onboarding, task/agent state clarity, local/GitHub workflow,
duplicate handling, backend connectivity. **Exception:** the live **Stele** MCP
connection remains `not_authenticated` (UI-01) — it requires real credentials and is
**not** claimed fixed.

---

## Verified runtime defects (genuinely pending — Phase E0)

These pass route-level/mocked tests but do not work end-to-end:
1. `syncEngine` singleton stub-injected → sync/import/export throw (`services/mcp-sync.ts`).
2. GitHub client API methods are dead code after `connectWS`'s `return` (`client/src/lib/api.ts`).
3. `GET /api/mcp/permissions/:serverId` reads `req.params.id` (wrong param) → 404 (`routes/mcp.ts`).
4. `requiredScope` prefix overlap `/mcp/server` vs `/mcp/servers`; `mcp:board:execute/approve` never enforced (`middleware/auth.ts`).
5. `COPILOT_DENIED_TOOLS` documented but never read; providers built without deny-lists.

---

## Completed stages (identifiers preserved)

- **Stage 3** — MCP sync UI + client API.
- **Stage 4** — multi-session agent execution core; MCP session routes; session management API/UI.
- **Stage 5** — PTY terminal integration (node-pty + xterm.js).
- **Stage 6** — board exposed as an MCP server for AI agents.
- **Stage 7** — GitHub integration (Issues/PRs/CI, task sync, review gates). *Server-side; see defects #2/#4 — client wiring + live auth pending.*
- **UI remediation cycle** — UI-01…UI-09 (see above).
- **Dev-runtime hardening (this cycle)** — reliable Windows startup, listen-error
  diagnostics, startup readiness, safe preview mode. Commit `a90bd32`.

## Stage 8 — Product Hardening — COMPLETE
Commits on `development`:
- `f0c8c16` Stage 8: wire audit logger into MCP board server routes
- `fa025ba` Stage 8: wire audit logging into MCP sync routes

Implemented:
- Audit logger wired into MCP board server routes - all tool calls (list_tasks, get_task, claim_task, request_execution, report_progress, submit_results, request_review, update_task_status) are now audited with `mcp.tool.call` action
- Audit logger wired into MCP sync routes - all sync operations (create connection, sync, import, export, delete connection, resolve conflict, ignore conflict) are now audited with `mcp.sync.*` actions
- Third-party notices: THIRD_PARTY_NOTICES.md generated

Gate result (Stage 8 completion): **PASS — gate exit=0**

---

## Next pending stage

**Stage 9 — Integration Integrity (Phase E0).** Make the already-"implemented"
integrations actually work end-to-end, before adding new extension surface:
1. Wire `syncEngine` to real repositories; add a live sync test (or an in-process MCP
   task server fixture) so import/export is genuinely verified.
2. Move the GitHub client methods into the `api` object; verify against an authenticated
   `gh` CLI (or explicitly mark GitHub live-verification as blocked).
3. Fix the permissions route param and the auth scope-prefix overlap; enforce
   `mcp:board:execute/approve`.
4. Wire `COPILOT_DENIED_TOOLS` into the Copilot provider.

**Then Phase E1** (MCP tools → agent sessions + real permission enforcement) is the first
*new* extension capability, and the prerequisite for the FlowPlan MCP reference use case.

## Extension System (proposed future work — not yet approved)

Design: **[`docs/EXTENSION_ARCHITECTURE.md`](docs/EXTENSION_ARCHITECTURE.md)**.
Reusable mechanism for MCP tool extensions, external apps, native UI, backend extensions,
and AI-assisted repo integration. Phases E0–E4; **no marketplace** at this stage. FlowPlan
is a reference use case (MCP + external-app levels reuse existing infra; a native panel is
optional custom work). It fits **after** Stage 9 so current priorities are not disrupted.

---

## Agent Lifecycle Recovery (current mission)

- **Stage A — Execution correctness: DONE** (`84f7b11`). Fixed `terminateOnce` crash on the
  deleted session, durable terminal `agentStatus`, concurrency-counter release, group-queue
  draining, and worktree-path persistence.
- **Stage B — Session visibility & reattachment: DONE.** Durable session identity
  (`Task.agentSessionId`), terminal-session retention, true provider resume via the SDK
  `resumeSessionId`, per-project concurrency counting fix, and client event recovery on
  WebSocket reconnect.
- **Stage C — Interactive control: DONE (C1/C2/C3).** Bidirectional approval from the Board
  (agent requests → Board displays → user responds without losing the session). Permission
  event + registry + response API + AgentPanel UI; wired for ACP (Hermes/OpenClaw/Grok),
  Copilot (no auto-approve), Claude (`canUseTool`, no auto-accept), and OpenCode
  (`permission.updated` → native respond endpoint). C3 hardening: configurable TTL expiry,
  single-use settlement (no stale approvals), cancellation on stop/terminate/shutdown.
  Codex limitation surfaced (config `approvalPolicy` only; not auto-approved). OpenCode wiring
  follows the verified SDK contract but needs live verification (OpenCode not installed here).
  See `docs/AGENT_INTERACTIVE_CONTROL.md`.
- **Stage D — MCP & skills delivery: DONE.** Allowed MCP servers/tools are delivered to
  assigned agents via native injection (Copilot/Claude/ACP), derived from `mcp_permissions`
  (default-deny; Copilot per-tool allowlist). Credentials go to the SDK config only — never to
  prompts/logs/UI events. Local `SKILL.md` skills discovered (`GET /api/skills`) and delivered
  to supporting agents (Copilot `skillDirectories`, Claude `skills`). Codex/OpenCode MCP
  injection not wired (documented provider limitation). See `docs/AGENT_INTERACTIVE_CONTROL.md`.

Real-agent execution is exercised only by the opt-in live harness
(`AGENTBOARD_LIVE_AGENT_TEST=1`, requires explicit authorization). The deterministic gate
simulates execution with a fake in-process provider; green CI is not proof of live execution.

## Known issues / flaky tests

- **`projects.spec.ts` project-creation connection flake — RESOLVED (root cause found).**
  Symptom: after a project was created, the follow-up direct `request.get(/api/projects)`
  intermittently failed with no response / `read ECONNRESET` (seen on the autostart and
  folder-picker tests). **Root cause:** Node's default `server.keepAliveTimeout` (5s) can
  destroy an idle keep-alive socket just as a client reuses it; this race is aggravated when
  the event loop is briefly blocked by synchronous git operations during project creation /
  repo-status detection. **Fix:** harden HTTP keep-alive in `packages/server/src/index.ts`
  (`keepAliveTimeout=65s`, `headersTimeout=66s`). Verified by a full green `gate:required`
  (196 E2E passed) after the change, following repeated pre-fix failures. Stray leftover
  `--watch` dev servers / an orphaned E2E server were also cleaned up during investigation.

---

## Definition of done per stage
Implemented + integrated + verified through the intended interface + gate:required passing + committed to `development` + pushed to fork.
