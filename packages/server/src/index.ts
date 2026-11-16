import 'dotenv/config';

// Process-level error handlers to prevent crashes from unhandled agent SDK errors.
process.on('uncaughtException', (err: Error) => {
  console.error('[server] uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
  if (reason instanceof Error) console.error(reason.stack);
});

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createWSS } from './websocket.js';
import { initDatabase, initPostgresDatabase, isPostgresUrl } from './db.js';
import { loadConfig } from './config.js';
import { SqliteTaskRepository } from './repositories/sqlite.js';
import { PostgresTaskRepository } from './repositories/postgres.js';
import { createTaskRouter } from './routes/tasks.js';
import { createAgentRouter } from './routes/agent.js';
import { createGitRouter } from './routes/git.js';
import { createTemplateRouter } from './routes/templates.js';
import { createGroupsRouter } from './routes/groups.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createMcpRouter } from './routes/mcp.js';
import { createMcpSyncRouter } from './routes/mcp-sync.js';
import { createMcpBoardServerRouter } from './routes/mcp-server.js';
import { createAgentProfilesRouter } from './routes/agent-profiles.js';
import { createGitHubRouter } from './routes/github.js';
import { createSessionRouter } from './routes/sessions.js';
import { createPtySessionRouter } from './routes/pty-sessions.js';
import { createProjectsRouter } from './routes/projects.js';
import { createOrchestrationsRouter } from './routes/orchestrations.js';
import type { AttachmentStore } from './repositories/attachment-types.js';
import { AgentManager } from './services/agent-manager.js';
import { AuditLogger } from './services/audit-logger.js';
import { authMiddleware } from './middleware/auth.js';
import type { TaskRepository } from './repositories/types.js';
import type { TemplateRepository } from './repositories/template-types.js';
import type { TaskGroupRepository } from './repositories/group-types.js';
import type { ProjectRepository } from './repositories/project-types.js';
import { startAgentForTask } from './routes/helpers.js';
import { isLoopbackAddress } from './network-policy.js';
import { reconcileManagedWorktrees } from './services/worktree-cleanup.js';
import { describeListenError, StartupProgress } from './startup.js';
import { discoverSkills } from './services/skills.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const startup = new StartupProgress();

// Preview/test mode: skip booting real agent SDK clients AND skip auto-dispatch
// of pending runs so starting the app never launches agents or makes paid API
// calls on its own. Manual agent starts from the UI still work in normal dev.
const skipAgentStartup =
  process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === '1' ||
  process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === 'true';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:4175,http://localhost:4176').split(',');
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '100kb' }));

// API key auth — when API_KEY env var is set, all /api routes require
// Authorization: Bearer *** When unset, auth is skipped (local dev).
app.use('/api', authMiddleware);

const DATABASE_URL = process.env.DATABASE_URL;

let taskRepo: TaskRepository;
let templateRepo: TemplateRepository;
let groupRepo: TaskGroupRepository;
let projectRepo: ProjectRepository;
let attachmentStore: AttachmentStore;
let cleanupDb: () => void;

// Initialize AgentManager
const agentManager = new AgentManager();
let auditLogger: AuditLogger;

(async () => {
  // Load (and create on first run) the Agent Board config + clone root directory.
  startup.begin('config');
  const config = loadConfig();
  console.log(`[server] clone root: ${config.cloneRoot}`);

  startup.begin('database');
  if (isPostgresUrl(DATABASE_URL)) {
    // PostgreSQL backend
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    await initPostgresDatabase(pool);
    taskRepo = new PostgresTaskRepository(pool);
    auditLogger = new AuditLogger(taskRepo);
    const { PostgresProjectRepository } = await import('./repositories/postgres-projects.js');
    projectRepo = new PostgresProjectRepository(pool);
    const { PostgresTemplateRepository } = await import('./repositories/postgres-templates.js');
    templateRepo = new PostgresTemplateRepository(pool);
    const { PostgresTaskGroupRepository } = await import('./repositories/postgres-groups.js');
    groupRepo = new PostgresTaskGroupRepository(pool);
    const { PostgresAttachmentStore } = await import('./repositories/postgres-attachments.js');
    attachmentStore = new PostgresAttachmentStore(pool);
    cleanupDb = () => { pool.end(); };
    console.log('[server] using PostgreSQL backend');
  } else {
    // SQLite fallback
    const db = initDatabase();
    taskRepo = new SqliteTaskRepository(db);
    auditLogger = new AuditLogger(taskRepo);
    const { SqliteProjectRepository } = await import('./repositories/sqlite-projects.js');
    projectRepo = new SqliteProjectRepository(db);
    const { SqliteTemplateRepository } = await import('./repositories/sqlite-templates.js');
    templateRepo = new SqliteTemplateRepository(db);
    const { SqliteTaskGroupRepository } = await import('./repositories/sqlite-groups.js');
    groupRepo = new SqliteTaskGroupRepository(db);
    const { SqliteAttachmentStore } = await import('./repositories/sqlite-attachments.js');
    attachmentStore = new SqliteAttachmentStore(db);
    cleanupDb = () => { db.close(); };
    console.log('[server] using SQLite backend');
  }

  agentManager.initEventPersistence(taskRepo);
  agentManager.initAttachmentStore(attachmentStore);
  // Both repository backends implement MCPRepository; enable MCP delivery to sessions.
  agentManager.initMcpRepository(taskRepo as unknown as import('./repositories/mcp-types.js').MCPRepository);

  startup.begin('worktree-reconciliation');
  try {
    const projects = await projectRepo.getAllWithCounts();
    const tasks = (await Promise.all(projects.map(async (project) => {
      const standalone = await taskRepo.getAll(true, project.id);
      const groups = await groupRepo.getAll(true, project.id);
      const children = (await Promise.all(groups.map((group) => groupRepo.getChildTasks(group.id)))).flat();
      return [...standalone, ...children];
    }))).flat();
    const report = await reconcileManagedWorktrees(
      tasks,
      projects.flatMap((project) => project.repoPath ? [project.repoPath] : []),
      taskRepo,
    );
    if (report.removed.length || report.missing.length || report.blocked.length) {
      console.log(`[worktree] startup reconciliation: ${report.removed.length} removed, ${report.missing.length} missing, ${report.blocked.length} blocked`);
      for (const blocked of report.blocked) {
        console.warn(`[worktree] retained ${blocked.path}: ${blocked.reason}`);
      }
    }
  } catch (err) {
    console.error('[worktree] startup reconciliation failed:', err);
  }

  startup.begin('routes');
  app.use('/api/projects', createProjectsRouter(projectRepo, taskRepo, groupRepo, agentManager));
  app.use('/api/orchestrations', createOrchestrationsRouter(taskRepo, projectRepo, agentManager));
  app.use('/api/tasks', createTaskRouter(taskRepo, agentManager, projectRepo));
  app.use('/api/tasks', createAgentRouter(taskRepo, agentManager, groupRepo, projectRepo));
  app.use('/api/tasks', createGitRouter(taskRepo, agentManager));
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/groups', createGroupsRouter(groupRepo, taskRepo, agentManager, projectRepo));
  app.use('/api', createAttachmentsRouter(taskRepo, attachmentStore));
  app.use('/api/mcp', createMcpRouter(taskRepo as TaskRepository & import('./repositories/mcp-types.js').MCPRepository, agentManager, auditLogger));
  app.use('/api/mcp/sync', createMcpSyncRouter(taskRepo as TaskRepository & import('./repositories/mcp-types.js').MCPRepository & import('./repositories/mcp-sync-types.js').SyncRepository, auditLogger));
  app.use('/api/mcp/server', createMcpBoardServerRouter(taskRepo as TaskRepository & import('./repositories/mcp-types.js').MCPRepository, agentManager, auditLogger));
  app.use('/api/agent-profiles', createAgentProfilesRouter(taskRepo));
  app.use('/api/github', createGitHubRouter(taskRepo as TaskRepository));
  app.use('/api/sessions', createSessionRouter(taskRepo as TaskRepository, agentManager));
  app.use('/api/pty/sessions', createPtySessionRouter());

  // GET /api/agents — list available agents
  app.get('/api/agents', (_req, res) => { res.json(agentManager.getAvailableAgents()); });
  app.post('/api/agents/refresh', async (_req, res, next) => { try { res.json(await agentManager.refresh()); } catch (err) { next(err); } });

  // GET /api/skills — discovered local SKILL.md skills (delivered to supporting agents).
  app.get('/api/skills', (_req, res) => { res.json(discoverSkills()); });

  // Health check (no auth required). Reports startup readiness so a client can
  // distinguish "listening but still initializing" from "fully ready".
  app.get('/api/health', (_req, res) => {
    res.json(startup.health());
  });

  // Global error handler — catches errors forwarded by asyncHandler wrappers
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const server = createServer(app);
  createWSS(server);

  // Harden HTTP keep-alive against connection-reset (ECONNRESET) races: Node's default
  // keepAliveTimeout (5s) can destroy an idle socket just as a client reuses it, which is
  // more likely when the event loop is briefly blocked by synchronous git operations
  // (project creation / repo-status detection). Keep idle connections alive longer than
  // typical client/proxy idle timeouts; headersTimeout must exceed keepAliveTimeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Surface listen failures (e.g. EADDRINUSE from an orphaned process holding
  // the port) as an actionable diagnostic and exit cleanly, instead of staying
  // alive without ever listening (a silent hang).
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[server] FATAL: ${describeListenError(err, PORT, HOST)}`);
    process.exit(1);
  });

  startup.begin('agents');
  await agentManager.initialize();

  startup.begin('recovery');
  // Recover orphaned task groups first — group children get group-aware
  // recovery (planning → idle for re-queue, executing → failed) before the
  // generic fallback below resets everything to failed.
  const groupChildIds = new Set<string>();
  try {
    const allGroups = await groupRepo.getAll();
    for (const group of allGroups) {
      if (group.columnId === 'in-progress') {
        const children = await groupRepo.getChildTasks(group.id);
        for (const child of children) {
          groupChildIds.add(child.id);
          if (child.agentStatus === 'executing') {
            await taskRepo.update(child.id, { agentStatus: 'failed', completedAt: Date.now() });
            await taskRepo.clearRun(child.id);
            console.warn(`[server] recovered orphaned group child ${child.id} "${child.title}" (was executing)`);
          } else if (child.agentStatus === 'planning') {
            // Planning children hadn't started — reset to idle so they can be re-queued
            await taskRepo.update(child.id, { agentStatus: 'idle', startedAt: undefined });
            console.warn(`[server] reset group child ${child.id} "${child.title}" (was planning → idle)`);
          }
        }
        // Check if group should auto-advance after recovery
        const updatedChildren = await groupRepo.getChildTasks(group.id);
        const allDone = updatedChildren.every(c => c.agentStatus === 'complete' || c.agentStatus === 'failed');
        const anyFailed = updatedChildren.some(c => c.agentStatus === 'failed');
        if (allDone && !anyFailed) {
          await groupRepo.update(group.id, { columnId: 'review', completedAt: Date.now() });
          console.warn(`[server] recovered group ${group.id} "${group.title}" → review`);
        }
      }
    }
  } catch (err) {
    console.error('[server] failed to recover groups:', err);
  }

  // Re-dispatch durable requests left unclaimed by a crash. Skipped in
  // preview/test mode so starting the app never auto-launches agents.
  const recoveredRunIds = new Set<string>();
  if (!skipAgentStartup) {
    for (const pending of await taskRepo.getPendingRuns(Date.now())) {
      console.warn(`[server] recovering requested run ${pending.id}`);
      recoveredRunIds.add(pending.id);
      await startAgentForTask(pending, taskRepo, agentManager);
    }
  } else {
    console.log('[server] preview/test mode — skipping auto-dispatch of pending runs');
  }

  // Recover standalone tasks orphaned by a previous server restart.
  // Skip group children (already handled above with group-aware recovery).
  const allTasks = await taskRepo.getAll();
  const orphaned = allTasks.filter(t =>
    (t.agentStatus === 'planning' || t.agentStatus === 'executing')
      && !groupChildIds.has(t.id)
      && !recoveredRunIds.has(t.id)
  );
  for (const task of orphaned) {
    await taskRepo.update(task.id, {
      agentStatus: 'failed',
      completedAt: Date.now(),
    });
    await taskRepo.clearRun(task.id);
    console.warn(`[server] recovered orphaned task ${task.id} "${task.title}" (was ${task.agentStatus})`);
  }

  // Reclaim stale dispatch leases continuously, not only after a restart.
  // Disabled in preview/test mode so no agents are auto-launched.
  let dispatchInterval: NodeJS.Timeout | undefined;
  if (!skipAgentStartup) {
    dispatchInterval = setInterval(() => {
      void (async () => {
        for (const pending of await taskRepo.getPendingRuns()) {
          if (!agentManager.isRunning(pending.id)) {
            await startAgentForTask(pending, taskRepo, agentManager);
          }
        }
      })().catch((err) => console.error('[server] dispatch recovery failed:', err));
    }, 15_000);
    dispatchInterval.unref();
  }

  server.listen(PORT, HOST, () => {
    startup.markReady();
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] WebSocket at ws://${HOST}:${PORT}/ws`);
    if (process.env.API_KEY) {
      console.log('[server] API key authentication enabled');
    } else {
      console.warn('[server] WARNING: No API_KEY set — all endpoints are open without authentication.');
      console.warn('[server] Set the API_KEY environment variable to enable authentication.');
      if (!isLoopbackAddress(server.address())) {
        console.warn('[server] WARNING: effective bind address is not loopback while API_KEY is unset.');
      }
    }
  });

  // Graceful shutdown
  function shutdown() {
    console.log('[server] shutting down...');
    if (dispatchInterval) clearInterval(dispatchInterval);
    agentManager.shutdownAll();
    try { cleanupDb(); } catch (err) { console.error('[server] db cleanup error:', err); }
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.warn('[server] force exit after timeout');
      process.exit(1);
    }, 5_000).unref();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
