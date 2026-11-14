const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
content = content.replace(
  "| 'complete'",
  "| 'complete'\n  | 'audit_log'"
);
fs.writeFileSync('shared/types.ts', content);
console.log('Added audit_log to AgentEventType');