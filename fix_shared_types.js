const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
// Fix AgentStatus - it should NOT include audit_log
content = content.replace(
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'",
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Fixed AgentStatus - removed duplicate audit_log entries");