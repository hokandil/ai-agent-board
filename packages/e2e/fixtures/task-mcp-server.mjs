#!/usr/bin/env node
/**
 * Deterministic stdio MCP server used by the E2E suite.
 *
 * It exposes listing tools with real JSON Schemas and fixed, read-only data so
 * import behavior (schema-driven arguments, normalization, status mapping,
 * duplicate prevention) can be verified without any external service.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TASKS = [
  {
    id: 'FIX-101',
    title: 'Fix login redirect loop',
    description: 'Users bounce between /login and /home.',
    status: 'open',
    priority: 'high',
  },
  {
    id: 'FIX-102',
    title: 'Add audit log retention setting',
    description: 'Expose retention days in project settings.',
    status: 'in_progress',
    priority: 'medium',
  },
  {
    id: 'FIX-103',
    title: 'Ship docs for MCP sync',
    description: 'Document import and manual linking.',
    status: 'done',
    priority: 'low',
  },
  {
    id: 'FIX-104',
    title: 'Review billing webhook retries',
    description: 'Verify idempotency keys are honored.',
    status: 'in_review',
    priority: 'critical',
  },
  {
    id: 'FIX-105',
    title: 'Unknown status task',
    description: 'External status does not match any known column.',
    status: 'frozen',
  },
];

const server = new Server(
  { name: 'e2e-task-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tasks',
      description: 'List tasks for a project',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug to list' },
          status: {
            type: 'string',
            description: 'Optional status filter',
            enum: ['open', 'in_progress', 'in_review', 'done'],
          },
          limit: { type: 'integer', description: 'Maximum records to return' },
          includeArchived: { type: 'boolean', description: 'Include archived tasks' },
        },
        required: ['project'],
      },
    },
    {
      name: 'search_issues',
      description: 'Search issues by query text',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_status_page',
      description: 'Read a plain-text status page (not a task listing)',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'list_tasks') {
    if (typeof args.project !== 'string' || !args.project.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Input validation error: project is required' }],
      };
    }
    const status = typeof args.status === 'string' ? args.status : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const project = args.project.trim();
    let tasks = TASKS.map((task) => ({ ...task, project }));
    if (status) tasks = tasks.filter((task) => task.status === status);
    if (limit && limit > 0) tasks = tasks.slice(0, limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ project, tasks }, null, 2),
        },
      ],
    };
  }

  if (name === 'search_issues') {
    if (typeof args.query !== 'string' || !args.query.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Input validation error: query is required' }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: {
              items: [
                {
                  key: 'ISSUE-7',
                  summary: `Search match for ${args.query.trim()}`,
                  body: 'Wrapped inside data.items',
                  state: 'open',
                  severity: 'major',
                },
              ],
            },
          }),
        },
      ],
    };
  }

  if (name === 'read_status_page') {
    return {
      content: [{ type: 'text', text: 'All systems operational. Not a task listing.' }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

await server.connect(new StdioServerTransport());
