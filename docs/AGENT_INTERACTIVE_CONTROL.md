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

- **C1:** permission model + registry + response API + AgentPanel UI; wire ACP + Copilot (patched).
- **C2:** Claude `canUseTool` and OpenCode permission wiring.
- **C3:** Codex limitation surfaced; expiration/cancellation hardening; regression tests.

Deterministic tests use a fake provider that raises a permission request and asserts the
request→respond→resume flow, expiry, cross-task rejection, and no-auto-approve. Real interactive
approval is verified only via the opt-in live harness (explicit authorization).
