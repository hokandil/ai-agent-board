const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
// Fix AgentStatus - remove duplicate audit_log entries
content = content.replace(
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'",
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Fixed AgentStatus - removed duplicate audit_log entries");

// Verify
const content2 = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content2.indexOf("export type AgentStatus");
if (idx >= 0) {
  console.log(content2.substring(idx, idx + 100));
}