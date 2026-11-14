const fs = require('fs');
const content = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content.indexOf("export type AgentStatus");
if (idx >= 0) {
  console.log(content.substring(idx, idx + 100));
}
console.log("audit_log in AgentStatus:", content.includes("AgentStatus = 'idle' | 'planning' | 'executing' | 'complete'\n  | 'audit_log'"));