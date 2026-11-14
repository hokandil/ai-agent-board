const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
// Add audit_log to AgentEventType - insert after "| 'complete'" line
content = content.replace(
  "| 'complete'\n",
  "| 'complete'\n  | 'audit_log'\n"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Added audit_log to AgentEventType in shared/types.ts");

// Verify
const content2 = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content2.indexOf("export type AgentEventType");
if (idx >= 0) {
  console.log(content2.substring(idx, idx + 200));
}