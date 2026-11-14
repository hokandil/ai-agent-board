const fs = require('fs');
let content = fs.readFileSync('packages/server/src/types.ts', 'utf8');
content = content.replace(
  "| 'complete'",
  "| 'complete'\n  | 'audit_log'"
);
fs.writeFileSync('packages/server/src/types.ts', content);
console.log("Added audit_log to AgentEventType in packages/server/src/types.ts");