import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractTaskRecords,
  externalSourceForServer,
  mapExternalPriority,
  mapExternalStatus,
  normalizeExternalTask,
  rankListingTools,
} from '../src/services/mcp-import.js';
import type { MCPTool } from '../src/types.js';

/**
 * Generic import helpers. These fixtures use common external-record shapes
 * (short ids, envelopes, prose results) rather than any one vendor's API.
 */

test('normalizeExternalTask accepts short external ids and maps fields', () => {
  const task = normalizeExternalTask({
    short_id: 'TASK-42',
    title: 'Import capability',
    body: 'Details',
    status: 'in_progress',
    priority: 'P0',
  });
  assert.ok(task);
  assert.equal(task.externalKey, 'TASK-42');
  assert.equal(task.title, 'Import capability');
  assert.equal(task.description, 'Details');
  assert.equal(task.columnId, 'in-progress');
  assert.equal(task.boardPriority, 'critical');
});

test('normalizeExternalTask requires both an id and a title', () => {
  assert.equal(normalizeExternalTask({ title: 'No id' }), undefined);
  assert.equal(normalizeExternalTask({ id: 'X-1' }), undefined);
  assert.equal(normalizeExternalTask({ id: 'X-1', summary: 'Alias title' })?.title, 'Alias title');
});

test('status and priority mapping never invent done/review states', () => {
  assert.equal(mapExternalStatus('closed'), 'done');
  assert.equal(mapExternalStatus('in_review'), 'review');
  assert.equal(mapExternalStatus('doing'), 'in-progress');
  assert.equal(mapExternalStatus('frozen'), 'backlog');
  assert.equal(mapExternalStatus(undefined), 'backlog');

  assert.equal(mapExternalPriority('P0'), 'critical');
  assert.equal(mapExternalPriority('major'), 'high');
  assert.equal(mapExternalPriority('P4'), 'low');
  assert.equal(mapExternalPriority('unknown-label'), 'medium');
  assert.equal(mapExternalPriority(undefined), 'medium');
});

test('extractTaskRecords walks JSON text envelopes', () => {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ data: { items: [{ key: 'ISSUE-7', summary: 'Nested' }] } }),
      },
    ],
  };
  const found = extractTaskRecords(result);
  assert.ok(found);
  assert.equal(found.location, 'content[0].text.data.items');
  assert.equal(found.records.length, 1);
  assert.equal(normalizeExternalTask(found.records[0])?.externalKey, 'ISSUE-7');
});

test('extractTaskRecords reads structuredContent before text', () => {
  const found = extractTaskRecords({
    structuredContent: { tasks: [{ id: 'A-1', title: 'Structured' }] },
    content: [{ type: 'text', text: JSON.stringify({ tasks: [{ id: 'B-1', title: 'Text' }] }) }],
  });
  assert.ok(found);
  assert.equal(found.location, 'structuredContent.tasks');
  assert.equal(found.records[0].id, 'A-1');
});

test('extractTaskRecords ignores plain-text and transport envelopes', () => {
  assert.equal(
    extractTaskRecords({ content: [{ type: 'text', text: 'All systems operational.' }] }),
    undefined,
  );
  assert.equal(extractTaskRecords({ content: [{ type: 'text', text: 'Not JSON' }] }), undefined);
  assert.equal(extractTaskRecords({ content: [] }), undefined);
});

test('rankListingTools prefers listing/task tools but keeps every tool', () => {
  const tools: MCPTool[] = [
    { name: 'read_status_page', description: 'Read a status page', inputSchema: {} },
    { name: 'write_note', description: 'Write a note', inputSchema: {} },
    { name: 'list_tasks', description: 'List project tasks', inputSchema: {} },
  ];
  const ranked = rankListingTools(tools);
  assert.equal(ranked[0].name, 'list_tasks');
  assert.equal(ranked.length, 3);
});

test('externalSourceForServer produces a stable slug', () => {
  assert.equal(externalSourceForServer('Stele MCP'), 'mcp:stele-mcp');
  assert.equal(externalSourceForServer('***'), 'mcp:server');
});
