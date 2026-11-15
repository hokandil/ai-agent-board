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
