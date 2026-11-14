const fs = require('fs');
let content = fs.readFileSync('packages/server/src/types.ts', 'utf8');
// Add AgentEventType with audit_log directly (shadows the re-exported one)
content = content.replace(
  "export type {\n  Priority,\n  ColumnId,\n  AgentStatus,\n  AgentType,\n  Task,\n  TaskRelationship,\n  ExecutionAttempt,\n  TaskProvenance,\n  TaskGroup,\n  TaskTemplate,\n  TaskAttachment,\n  Project,\n  ProjectTaskCounts,\n  ProjectConfig,\n  CreateProjectRequest,\n  UpdateProjectRequest,\n  AgentEvent,\n  WSMessage,\n  SessionStatus,\n  AgentSession,\n  CreateSessionRequest,\n  SessionConcurrencyLimits,\n} from '../../../shared/types.js';",
  `export type {
  Priority,
  ColumnId,
  AgentStatus,
  AgentType,
  Task,
  TaskRelationship,
  ExecutionAttempt,
  TaskProvenance,
  TaskGroup,
  TaskTemplate,
  TaskAttachment,
  Project,
  ProjectTaskCounts,
  ProjectConfig,
  CreateProjectRequest,
  UpdateProjectRequest,
  AgentEvent,
  WSMessage,
  SessionStatus,
  AgentSession,
  CreateSessionRequest,
  SessionConcurrencyLimits,
} from '../../../shared/types.js';

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
  | 'audit_log';`
);
fs.writeFileSync('packages/server/src/types.ts', content);
console.log("Added AgentEventType with audit_log to packages/server/src/types.ts");