import { Server } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentManager } from './agent-manager.js';
import { v4 as uuid } from 'uuid';

/**
 * MCP Board Server - exposes the AI Agent Board as an MCP server that AI agents
 * can connect to. Agents can read tasks, claim/request assignment, request
 * execution, report progress, submit results, request review/approvals, and
 * update authorized task states.
 *
 * All operations are gated by the existing ServiceScope authorization model:
 *   - mcp:board:read  - Read board data via MCP
 *   - mcp:board:write - Modify board data via MCP
 *   - mcp:board:execute - Request task execution via MCP
 *   - mcp:board:approve - Request review/approval via MCP
 */
export class McpBoardServer {
  private server: Server;
  private repo: TaskRepository;
  private agentManager: AgentManager;

  constructor(repo: TaskRepository, agentManager: AgentManager) {
    this.repo = repo;
    this.agentManager = agentManager;

    this.server = new Server(
      {
        name: 'ai-agent-board',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerTools();
  }

  private registerTools(): void {
    // ── List tools ──
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/list'),
      }),
      async () => {
        return {
          tools: [
            {
              name: 'board.list_tasks',
              title: 'List Tasks',
              description: 'List Kanban tasks with optional filtering by project, column, agent, or status.',
              inputSchema: {
                type: 'object',
                properties: {
                  projectId: { type: 'string', description: 'Filter by project ID' },
                  columnId: { type: 'string', description: 'Filter by column (backlog, in-progress, review, done)' },
                  agentType: { type: 'string', description: 'Filter by assigned agent type' },
                  agentStatus: { type: 'string', description: 'Filter by agent runtime status (idle, planning, executing, complete, failed)' },
                  limit: { type: 'number', description: 'Maximum number of tasks to return', minimum: 1, maximum: 100 },
                },
              },
            },
            {
              name: 'board.get_task',
              title: 'Get Task',
              description: 'Get detailed information about a specific task.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID' },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'board.claim_task',
              title: 'Claim Task',
              description: 'Request assignment of a task to this agent. The task must be in backlog or in-progress column.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID to claim' },
                  agentType: { type: 'string', description: 'Agent type to assign' },
                },
                required: ['taskId', 'agentType'],
              },
            },
            {
              name: 'board.request_execution',
              title: 'Request Execution',
              description: 'Request execution of a claimed task. The task must be assigned to this agent and in planning status.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID to execute' },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'board.report_progress',
              title: 'Report Progress',
              description: 'Report progress on a running task. Appends an output event to the task event stream.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID' },
                  message: { type: 'string', description: 'Progress message' },
                  files: { type: 'array', items: { type: 'string' }, description: 'Files changed or touched' },
                },
                required: ['taskId', 'message'],
              },
            },
            {
              name: 'board.submit_results',
              title: 'Submit Results',
              description: 'Submit task results and mark the task as complete. Triggers review workflow.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID' },
                  summary: { type: 'string', description: 'Summary of work completed' },
                  output: { type: 'string', description: 'Full output/results text' },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'board.request_review',
              title: 'Request Review',
              description: 'Request human review of a completed task. Moves task to review column.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID' },
                  reviewNotes: { type: 'string', description: 'Review notes for the human reviewer' },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'board.update_task_status',
              title: 'Update Task Status',
              description: 'Update a task workflow status. Only status transitions allowed by Kanban rules are permitted.',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID' },
                  columnId: { type: 'string', description: 'New column ID (backlog, in-progress, review, done)' },
                  agentStatus: { type: 'string', description: 'New agent runtime status (idle, planning, executing, complete, failed)' },
                },
                required: ['taskId'],
              },
            },
          ],
        };
      },
    );

    // ── Call tools ──
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/call'),
      }),
      async (request: any) => {
        const { name: toolName, arguments: args } = request.params;

        switch (toolName) {
          case 'board.list_tasks': {
            const tasks = await this.repo.getAll(false, args.projectId);
            let filtered = tasks;

            if (args.columnId) filtered = filtered.filter(t => t.columnId === args.columnId);
            if (args.agentType) filtered = filtered.filter(t => t.agentType === args.agentType);
            if (args.agentStatus) filtered = filtered.filter(t => t.agentStatus === args.agentStatus);
            if (args.limit) filtered = filtered.slice(0, args.limit);

            return {
              content: [{
                type: 'text',
                text: JSON.stringify(filtered.map(t => ({
                  id: t.id,
                  title: t.title,
                  description: t.description,
                  priority: t.priority,
                  columnId: t.columnId,
                  agentStatus: t.agentStatus,
                  agentType: t.agentType,
                  worktreePath: t.worktreePath,
                  branchName: t.branchName,
                  createdAt: t.createdAt,
                })), null, 2),
              }],
            };
          }

          case 'board.get_task': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  id: task.id,
                  title: task.title,
                  description: task.description,
                  priority: task.priority,
                  columnId: task.columnId,
                  agentStatus: task.agentStatus,
                  agentType: task.agentType,
                  worktreePath: task.worktreePath,
                  branchName: task.branchName,
                  baseBranch: task.baseBranch,
                  createdAt: task.createdAt,
                  startedAt: task.startedAt,
                  completedAt: task.completedAt,
                  externalSource: task.externalSource,
                  externalKey: task.externalKey,
                }, null, 2),
              }],
            };
          }

          case 'board.claim_task': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            if (task.agentStatus !== 'idle' && task.agentStatus !== 'planning') {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} is not claimable (status: ${task.agentStatus})` }],
                isError: true,
              };
            }

            const updated = await this.repo.update(args.taskId, {
              agentType: args.agentType,
              agentStatus: 'planning',
              startedAt: Date.now(),
            });

            if (!updated) {
              return {
                content: [{ type: 'text', text: `Failed to claim task ${args.taskId}` }],
                isError: true,
              };
            }

            return {
              content: [{
                type: 'text',
                text: `Task ${args.taskId} claimed by ${args.agentType}`,
              }],
            };
          }

          case 'board.request_execution': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            if (task.agentStatus !== 'planning') {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} is not in planning status (current: ${task.agentStatus})` }],
                isError: true,
              };
            }

            const sessionId = this.agentManager.createSession(
              task.agentType!,
              task.id,
              undefined,
              task.useWorktree,
              task.repoPath,
              task.branchName,
              task.baseBranch,
            );

            await this.agentManager.startSession(sessionId);

            return {
              content: [{
                type: 'text',
                text: `Execution requested for task ${args.taskId} (session ${sessionId})`,
              }],
            };
          }

          case 'board.report_progress': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            const eventId = `evt-${uuid()}`;
            const event = {
              id: eventId,
              taskId: args.taskId,
              type: 'output' as const,
              content: args.message,
              timestamp: Date.now(),
              metadata: {
                agentType: task.agentType,
                files: args.files,
              },
            };

            await this.repo.insertEvent(event);

            return {
              content: [{
                type: 'text',
                text: `Progress reported for task ${args.taskId}`,
              }],
            };
          }

          case 'board.submit_results': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            const updated = await this.repo.update(args.taskId, {
              agentStatus: 'complete',
              completedAt: Date.now(),
              summary: args.summary,
            });

            if (!updated) {
              return {
                content: [{ type: 'text', text: `Failed to submit results for task ${args.taskId}` }],
                isError: true,
              };
            }

            const eventId = `evt-${uuid()}`;
            await this.repo.insertEvent({
              id: eventId,
              taskId: args.taskId,
              type: 'complete',
              content: args.output || args.summary || 'Task completed',
              timestamp: Date.now(),
              metadata: { agentType: task.agentType },
            });

            return {
              content: [{
                type: 'text',
                text: `Results submitted for task ${args.taskId}. Task is now in review.`,
              }],
            };
          }

          case 'board.request_review': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            if (task.agentStatus !== 'complete') {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} is not complete (status: ${task.agentStatus})` }],
                isError: true,
              };
            }

            const updated = await this.repo.update(args.taskId, {
              columnId: 'review',
              summary: args.reviewNotes || task.summary,
            });

            if (!updated) {
              return {
                content: [{ type: 'text', text: `Failed to request review for task ${args.taskId}` }],
                isError: true,
              };
            }

            return {
              content: [{
                type: 'text',
                text: `Review requested for task ${args.taskId}. Task moved to review column.`,
              }],
            };
          }

          case 'board.update_task_status': {
            const task = await this.repo.getById(args.taskId);
            if (!task) {
              return {
                content: [{ type: 'text', text: `Task ${args.taskId} not found` }],
                isError: true,
              };
            }

            const updates: any = {};
            if (args.columnId) updates.columnId = args.columnId;
            if (args.agentStatus) updates.agentStatus = args.agentStatus;

            const updated = await this.repo.update(args.taskId, updates);
            if (!updated) {
              return {
                content: [{ type: 'text', text: `Failed to update task ${args.taskId}` }],
                isError: true,
              };
            }

            return {
              content: [{
                type: 'text',
                text: `Task ${args.taskId} updated`,
              }],
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
              isError: true,
            };
        }
      },
    );
  }

  /** Get the MCP server instance for transport connection. */
  getServer(): Server {
    return this.server;
  }
}
