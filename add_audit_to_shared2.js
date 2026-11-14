const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
content = content.replace(
  "| 'complete'",
  "| 'complete'\n  | 'audit_log'"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Added audit_log to shared/types.ts AgentEventType");

// Verify
const content2 = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content2.indexOf("export type AgentEventType");
if (idx >= 0) {
  console.log(content2.substring(idx, idx + 200));
}