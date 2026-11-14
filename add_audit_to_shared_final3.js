const fs = require('fs');
let content = fs.readFileSync('shared/types.ts', 'utf8');
// Add audit_log to AgentEventType - find the AgentEventType block and add audit_log after 'complete'
content = content.replace(
  "export type AgentEventType =\n  | 'thinking'\n  | 'tool_call'\n  | 'file_read'\n  | 'file_write'\n  | 'file_edit'\n  | 'command'\n  | 'command_output'\n  | 'output'\n  | 'test_result'\n  | 'error'\n  | 'complete'",
  "export type AgentEventType =\n  | 'thinking'\n  | 'tool_call'\n  | 'file_read'\n  | 'file_write'\n  | 'file_edit'\n  | 'command'\n  | 'command_output'\n  | 'output'\n  | 'test_result'\n  | 'error'\n  | 'complete'\n  | 'audit_log'"
);
fs.writeFileSync('shared/types.ts', content);
console.log("Added audit_log to AgentEventType in shared/types.ts");

// Verify
const content2 = fs.readFileSync('shared/types.ts', 'utf8');
const idx = content2.indexOf("export type AgentEventType");
if (idx >= 0) {
  console.log(content2.substring(idx, idx + 200));
}