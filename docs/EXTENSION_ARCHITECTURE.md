# Extension Architecture — Design Proposal

**Status:** Proposal for review (not yet approved for implementation).
**Scope:** A reusable mechanism to integrate third-party repositories and tools into
AI Agent Board without rewriting the frontend/backend for each tool.
**Non-goals (this stage):** a marketplace, an unrestricted GitHub-code installer,
automatic execution of untrusted repositories, or a second MCP implementation.

This design reuses the existing MCP, agent-provider, repository, auth, and audit
infrastructure. It is grounded in a read-only survey of the current code (file
references below) and uses [FlowPlan](https://github.com/Bariskau/flowplan) as a
reference use case — **not** a mandatory dependency.

---

## 1. What already exists (reuse, do not rebuild)

| Surface | Location | Reuse for |
|---|---|---|
| MCP client (stdio / streamable-http / sse), connect/disconnect/discoverTools/callTool | `packages/server/src/services/mcp-client.ts` (`MCPClientManager`) | Category A (MCP tool extensions) |
| MCP persistence + permissions, dual SQLite/Postgres | `repositories/mcp-types.ts`, `sqlite.ts`, `postgres.ts` (`MCPRepository`) | A, D |
| MCP REST CRUD + tools + permissions + test-tool | `routes/mcp.ts` | A |
| Board exposed **as** an MCP server (8 `board.*` tools) | `routes/mcp-server.ts`, `services/mcp-board-server.ts` | E (inbound agent integration) |
| Task sync engine (field mappings, conflict policies) | `services/mcp-sync.ts`, `routes/mcp-sync.ts` | A/E (task import/export) |
| Credential encryption at rest (AES-256-GCM) + redaction | `services/credential-service.ts`, `credential-encryption.ts` | all secret storage |
| Agent provider orchestration (sessions, events, worktrees, groups) | `services/agent-manager.ts` + `@codewithdan/agent-sdk-core` | A, E |
| Auth scopes (`SERVICE_TOKENS`), repo-path whitelist, WS host/origin policy | `middleware/auth.ts`, `routes/helpers.ts`, `network-policy.ts` | D, security |
| Audit logging + redaction | `services/audit-logger.ts` | all |
| Orchestration facade (idempotent, provenance) + Hermes plugin reference | `routes/orchestrations.ts`, `integrations/hermes-agent-board/` | E |
| Client API + WS layer | `packages/client/src/lib/api.ts` | C |

**Verified gaps that block reuse (must be fixed first — see Phase E0):**
1. `syncEngine` singleton is constructed with stub repos (`services/mcp-sync.ts`
   ~L212), so sync/import/export throw at runtime despite passing route-level tests.
2. MCP tools are **never passed to agent sessions** and permissions are
   **display-only** (`isToolAllowed` is only read by `GET /api/mcp/permissions`).
   `AgentSessionConfig` has no MCP/tools field; only `HermesProviderOptions.mcpServers`
   exists in the SDK.
3. GitHub client methods are dead code after `connectWS`'s `return`
   (`client/src/lib/api.ts` ~L713), so they are not members of `api`.
4. `GET /api/mcp/permissions/:serverId` reads `req.params.id` instead of
   `req.params.serverId` (`routes/mcp.ts` ~L333) → always 404.
5. `requiredScope` prefix overlap: `/mcp/server` also matches `/mcp/servers/...`
   (`middleware/auth.ts`); `mcp:board:execute`/`approve` declared but never enforced.

There is **no** app-level extension manifest, plugin loader, or "extension" concept
today. Client routing is a hardcoded `RouteState` / `readRoute()` / if-chain in
`App.tsx` (no react-router). Adding a page today = 4 coordinated edits.

---

## 2. Integration categories

- **A. MCP Tool Extensions** — register an external MCP server, discover its tools,
  control per-agent permissions, expose tools to agent sessions. *Reuses the existing
  MCP client + repository; the new work is the MCP→session bridge and enforcement.*
- **B. External Application Extensions** — integrate an independently running app via
  a link or (where permitted) an embedded view. *New: a link/embed registry + safe
  embed view. Do not assume every web app allows embedding.*
- **C. Native UI Extensions** — stable contract for UI contributions (nav, routes,
  panels, tabs, contextual actions). *New: a route/panel registry replacing the
  hardcoded if-chain; no unrestricted access to internal state.*
- **D. Backend Extensions** — controlled access to server capabilities (lifecycle,
  permissions, config, capability discovery). *Reuses the `createXRouter(deps)`
  factory + repository pattern; prefer out-of-process hosting.*
- **E. AI-Assisted Repository Integration** — accept a GitHub URL, analyze it
  read-only, classify integration approaches, and produce a proposed plan. *Reuses the
  orchestrations facade to run the analysis as an approved task. Never auto-executes.*

---

## 3. Capability model

An extension declares a set of **capabilities**. Each capability maps to an existing
subsystem, so the board never needs tool-specific code:

| Capability | Meaning | Backed by |
|---|---|---|
| `mcpServer` | Registers an external MCP server (transport + endpoint) | `MCPClientManager` + `MCPRepository` |
| `mcpTools` | Exposes selected MCP tools to agents (default-deny) | MCP→session bridge + `mcp_permissions` |
| `taskSync` | Import/export tasks via an MCP tool | sync engine (once wired) |
| `externalApp` | Link/embed to a running app | external-app registry + embed view |
| `uiRoute` / `uiPanel` / `uiAction` | Native UI contributions | UI registry (Category C) |
| `backendRoute` | A scoped backend API surface | router factory + `SERVICE_TOKENS` scopes |

Capabilities are **declarative data**, not code. The board interprets them through the
existing subsystems. This is what makes the system reusable across tools.

---

## 4. Extension manifest (schema proposal)

A single `extension.json` per extension. Illustrative (FlowPlan as an MCP + external app):

```jsonc
{
  "id": "flowplan",
  "name": "FlowPlan",
  "version": "0.1.0",
  "description": "Visual plan board for AI coding agents (MCP).",
  "homepage": "https://github.com/Bariskau/flowplan",
  "license": "MIT",
  "trust": "external",                 // "external" | "native"
  "capabilities": {
    "mcpServer": {
      "transport": "streamable-http",
      "url": "http://localhost:3100/mcp"
    },
    "mcpTools": {
      "allow": ["create_plan","add_cards","get_cards","get_plan","list_plans",
                 "update_card","get_all_feedback","answer_feedback"],
      "defaultDeny": true
    },
    "externalApp": { "url": "http://localhost:3100", "embed": "link" }
  },
  "permissions": ["mcp:read", "mcp:connect"],
  "configSchema": { /* JSON Schema for user-supplied config, e.g. endpoint */ },
  "requires": { "agentBoard": ">=0.1.0" }
}
```

- `trust: "external"` → out-of-process, protocol-bounded, runtime-registered.
- `trust: "native"` → in-process, code-reviewed, **build-time** registered (Category C/D).
- Secrets referenced by config are stored via `credentialService`, never in the manifest.
- The manifest is validated against a shared schema (`shared/extension-types.ts`).

---

## 5. Lifecycle & permission model

Lifecycle (every step explicit, audited):

```
discover → review → approve → register/install → enable → configure
                                              ↘ disable → update → remove
```

- **Review** shows the manifest, capabilities, requested permissions, trust tier, and
  (for stdio MCP) the exact command that would run. Nothing is installed before approval.
- **Approve** is a user action; it grants the declared permissions and is audit-logged.
- **Enable/disable** toggles an extension without deleting its config; disabled
  extensions expose no tools/routes/UI.
- **Remove** deletes the registration and (optionally) its stored config/credentials.
- **Update** re-reviews a changed manifest (version/capability/permission diff) before
  applying; permission escalation always re-prompts.

Permission model:
- Reuse `SERVICE_TOKENS` scopes for backend APIs and the `mcp_permissions` table for
  per-(server, agent, tool) allow/deny. `isToolAllowed` already **defaults to deny**.
- Enforcement moves from display-only to real: filter tools at session build **and**
  gate calls via `AgentSessionHooks.onPermissionRequest` / `onPreToolUse`.
- An extension cannot grant itself permissions; the user approves them.

---

## 6. Security & trust boundaries

- **Two trust tiers.** *Native* extensions are code-reviewed, build-time modules that
  run in-process. *External* extensions run out-of-process; the board only speaks a
  protocol (MCP/HTTP) to them. **No arbitrary third-party code executes inside the main
  server process.**
- **No unrestricted installer.** The board never clones-and-runs a repository.
  AI-assisted analysis (Category E) is read-only and produces a *plan*, not an install.
- **Explicit approval** before any registration, permission grant, or stdio command.
  stdio MCP commands are arbitrary by design (existing trust model) — surface them and
  require approval; do not silently widen this.
- **Embeds** respect the target's `X-Frame-Options`/CSP; prefer opening a link over an
  iframe when embedding is not permitted. Embed origins are allowlisted.
- **Secrets** go through `credentialService` (AES-256-GCM) and are redacted in responses
  and logs. Repo-touching extensions validate paths through `ALLOWED_REPO_ROOTS`.
- **Licensing** is checked during analysis; incompatible licenses flag the integration
  as manual-review-required. Never assume a repo's license permits reuse.

---

## 7. UI integration strategy (Category C)

Current routing is a hardcoded `RouteState` union + `readRoute()` + early-return
if-chain in `App.tsx`. Strategy, in increasing complexity:

1. **Route/nav registry (build-time).** Replace the if-chain with a registry that native
   extensions contribute to (`{ path, component, nav }`). The existing pages become the
   first entries. This is a refactor of existing code, not a new framework.
2. **Panel/slot extension points.** Define slots in `BoardPage` / `AgentPanel` /
   `TaskCard` (e.g. a contextual action, a tab) that native extensions can fill.
3. **External-app view.** A generic `ExternalAppView` renders a link-out button or a
   sandboxed iframe (only when the target allows embedding). No internal state is exposed
   to embedded apps; communication is via explicit, scoped postMessage contracts if needed.
4. **Access contract.** Extension UI receives a narrow, typed API (the `api` client +
   `connectWS` + theme), **not** unrestricted internal state.

**Deliberately deferred:** runtime dynamic code loading / module federation. The Vite
build is static; native extensions are build-time modules. Runtime loading adds
significant security and maintenance cost and is not needed for the reference use case.

---

## 8. Backend extension strategy (Category D)

- Reuse the `createXRouter(deps): Router` factory convention and the repository-interface
  + dual-backend pattern for any extension persistence.
- An extension registry mounts routers for **enabled** backend extensions and calls
  lifecycle hooks (init/shutdown) wired into the existing graceful shutdown.
- Prefer **out-of-process** hosting (an MCP server or separate service) over in-process
  plugins, to avoid arbitrary code in the main server.
- Add new `ServiceScope` values + `requiredScope` mappings for extension APIs; fix the
  existing `/mcp/server` vs `/mcp/servers` prefix overlap first.

---

## 9. AI-assisted repository integration (Category E)

Input: a GitHub repository URL. Pipeline (read-only, approval-gated):

1. **Analyze** stack, capabilities, dependencies, license, maintenance, security posture,
   and integration surfaces (MCP? HTTP API? CLI? embeddable web UI?). This can run as an
   approved agent task through the orchestrations facade (provenance-tracked).
2. **Classify** the feasible integration approach(es): MCP tool extension / external app /
   native adapter / not feasible.
3. **Produce a plan**: a draft manifest, required adapters, requested permissions, license
   notes, and effort estimate.
4. **Identify manual work**: state clearly when a custom adapter must be written.

**Hard rules:** never claim an arbitrary repository can be integrated automatically; never
execute the repository; require explicit approval before any install/permission change.

---

## 10. FlowPlan reference evaluation

FlowPlan (MIT, Tauri desktop + Vite/React web, MCP server at `http://localhost:3100/mcp`,
12 tools: `create_plan`, `add_cards`, `update_card`, `remove_card`, `get_cards`, `get_plan`,
`list_plans`, `clear_plan`, `reorder_cards`, `get_all_feedback`, `answer_feedback`,
`acknowledge_feedback`).

| Approach | Feasibility | Reusable today | Custom work needed |
|---|---|---|---|
| **1. MCP-level integration** | High | Registering a streamable-http MCP server already works (`McpServerConfig`). | MCP→agent-session bridge + permission enforcement (Phase E1) so agents can actually call FlowPlan tools. No FlowPlan code changes. |
| **2. Standalone external visual planner** | High | Link-out to the running FlowPlan app. | External-app registry + link/embed view (Phase E2). Embedding only if its web server permits iframes; the Tauri desktop app cannot be embedded. |
| **3. Optional native planning panel** | Medium | — | Adapting FlowPlan's flow-diagram UI into a native panel. MIT permits it, but it is significant custom development; only if justified. Not automatic. |

**Conclusion:** the architecture supports FlowPlan at the MCP and external-app levels with
reuse of existing infrastructure; a native panel is optional custom work. No FlowPlan code
is copied and no runtime dependency is added.

---

## 11. Incremental implementation phases

- **E0 — Unblock reuse (defect fixes).** Wire `syncEngine` to real repos; fix the
  permissions route param; move GitHub client methods into `api`; fix the scope-prefix
  overlap. These make already-"implemented" features actually work.
- **E1 — MCP tool extensions end-to-end.** MCP→session bridge (SDK `mcpServers`/tools or
  per-provider wiring), real permission enforcement, per-task/group MCP binding. This is
  what makes FlowPlan MCP integration real.
- **E2 — External-app registry + manifest.** `extension.json` schema, register/enable/
  disable/remove, link/embed view. FlowPlan as the first external app.
- **E3 — Native UI + backend extension registry.** Route/nav/panel slots; router-factory
  registry with lifecycle + scopes.
- **E4 — AI-assisted repo analysis → integration plan.** Read-only, approval-gated.

**No marketplace is built at this stage.**

---

## 12. Complexity & maintenance trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Build-time native extensions | Simple, secure, code-reviewed | Requires rebuild; no runtime install |
| Runtime module federation (deferred) | Flexible install | High security + maintenance cost |
| MCP out-of-process hosting | Reuses existing infra; strong isolation | Needs the MCP→session bridge (SDK or per-provider) |
| Declarative manifest | Consistent, tool-agnostic | Schema evolution must be managed |
| Refactor routing to a registry | Enables UI extensions | Touches `App.tsx`; must preserve existing routes/deep-links |

**Guiding principle:** prefer well-defined capability contracts and adapters over copying
whole applications; keep the board independent of any single external tool (including
FlowPlan and Chatai); preserve the existing agent-provider architecture.
