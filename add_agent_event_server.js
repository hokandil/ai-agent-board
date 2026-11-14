const fs = require('fs');
let content = fs.readFileSync('packages/server/src/types.ts', 'utf8');
// Check if AgentEventType is already defined locally
if (content.includes('export type AgentEventType')) {
  console.log('AgentEventType already defined locally');
} else {
  // Add it after the imports section (after the last import line)
  const lastImportIdx = content.lastIndexOf("from '../../../shared/types.js'");
  if (content.indexOf('from') >= 0) {
    const lastImportLine = content.lastIndexOf('\n', content.lastIndexOf('from'));
    const insertPos = lastImportIdx >= 0 ? lastImportIdx + 1 : content.indexOf('\n\n', content.indexOf('import'));
    const agentTypeDecl = `
export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
  | 'error'
  | 'complete'
  | 'audit_log';

`;
    content = content.slice(0, insertPos) + agentTypeDecl + content.slice(insertPos);
    fs.writeFileSync('packages/server/src/types.ts', content);
    console.log('Added AgentEventType to packages/server/src/types.ts');
  }
}