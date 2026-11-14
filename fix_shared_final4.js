const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
// Remove all audit_log lines from AgentStatus - keep only up to 'complete'
content = content.replace(
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'\n  | 'audit_log'",
  "export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Done");
const content2 = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content2.indexOf("export type AgentStatus");
if (idx >= 0) {
  console.log(content2.substring(idx, idx + 100));
}