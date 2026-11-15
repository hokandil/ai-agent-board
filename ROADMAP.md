## Stage 6 — Agent-accessible Kanban MCP Server — COMPLETE
Commits on `development`:
- `c5bc8be` Stage 6: MCP server - expose board as MCP server for AI agents
- `4a3970d` Stage 6: MCP server routes (CRUD, connect, discover, test-tool, permissions)
- `2916753` Stage 2: extend auth scopes for MCP (mcp:read, mcp:write, mcp:connect)

Implemented:
- `@modelcontextprotocol/sdk@1.32.2` (MIT, npm latest — no 2.x published)
- MCP client service: connect/disconnect over stdio, streamable-http, sse; tool discovery; tool calling
- MCP server registry: mcp_servers, mcp_tools, mcp_permissions tables (SQLite + Postgres)
- Auth scopes: mcp:read, mcp:write, mcp:connect (extends existing ServiceScope model)
- API routes: GET/POST/DELETE /api/mcp/servers, POST /connect, /disconnect, GET /tools, POST /test-tool, GET/POST/DELETE /permissions
- UI: McpServerConfig component — server list, connect/disconnect, tool discovery & test, per-agent permissions
- Client API functions + types; routing at /mcp; Header nav link
- Windows-safe subprocess resolution via gitSpawnTarget pattern

Gate result (Stage 6 completion): **PASS — gate exit=0**

## Stage 7 — GitHub and Delivery Workflow — COMPLETE
Commits on `development`:
- `ec32619` Stage 7: GitHub integration - Issues, PRs, CI visibility, task sync, review gates
- `57b2558` Stage 7: GitHub integration - sync routes, sync field, review gate

Implemented:
- GitHub Issues browse: GET /api/github/tasks/:id/issues
- GitHub PR list: GET /api/github/tasks/:id/pulls
- GitHub CI status: GET /api/github/tasks/:id/ci
- GitHub Issue detail: GET /api/github/tasks/:id/issues/:issueNumber
- GitHub PR detail: GET /api/github/tasks/:id/pulls/:prNumber
- GitHub service with `gh` CLI integration via `execFileSync`
- GitHub service GitHub API integration via Octokit

Gate result (Stage 7 completion): **PASS — gate exit=0**

## Stage 8 — Product Hardening — IN PROGRESS

- UX improvements across board, session panels, integrations, approval flows
- Harden error handling, authorization, audit logs and concurrency
- Verify SQLite and PostgreSQL schema parity
- Add useful contract, integration and E2E tests
- Review third-party licensing and redistribution obligations
- Generate third-party notices
- Document configuration, Windows setup, development and deployment
- Preserve extensibility for future agents and integrations

## Definition of done per stage
Implemented + integrated + verified through the intended interface + gate:required passing + committed to `development` + pushed to fork.