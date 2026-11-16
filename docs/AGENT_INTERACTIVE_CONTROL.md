# Interactive Agent Control — Native Capability Investigation & Design (Stage C)

**Requirement:** interactive, **bidirectional** control from the Board. The agent requests
approval or user input → the Board displays it → the user responds → the agent continues,
**without losing the session**. No silent downgrade to automatic approval/denial.

This documents each provider's **native** SDK/ACP capability (not just what
`@codewithdan/agent-sdk-core` currently wires), the gaps, and the design. It preserves the
existing provider architecture and the six core product capabilities.

## Native capability matrix (verified against installed SDKs)

| Provider | Native interactive approval/input | Native mechanism | Current `agent-sdk-core` wiring |
|---|---|---|---|
| **Copilot** (`@github/copilot-sdk`) | Yes | `onPermissionRequest(req)` session callback returning a permission result | Wired, but **defaults to `COPILOT_APPROVED`** when no consumer hook (auto-approve) |
| **Claude** (`@anthropic-ai/claude-agent-sdk`) | Yes | `canUseTool` callback → `Promise<PermissionResult>`; also `pending_permission_requests` / `request_user_dialog` for re-arming in-flight dialogs on reattach | **Not wired** — only sets `permissionMode:'acceptEdits'` |
| **OpenCode** (`@opencode-ai/sdk`) | Yes | permission request events + `postSessionIdPermissionsPermissionId` ("Respond to a permission request") | **Not wired** |
| **ACP** (Hermes / OpenClaw / Grok) | Yes | ACP `session/request_permission` → `handlePermissionRequest` → `hooks.onPermissionRequest({kind})` | Wired, but hook is called **synchronously** (not awaited); default `denied-by-rules` |
| **Codex** (`@openai/codex-sdk`) | Config policy only | `approvalPolicy: 'never'\|'on-request'\|'on-failure'\|'untrusted'`, `sandboxMode`; no interactive per-request callback exposed by this SDK | Not wired; **show limitation**, do not auto-approve |

**Key gaps:**
- Copilot auto-approves by default (must become interactive / explicit).
- Claude `canUseTool` and OpenCode permission API are unused.
- ACP hook is synchronous, so it cannot await a human response.
- The Board passes **no hooks** to `provider.createSession`, and has no permission-request
  event, pending-request registry, response endpoint, or UI.

## Extension mechanism (reuse, don't rewrite)

The repo already patches `agent-sdk-core` via `scripts/apply-agent-sdk-patches.cjs`
(idempotent, re-applied on `postinstall`). Stage C uses this established mechanism for the
minimal provider changes (await the ACP hook; expose Claude `canUseTool`; surface OpenCode
permission events; remove Copilot auto-approve), rather than forking the provider architecture.

## Design

1. **Generic permission request model.** New `AgentEvent` type `permission_request` carrying
   `{ requestId, kind, tool/title, options }`, plus a `permission_response` flow. Requests are
   persisted and broadcast like other events (so they survive panel close/reopen and reconnect).
2. **Pending-request registry (AgentManager).** `requestId → { taskId, sessionId, kind, resolve,
   createdAt, expiresAt }`. A provider hook emits the event and returns a Promise that resolves
   when the user responds (or rejects on expiry/cancel/stop).
3. **Response API.** `POST /api/tasks/:id/permission-response` `{ requestId, approved, optionId? }`.
   Validates the request belongs to that task/session, is still pending, and not expired; resolves
   the pending promise. Authenticated like other task mutations.
4. **UI (AgentPanel).** Render pending `permission_request` with Approve / Deny (and options where
   the provider offers them). On respond, call the API; show waiting/resolved state. Reopening the
   panel re-fetches events, so a pending request is still visible (reattachment).
5. **Provider adapters.**
   - ACP: await the (patched) async `onPermissionRequest` hook.
   - Copilot: route `onPermissionRequest` to the registry (no auto-approve).
   - Claude: wire `canUseTool` to the registry (bypass/extend the wrapper).
   - OpenCode: subscribe to permission events, respond via the SDK permission endpoint.
   - Codex: no interactive callback → surface "interactive approval not supported by this
     provider integration" and use an explicit, non-silent policy; never auto-approve.

## Security requirements (must hold)

- Every approval is bound to the correct **task + session + requestId**; cross-task responses rejected.
- Authorization enforced on the response endpoint (same boundary as task mutations).
- **Expiration + cancellation:** pending requests expire and are cancelled on session stop/destroy;
  a stale/expired approval can never be reused.
- **No default allow-all.** Absent an explicit user decision, the safe outcome is deny/cancel,
  never silent approval. Unsupported providers show the limitation instead of auto-deciding.

## Incremental plan

- **C1 — DONE:** permission model + registry + response API + AgentPanel UI; wired ACP
  (Hermes/OpenClaw/Grok) + Copilot (patched; Copilot auto-approve removed).
- **C2 — Claude + OpenCode DONE.** Claude wired via native `canUseTool` (patched to use
  `permissionMode:'default'` + `canUseTool` when the Board hook is present; no auto-accept).
  OpenCode wired per the verified `@opencode-ai/sdk` contract: the event loop handles
  `permission.updated`, routes it to the Board hook, and responds via
  `postSessionIdPermissionsPermissionId` (`once`/`reject`, no allow-all). OpenCode is not
  installed here, so this wiring follows the verified contract but needs live verification.
- **C3 — DONE.** Configurable permission TTL (`AGENTBOARD_PERMISSION_TTL_MS`), single-use
  settlement (late/stale responses rejected), cancellation on stop/terminate/shutdown. Codex
  limitation surfaced (config `approvalPolicy` only, no interactive callback; not auto-approved).

Deterministic tests use fake providers that raise a permission request and assert the
request→respond→resume flow, expiry, cross-task rejection, and no-auto-approve (ACP, Copilot,
Claude, OpenCode covered). Real interactive approval is verified only via the opt-in live harness
(explicit authorization).

## Stage D — MCP & skills delivery (DONE)

Goal: make the Board's existing MCP/skills configuration usable by assigned agents, not just
visible in the UI. Reuses the native SDK/ACP injection points and the `mcp_permissions` store;
no second MCP engine.

**MCP delivery** (`services/mcp-delivery.ts`):
- Default-deny: a server is delivered to an agent only if ≥1 of its tools is explicitly allowed
  for that agent in `mcp_permissions`.
- Native per-session injection via `provider.createSession({ mcpServers })` (patched wrappers
  forward it): Copilot `Record<name,MCPServerConfig>` with a per-tool `tools` allowlist (real
  tool-level enforcement); Claude `Record<name,McpServerConfig>` (server-level gating — Claude's
  MCP config has no per-tool allowlist); ACP Hermes/OpenClaw/Grok `McpServer[]` (env/header pairs).
- Credentials (env/headers) are passed to the SDK config only — never to prompts, logs, or UI
  events (regression-tested).
- Provider differences handled explicitly: Codex/OpenCode per-session MCP injection is not wired
  (documented limitation), rather than pretending all agents are identical.

**Skills** (`services/skills.ts`):
- Discover local `SKILL.md` skills (`<skills-root>/<name>/SKILL.md`, YAML frontmatter). Root
  defaults to `<AGENTBOARD_HOME>/skills`, override `AGENTBOARD_SKILLS_DIR`. Exposed at `GET /api/skills`.
- Delivered to supporting agents: Copilot `skillDirectories`, Claude `skills` + `settingSources`.
  Claude skills must live in a settings-discoverable location; other providers are unchanged.

Deterministic tests: `mcp-delivery.test.ts` (default-deny, native formats, delivery into
`createSession`, credentials not leaked to events) and `skills.test.ts` (discovery + delivery).
Real MCP/skill usage by a live agent requires the opt-in live harness (explicit authorization).
