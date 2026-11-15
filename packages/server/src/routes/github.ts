import { Router, Request, Response } from 'express';
import type { TaskRepository } from '../repositories/types.js';
import { GitHubService } from '../services/github-service.js';
import { asyncHandler } from './helpers.js';

export function createGitHubRouter(repo: TaskRepository): Router {
  const router = Router();
  const ghService = new GitHubService(repo);

  // GET /api/github/tasks/:id/issues - List GitHub issues for a task's repo
  router.get('/tasks/:id/issues', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const limit = parseInt(req.query.limit as string || '10', 10);
    const issues = await ghService.getIssues(id, limit);
    res.json({ issues });
  }));

  // GET /api/github/tasks/:id/pulls - List GitHub PRs for a task's repo
  router.get('/tasks/:id/pulls', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const limit = parseInt(req.query.limit as string || '10', 10);
    const prs = await ghService.getPullRequests(id, limit);
    res.json({ pullRequests: prs });
  }));

  // GET /api/github/tasks/:id/ci - List CI check runs for a task's repo
  router.get('/tasks/:id/ci', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const limit = parseInt(req.query.limit as string || '10', 10);
    const runs = await ghService.getCIStatus(id, limit);
    res.json({ ciRuns: runs });
  }));

  // GET /api/github/tasks/:id/issues/:issueNumber - Get a specific issue
  router.get('/tasks/:id/issues/:issueNumber', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const issueNumber = parseInt(req.params.issueNumber as string, 10);
    const issue = await ghService.getIssue(id, issueNumber);
    if (!issue) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json(issue);
  }));

  // GET /api/github/tasks/:id/pulls/:prNumber - Get a specific PR
  router.get('/tasks/:id/pulls/:prNumber', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const prNumber = parseInt(req.params.prNumber as string, 10);
    const pr = await ghService.getPullRequest(id, prNumber);
    if (!pr) {
      res.status(404).json({ error: 'Pull request not found' });
      return;
    }
    res.json(pr);
  }));

  return router;
}
