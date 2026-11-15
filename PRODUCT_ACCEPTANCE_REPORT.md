# Product Acceptance Report — AI Agent Board

**Date:** 2026-11-15  
**Repository:** `E:\MyCode\ai-agent-board`  
**Branch:** `development` (d370eab)  
**Fork:** `https://github.com/hokandil/ai-agent-board`  
**Tester:** Independent QA / Technical Acceptance Engineer  
**Method:** Live runtime testing against running server (port 8080) and client (port 8081), plus direct API calls and database inspection

---

## Executive Summary

The AI Agent Board Stages 1-8 are implemented and the code builds cleanly with existing tests passing. However, live end-to-end testing reveals **critical defects** that prevent the product from being release-ready:

- **MCP tool calling is broken** — the `/api/mcp/servers/:id/test-tool` endpoint returns an MCP SDK validation error ("expected object, received undefined"), making the core MCP integration non-functional.
- **Missing `/api/tasks/:id/events` endpoint** — the client AgentPanel component expects this endpoint to fetch task events, but the server does not implement it.
- **No audit events are being recorded** — despite the audit logger being wired into MCP routes, zero `audit_log` events exist in the database because the code paths that trigger them (MCP tool calls, sync operations) were never successfully exercised.
- **Server crashed once during Hermes agent startup** — the server process died when the Hermes agent provider attempted execution. Could not be consistently reproduced (Copilot and Hermes both worked on subsequent attempts), indicating a potential race condition or unstable provider startup.

**Recommendation: NO-GO for release** until critical defects are remediated.

---

## Feature-by-Feature Acceptance Status

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | Task creation (POST /api/tasks) | **PASS** | Created tasks via API, confirmed in DB and API response |
| 2 | Task listing (GET /api/tasks) | **PASS** | Returned created tasks with correct fields |
| 3 | Task configuration (POST /api/tasks/:id/configure) | **PASS** | Set repoPath, branchName, agentType successfully |
| 4 | Task update (PATCH /api/tasks/:id) | **PASS** | Reset task status back to idle |
| 5 | Agent session start (POST /api/tasks/:id/run) | **PASS** | Task moved to in-progress, agentStatus planning→executing |
| 6 | Agent session stop (POST /api/tasks/:id/stop) | **PASS** | agentStatus changed to failed, session cleaned up |
| 7 | Multi-session execution (2 agents simultaneously) | **PASS** | Copilot + Hermes both executing concurrently, confirmed via /api/sessions |
| 8 | MCP server registration (POST /api/mcp/servers) | **PASS** | Server registered with stdio transport |
| 9 | MCP server connect/disconnect | **PASS** | Status changed connected→disconnected |
| 10 | MCP tool discovery (GET /api/mcp/servers/:id/tools) | **PASS** | All 3 custom tools (echo, get_time, calculator) discovered |
| 11 | **MCP tool calling** (POST /api/mcp/servers/:id/test-tool) | **FAIL** | Returns "MCP error -32602: Invalid input: expected object, received undefined" |
| 12 | PTY terminal session creation | **PASS** | PTY session created, process spawned |
| 13 | PTY terminal input | **PASS** | Input sent successfully ("sent": true) |
| 14 | Task events endpoint (GET /api/tasks/:id/events) | **FAIL** | Endpoint does not exist on server; client AgentPanel expects it |
| 15 | Audit logging (audit_log events in DB) | **FAIL** | Zero audit_log events in events table; code path not exercised |
| 16 | External task sync (MCP sync routes) | **NOT TESTED** | Routes exist but were not exercised |
| 17 | GitHub integration (Issues/PRs/CI) | **NOT TESTED** | Routes exist but were not exercised |
| 18 | WebSocket event streaming | **PARTIAL** | WS connects and broadcasts task updates, but no events endpoint |
| 19 | Project management | **PASS** | Default project "Chatai" exists, tasks associated correctly |
| 20 | Windows git spawn target | **NOT TESTED** | Code exists but not exercised |

---

## Actual Test Evidence

### Test 1: Task Creation and Agent Execution

```
POST /api/tasks
Request: {"projectId":"default","title":"Test Task 1","description":"...","priority":"medium","agentType":"hermes","columnId":"backlog"}
Response: {"id":"938a7e34-...","title":"Test Task 1","agentStatus":"idle","agentType":"hermes","columnId":"backlog"}

POST /api/tasks/938a7e34-.../configure
Request: {"repoPath":"E:\\MyCode\\chatai","agentType":"hermes"}
Response: 200 OK with updated task

POST /api/tasks/938a7e34-.../run
Response: {"agentStatus":"planning","columnId":"in-progress","startedAt":1794723269879}

GET /api/sessions
Response: [{"id":"session-2d17efad-...","agentType":"hermes","status":"executing"}]

POST /api/tasks/938a7e34-.../stop
Response: {"agentStatus":"failed"}
```

### Test 2: Multi-Session Execution

```
POST /api/tasks/d7dcce5b-.../run  (Copilot)
POST /api/tasks/dfc0fdca-.../run  (Hermes)
Both returned 200 with agentStatus:"planning"

GET /api/sessions
Response: [
  {"id":"session-46622007-...","agentType":"copilot","status":"executing"},
  {"id":"session-196bd963-...","agentType":"hermes","status":"executing"}
]
```

### Test 3: MCP Server Configuration

```
POST /api/mcp/servers
Request: {"name":"Test MCP Server","transport":"stdio","command":"node","args":["test-mcp-server.js"]}
Response: {"id":"mcp-server:f90acc25-...","status":"disconnected"}

POST /api/mcp/servers/mcp-server:f90acc25-.../connect
Response: {"status":"connected","last_connected_at":1794723139512}

GET /api/mcp/servers/mcp-server:f90acc25-.../tools
Response: {"tools":[{"name":"echo",...},{"name":"get_time",...},{"name":"calculator",...}]}
```

### Test 4: MCP Tool Calling — FAILURE

```
POST /api/mcp/servers/mcp-server:f90acc25-.../test-tool
Request: {"toolName":"echo","arguments":{"message":"Hello MCP!"}}
Response: {"error":"Tool call failed: MCP error -32602: MCP error -32602: Invalid tools/call request: [{\"expected\":\"object\",\"code\":\"invalid_type\",\"path\":[\"params\"],\"message\":\"Invalid input: expected object, received undefined\"}]"}
```

### Test 5: Missing Events Endpoint

```
GET /api/tasks/938a7e34-.../events
Response: (empty / no endpoint implemented)
```
The client `api.ts` defines `getEvents: (id: string) => request<AgentEvent[]>('/tasks/${id}/events')` but no matching route exists in `routes/tasks.ts`.

### Test 6: Audit Log — Zero Events

```
SELECT * FROM events WHERE type = 'audit_log'
Result: 0 rows
```

The database has 222 agent events (thinking, command, file_read, etc.) but zero audit_log events, confirming audit logging is not being triggered.

---

## Critical Defects Ranked by Severity

### Defect 1: MCP Tool Calling Broken (CRITICAL)
**Endpoint:** `POST /api/mcp/servers/:id/test-tool`  
**Error:** MCP SDK validation error: "Invalid input: expected object, received undefined" at path "params"  
**Impact:** The core MCP integration — one of the primary Stage 6/8 features — is non-functional. Agents cannot call tools through the board's MCP server.  
**Root Cause:** The `callTool` method in `mcp-client.ts` passes `args as Record<string, unknown>` but the MCP SDK (v1.32.2) rejects the request, suggesting a schema validation mismatch in how arguments are serialized.  
**Steps to Reproduce:**
1. Register an MCP server with stdio transport
2. Connect to it
3. Call POST /api/mcp/servers/:id/test-tool with any tool and arguments

### Defect 2: Missing Task Events Endpoint (CRITICAL)
**Endpoint:** `GET /api/tasks/:id/events`  
**Impact:** The AgentPanel UI component calls `api.getEvents(taskId)` to fetch task events. With no endpoint, the agent event stream panel cannot display events.  
**Root Cause:** No route handler for `:id/events` exists in `routes/tasks.ts`.  
**Steps to Reproduce:** Open AgentPanel for any task with agent events; events panel will be empty.

### Defect 3: Audit Logging Not Triggered (HIGH)
**Impact:** Zero `audit_log` events in the database. Audit trails for MCP operations, sync operations, and board modifications are not being captured.  
**Root Cause:** Audit logging calls were added to MCP routes, but the code paths that trigger them (MCP tool calls, sync operations) are either broken (tool calling) or untested.  
**Steps to Reproduce:** Query `SELECT * FROM events WHERE type = 'audit_log'` — returns 0 rows.

### Defect 4: Server Crash During Agent Startup (MEDIUM)
**Impact:** The server process crashed when starting a Hermes agent session. Could not be consistently reproduced (Copilot and Hermes both worked on subsequent attempts).  
**Root Cause:** Possibly a race condition in provider initialization or ACP connection. The first Hermes attempt crashed; subsequent Hermes and Copilot attempts succeeded.  
**Steps to Reproduce:** Start server, configure task with Hermes agent, run task — may crash on first attempt after a prior MCP-related crash.

---

## Missing Acceptance Coverage

The following features from Stages 1-8 were **not tested** during this acceptance review:

1. **External task synchronization** — MCP sync connections, field mappings, sync execution, conflict resolution, import/export
2. **GitHub integration** — Issues, PRs, CI visibility, task sync
3. **Audit log retrieval** — No UI or API endpoint exists to view audit logs
4. **PTY terminal reattachment** — Browser reload and session reattachment after disconnect
5. **Windows-specific process/worktree cleanup** — Orphaned worktree recovery, process cleanup on Windows
6. **Agent concurrency limits** — Maximum concurrent sessions per agent type/project
7. **Task groups** — Group CRUD, group execution, parallelism slider
8. **Authentication** — API_KEY-based Bearer token auth (tested with API_KEY unset = open access)

---

## Security Concerns

| Concern | Severity | Details |
|---------|----------|---------|
| No API_KEY configured | MEDIUM | Server started with `WARNING: No API_KEY set - all endpoints are open without authentication`. In production, API_KEY must be set. |
| MCP credentials in plain text | MEDIUM | MCP server env vars and headers are stored in the `mcp_servers` table. The MCP client service comments say credentials are "encrypted at rest" but no encryption is evident in the schema or code. |
| Audit log metadata empty | LOW | Audit logger stores `metadata: {}` (empty object) — potentially missing useful context like actor IP, user agent, or request details. |
| No rate limiting on MCP test-tool | LOW | The test-tool endpoint could be abused to make arbitrary tool calls on connected MCP servers. |

---

## Release Blockers

1. **MCP tool calling must be fixed** — Core Stage 6 feature is non-functional
2. **Task events endpoint must be implemented** — AgentPanel cannot display agent events
3. **Audit logging must be verified working** — No audit trail exists
4. **Server crash during agent startup must be investigated** — Potential instability

---

## Remediation Plan

### Priority 1 — Fix MCP Tool Calling (CRITICAL)
**File:** `packages/server/src/services/mcp-client.ts`  
**Action:** Debug the `callTool` method to understand why MCP SDK rejects the arguments. Compare with the SDK's expected request format. The error "expected object, received undefined" at path "params" suggests the JSON-RPC params are not being serialized correctly.

### Priority 2 — Implement Task Events Endpoint (CRITICAL)
**File:** `packages/server/src/routes/tasks.ts`  
**Action:** Add `GET /:id/events` route handler that calls `repo.getEventsByTaskId(id)` and returns the events array. This matches the client's `api.getEvents()` expectation.

### Priority 3 — Verify Audit Logging (HIGH)
**Action:** Once MCP tool calling works, test that `logMcpEvent` calls generate `audit_log` entries in the events table. Add audit logging to task CRUD and agent operations as well.

### Priority 4 — Investigate Server Crash (MEDIUM)
**Action:** Add structured error handling around provider session creation. Capture and log the exact error when Hermes provider fails to start.

### Priority 5 — Add Test Coverage (MEDIUM)
**Action:** Add integration tests for:
- MCP tool calling through the API
- Task events endpoint
- Audit log event creation
- Agent session lifecycle (start → execute → stop)

---

## Final Recommendation: NO-GO

The product is **not ready for release**. Four defects (two critical, one high, one medium) must be remediated before the product can be considered functional:

1. **MCP tool calling is broken** — the primary Stage 6 integration feature does not work
2. **Task events endpoint is missing** — the AgentPanel UI cannot display agent events
3. **Audit logging produces zero events** — no audit trail exists
4. **Server instability during agent startup** — potential crash in production

**Do not merge `development` into `main` or deploy until these defects are resolved.**

---

## Appendix: Test Environment

- Server: `http://127.0.0.1:8080` (SQLite backend, `./data/agentboard.db`)
- Client: `http://127.0.0.1:8081` (Vite dev server)
- Database: SQLite at `packages/server/data/agentboard.db`
- Agents detected: GitHub Copilot (yes), Claude Code (yes), Hermes Agent (yes), OpenCode (no), OpenAI Codex (no)
- Test MCP server: Custom Node.js stdio server with echo, get_time, calculator tools
- MCP SDK version: 1.32.2
