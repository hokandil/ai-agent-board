# Product Acceptance Report — AI Agent Board

**Date:** 2026-11-15 (remediation cycle)  
**Repository:** `E:\MyCode\ai-agent-board`  
**Branch:** `development`  
**Fork:** `https://github.com/hokandil/ai-agent-board`  
**Tester:** Independent QA / Technical Acceptance Engineer  
**Method:** Live runtime testing against running server (port 8080) and client (port 8081), direct API calls, database inspection, E2E regression tests

---

## Executive Summary

**Status: NO-GO → PARTIAL GO** — Four critical defects were identified and remediated. The product is functional for core workflows but several acceptance scenarios remain unverified due to environment constraints.

### Remediated Defects

| # | Defect | Severity | Status | Fix |
|---|--------|----------|--------|-----|
| 1 | MCP tool-call validation failure | CRITICAL | **FIXED** | Updated `tools/call` handler schema in `mcp-board-server.ts` to include `params` with `name` and optional `arguments` (Zod v4 strips unknown keys). |
| 2 | Missing task events endpoint | CRITICAL | **FIXED** | Added `GET /api/tasks/:id/events` route to `routes/tasks.ts` that reuses `repo.getEventsByTaskId()`. |
| 3 | Audit logging not triggered | HIGH | **FIXED** | Added audit logging calls to MCP REST routes (`mcp.ts`), redacted secrets in `audit-logger.ts`, migrated `events.task_id` to nullable in `db.ts`. |
| 4 | Hermes startup crash (intermittent) | MEDIUM | **MITIGATED** | Added process-level `uncaughtException`/`unhandledRejection` handlers in `index.ts`. Crash not consistently reproducible. |

### Regression Tests Added

- `packages/e2e/tests/mcp-server.spec.ts` — 7 tests covering task events endpoint, MCP server routes, and audit logging infrastructure
- All 7 tests pass in the E2E test environment

---

## Feature-by-Feature Acceptance Status

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | Task creation (POST /api/tasks) | **PASS** | API calls confirmed in DB and API response |
| 2 | Task listing (GET /api/tasks) | **PASS** | Returned created tasks with correct fields |
| 3 | Task configuration | **PASS** | Set repoPath, branchName, agentType successfully |
| 4 | Task update (PATCH /api/tasks/:id) | **PASS** | Reset task status back to idle |
| 5 | Agent session start | **PASS** | Task moved to in-progress, agentStatus planning→executing |
| 6 | Agent session stop | **PASS** | agentStatus changed to failed, session cleaned up |
| 7 | Multi-session execution (2 agents) | **PASS** | Copilot + Hermes executing concurrently, confirmed via /api/sessions |
| 8 | MCP server registration | **PASS** | Server registered with stdio transport |
| 9 | MCP server connect/disconnect | **PASS** | Status changed connected→disconnected |
| 10 | MCP tool discovery | **PASS** | All tools discovered via GET /api/mcp/servers/:id/tools |
| 11 | **MCP tool calling** | **PASS** | Fixed — echo, calculator, secret_tool all return correct results |
| 12 | PTY terminal session | **PASS** | PTY session created, process spawned, input sent |
| 13 | PTY terminal input | **PASS** | Input sent successfully ("sent": true) |
| 14 | Task events endpoint | **PASS** | GET /api/tasks/:id/events returns events array |
| 15 | Audit logging | **PASS** | audit_log events persisted with secret redaction ([REDACTED]) |
| 16 | External task sync | **NOT TESTED** | Routes exist but not exercised |
| 17 | GitHub integration | **NOT TESTED** | Routes exist but not exercised |
| 18 | WebSocket event streaming | **PARTIAL** | WS connects and broadcasts, but events endpoint was missing (now fixed) |
| 19 | Project management | **PASS** | Default project "Chatai" exists, tasks associated correctly |
| 20 | Windows git spawn target | **NOT TESTED** | Code exists but not exercised |

---

## Critical Defects — Remediation Evidence

### Defect 1: MCP Tool Calling (FIXED)
**Root Cause:** `z.object({ method: z.literal('tools/call') })` stripped `params` (Zod v4 strips unknown keys), so `request.params` was `undefined` in the handler.

**Fix:** Updated schema to `z.object({ method: z.literal('tools/call'), params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }) })`.

**Evidence:** `POST /api/mcp/servers/:id/test-tool` with `{"toolName":"echo","arguments":{"message":"Hello MCP!"}}` returns `{"content":[{"type":"text","text":"Echo: Hello MCP!"}]}`.

### Defect 2: Missing Task Events Endpoint (FIXED)
**Root Cause:** No route handler for `GET /api/tasks/:id/events` existed in `routes/tasks.ts`, but client `api.ts` expected it.

**Fix:** Added route handler calling `repo.getEventsByTaskId(id)` with optional `since` and `limit` query parameters.

**Evidence:** E2E test `GET /api/tasks/:id/events returns task events` passes.

### Defect 3: Audit Logging (FIXED)
**Root Cause:** Audit logging calls existed in MCP board server routes but not in REST routes. Additionally, `events.task_id` was `NOT NULL` with a foreign key constraint, preventing audit events for non-task resources (MCP servers, sync connections).

**Fix:**
- Added `auditLogger.logMcpEvent()` calls to `mcp.ts` REST routes (create, sync, import, export, delete, conflict resolve/ignore)
- Added `redactSensitive()` function to `audit-logger.ts` that scrubs API keys, tokens, passwords, and secrets
- Migrated `events.task_id` to nullable in SQLite and PostgreSQL schemas
- Updated `AgentEvent.taskId` to optional in `shared/types.ts`

**Evidence:** Audit event recorded for `secret_tool` call shows `api_key: [REDACTED]`, `message: test` (secret redacted, non-secret preserved).

### Defect 4: Hermes Startup Crash (MITIGATED)
**Status:** Not consistently reproducible. Hermes agent started and executed successfully in multiple test runs after initial crash.

**Mitigation:** Added `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers in `index.ts` to prevent server crashes from unhandled agent SDK errors.

**Recommendation:** Continue monitoring in production. If crash recurs, enable detailed logging for Hermes provider ACP connection.

---

## Security Concerns

| Concern | Severity | Status |
|---------|----------|--------|
| No API_KEY configured | MEDIUM | Server warns "all endpoints are open without authentication" — must set API_KEY in production |
| MCP credentials in plain text | MEDIUM | Credentials stored in `mcp_servers` table. Audit logger redacts them in logs, but DB storage remains plaintext. **Needs encryption at rest.** |
| Audit log metadata | LOW | Now properly redacts secrets via `redactSensitive()` |
| Missing task events endpoint | CRITICAL | **FIXED** |

---

## Missing Acceptance Coverage

The following acceptance scenarios were **not tested** due to environment constraints:

1. **External task synchronization** — MCP sync connections, field mappings, sync execution, conflict resolution
2. **GitHub integration** — Issues, PRs, CI visibility, task sync
3. **PTY terminal reattachment** — Browser reload and session reattachment after disconnect
4. **Windows worktree cleanup** — Orphaned worktree recovery, process cleanup
5. **Agent concurrency limits** — Maximum concurrent sessions per agent type/project
6. **Task groups** — Group CRUD, group execution, parallelism slider
7. **Authentication** — API_KEY-based Bearer token auth (tested with API_KEY unset)
8. **Two real concurrent OpenCode sessions** — OpenCode not detected on this system

---

## Release Blockers (Remaining)

1. **Plaintext MCP credential storage** — MCP server env vars/headers stored in plaintext in database. Needs encryption at rest.
2. **Untested acceptance scenarios** — Items 1-8 above need verification before release.
3. **Hermes crash** — Intermittent, not consistently reproducible. Needs monitoring.

---

## Remediation Plan

### Priority 1 — Encrypt MCP credentials at rest
Encrypt `env` and `headers` fields in `mcp_servers` table before persisting. Decrypt on read. Preserve existing connections through migration.

### Priority 2 — Complete untested acceptance scenarios
- External MCP task synchronization and conflict handling
- GitHub Issues, PR, CI integration
- PTY terminal output, input, browser reload, reattachment
- Windows worktree cleanup and concurrency limits
- Authentication and authorization boundaries
- Two concurrent OpenCode sessions (when OpenCode is available)

### Priority 3 — Hermes crash monitoring
Add structured logging for Hermes provider startup. Monitor for recurrence in production.

---

## Final Recommendation: PARTIAL GO

Core features (task CRUD, agent execution, MCP tool calling, events, audit logging) are functional and tested. **Do not release** until MCP credential encryption is implemented and remaining acceptance scenarios are verified.

Do not merge `development` into `main` or deploy.
