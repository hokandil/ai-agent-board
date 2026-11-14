const fs = require('fs');
let content = fs.readFileSync('packages/server/src/index.ts', 'utf8');
// Add import for AuditLogger after worktree-cleanup import
content = content.replace(
  "import { reconcileManagedWorktrees } from './services/worktree-cleanup.js';",
  "import { reconcileManagedWorktrees } from './services/worktree-cleanup.js';\nimport { AuditLogger } from './services/audit-logger.js';"
);
// Add audit logger initialization after agentManager creation
content = content.replace(
  "const agentManager = new AgentManager();",
  "const agentManager = new AgentManager();\nconst auditLogger = new AuditLogger(taskRepo);"
);
fs.writeFileSync('packages/server/src/index.ts', content);
console.log('Added audit logger import and init');