#!/usr/bin/env node
// Applies small, targeted patches to installed third-party packages whose
// upstream fix has not yet been published. Idempotent: safe to re-run.
//
// Each patch is: { package, file (relative to package root), replace, with }.
//
// Patch: @codewithdan/agent-sdk-core @ 0.7.0
//   OpenCode v2 logs "server listening on <url>" but the provider waited for
//   "opencode server listening on <url>", causing a 5s startup timeout and
//   marking OpenCode unavailable (ai-agent-board Stage 1 BL-1).
//   Relax the regex so it matches both v1 ("opencode server listening on")
//   and v2 ("server listening on") startup lines. Verified against the actual
//   opencode v2.0.32 binary.
const fs = require('fs');
const path = require('path');

const PATCHES = [
  {
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/opencode.js',
    replace: 'opencode server listening on',
    with: 'server listening on',
  },
  {
    // Stage C: await the (possibly async) onPermissionRequest hook so the Board can
    // collect an explicit user decision before the ACP agent proceeds. Without await,
    // an interactive hook's Promise is ignored and the request falls through to deny.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/acp-cli-provider.js',
    replace: "session.config.hooks?.onPermissionRequest?.({ kind: hookKind }) ?? { kind: 'denied-by-rules' }",
    with: "(await session.config.hooks?.onPermissionRequest?.({ kind: hookKind })) ?? { kind: 'denied-by-rules' }",
  },
  {
    // Stage C: make the Copilot permission handler async so it can await the Board's
    // interactive decision (the native Copilot SDK awaits this handler).
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: 'const onPermissionRequest = (req) => {',
    with: 'const onPermissionRequest = async (req) => {',
  },
  {
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: 'toCopilotPermissionResult(consumerHooks.onPermissionRequest(req))',
    with: 'toCopilotPermissionResult(await consumerHooks.onPermissionRequest(req))',
  },
  {
    // Stage C: no silent auto-approve. Without an explicit consumer decision, deny.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: 'return COPILOT_APPROVED;',
    with: 'return COPILOT_DENIED;',
  },
  {
    // Stage C2: wire Claude's native canUseTool to the Board's interactive hook. When the
    // hook is present, use permissionMode 'default' so tool use prompts (instead of the
    // wrapper's acceptEdits auto-accept) and canUseTool collects the user's decision.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/claude.js',
    replace: 'permissionMode,',
    with: "permissionMode: config.hooks?.onPermissionRequest ? 'default' : permissionMode, ...(config.hooks?.onPermissionRequest ? { canUseTool: async (toolName, input, opts) => { const d = await config.hooks.onPermissionRequest({ kind: toolName, tool: (opts && opts.title) || toolName }); return d.kind === 'approved' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Permission denied by user' }; } } : {}),",
  },
  {
    // Stage D: forward per-session MCP servers to Copilot's native createSession/resumeSession.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: '...(hooks ? { hooks } : {}),',
    with: '...(hooks ? { hooks } : {}), ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),',
  },
  {
    // Stage D: forward per-session MCP servers to Claude's native query options.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/claude.js',
    replace: '...(spawnFn ? { spawnClaudeCodeProcess: spawnFn } : {}),',
    with: '...(spawnFn ? { spawnClaudeCodeProcess: spawnFn } : {}), ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),',
  },
  {
    // Stage D: prefer per-session MCP servers over provider-level for Hermes (ACP session/new).
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/hermes.js',
    replace: 'mcpServers: options?.mcpServers ?? [],',
    with: 'mcpServers: config.mcpServers ?? options?.mcpServers ?? [],',
  },
  {
    // Stage D: deliver per-session MCP servers for OpenClaw (ACP session/new).
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/openclaw.js',
    replace: 'mcpServers: [],',
    with: 'mcpServers: config.mcpServers ?? [],',
  },
  {
    // Stage D: deliver per-session MCP servers for Grok (ACP session/new).
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/grok.js',
    replace: 'mcpServers: [],',
    with: 'mcpServers: config.mcpServers ?? [],',
  },
  {
    // Stage C2: handle OpenCode permission.updated events interactively. Route the request to
    // the Board hook and respond via the native permission endpoint (once/reject; no allow-all).
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/opencode.js',
    replace: 'mapOpenCodeEvent(sessionId, event, config.contextId, config.onEvent);',
    with: "if (event.type === 'permission.updated' && config.hooks?.onPermissionRequest) { const p = event.properties; (async () => { try { const d = await config.hooks.onPermissionRequest({ kind: p.type, tool: p.title }); await client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: p.id }, body: { response: d.kind === 'approved' ? 'once' : 'reject' } }); } catch {} })(); } else { mapOpenCodeEvent(sessionId, event, config.contextId, config.onEvent); }",
  },
  {
    // Stage D: forward skill directories to Copilot's native session config.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: 'streaming: true,',
    with: 'streaming: true, ...(config.skillDirectories ? { skillDirectories: config.skillDirectories } : {}),',
  },
  {
    // Stage D: forward skills + settingSources to Claude's native query options.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/claude.js',
    replace: 'cwd: config.workingDirectory,',
    with: 'cwd: config.workingDirectory, ...(config.skills ? { skills: config.skills, settingSources: config.settingSources } : {}),',
  },
  {
    // Stage E: deliver per-session model override to Copilot.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/copilot.js',
    replace: '...(this.modelOverride ? { model: this.modelOverride } : {})',
    with: '...(config.model || this.modelOverride ? { model: config.model || this.modelOverride } : {})',
  },
  {
    // Stage E: deliver per-session model override to Claude.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/claude.js',
    replace: 'const model = this.modelOverride;',
    with: 'const model = config.model || this.modelOverride;',
  },
  {
    // Stage E: deliver per-session model override to Codex.
    package: '@codewithdan/agent-sdk-core',
    file: 'dist/providers/codex.js',
    replace: '...(this.modelOverride ? { model: this.modelOverride } : {})',
    with: '...(config.model || this.modelOverride ? { model: config.model || this.modelOverride } : {})',
  },
];

const repoRoot = path.resolve(__dirname, '..');
let applied = 0;

for (const patch of PATCHES) {
  const target = path.join(repoRoot, 'node_modules', patch.package, patch.file);
  if (!fs.existsSync(target)) {
    console.error(`[patch] not found: ${target} (skipping)`);
    continue;
  }
  let content = fs.readFileSync(target, 'utf8');
  // Self-overlapping patches (the replacement still contains the anchor) would re-match
  // on every run; treat the presence of the full replacement as already-applied.
  if (patch.with.includes(patch.replace) && content.includes(patch.with)) {
    console.log(`[patch] already applied: ${patch.package}#${patch.file}`);
    continue;
  }
  if (!content.includes(patch.replace)) {
    if (content.includes(patch.with)) {
      console.log(`[patch] already applied: ${patch.package}#${patch.file}`);
      continue;
    }
    console.error(`[patch] anchor not found: ${patch.package}#${patch.file} (${JSON.stringify(patch.replace)})`);
    process.exit(1);
  }
  content = content.replace(new RegExp(patch.replace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), patch.with);
  fs.writeFileSync(target, content);
  applied += 1;
  console.log(`[patch] applied: ${patch.package}#${patch.file}`);
}

console.log(`[patch] done: ${applied} patch(es) applied.`);
