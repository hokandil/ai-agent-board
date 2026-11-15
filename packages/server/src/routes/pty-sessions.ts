import { Router, Request, Response } from 'express';
import { ptySessionManager } from '../services/pty-session.js';
import { asyncHandler } from './helpers.js';

export function createPtySessionRouter(): Router {
  const router = Router();

  // POST /api/pty/sessions — create a new PTY session
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const { cwd, cols, rows, env, name } = req.body;

    const session = ptySessionManager.createSession({
      cwd,
      cols: cols || 80,
      rows: rows || 24,
      env,
      name,
    });

    res.status(201).json(session);
  }));

  // GET /api/pty/sessions — list all PTY sessions
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const sessions = ptySessionManager.getAllSessionInfo();
    res.json(sessions);
  }));

  // GET /api/pty/sessions/:id — get session info
  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = ptySessionManager.getSessionInfo(id);
    if (!session) {
      res.status(404).json({ error: 'PTY session not found' });
      return;
    }
    res.json(session);
  }));

  // POST /api/pty/sessions/:id/input — send input to a PTY session
  router.post('/:id/input', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { data } = req.body;

    if (!data || typeof data !== 'string') {
      res.status(400).json({ error: 'data is required and must be a string' });
      return;
    }

    const sent = ptySessionManager.sendInput(id, data);
    if (!sent) {
      res.status(404).json({ error: 'PTY session not found or closed' });
      return;
    }

    res.json({ sent: true });
  }));

  // POST /api/pty/sessions/:id/resize — resize a PTY session
  router.post('/:id/resize', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { cols, rows } = req.body;

    if (!cols || !rows || typeof cols !== 'number' || typeof rows !== 'number') {
      res.status(400).json({ error: 'cols and rows are required and must be numbers' });
      return;
    }

    const resized = ptySessionManager.resize(id, cols, rows);
    if (!resized) {
      res.status(404).json({ error: 'PTY session not found or closed' });
      return;
    }

    res.json({ resized: true });
  }));

  // POST /api/pty/sessions/:id/kill — kill a PTY session
  router.post('/:id/kill', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { signal } = req.body;

    const killed = ptySessionManager.kill(id, signal);
    if (!killed) {
      res.status(404).json({ error: 'PTY session not found or closed' });
      return;
    }

    res.json({ killed: true });
  }));

  // DELETE /api/pty/sessions/:id — destroy a PTY session
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const destroyed = ptySessionManager.close(id);
    if (!destroyed) {
      res.status(404).json({ error: 'PTY session not found or closed' });
      return;
    }
    res.status(204).end();
  }));

  return router;
}
