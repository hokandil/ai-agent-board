const fs = require('fs');
const content = fs.readFileSync('shared/types.ts', 'utf8');
console.log('audit_log in shared/types.ts:', content.includes('audit_log'));
const idx = content.indexOf("export type AgentEventType");
if (idx >= 0) {
  console.log(content.substring(idx, idx + 200));
}