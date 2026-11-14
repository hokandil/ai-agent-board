import { execFileSync } from 'child_process';
import type { TaskRepository } from '../repositories/types.js';

/**
 * GitHubService provides read-only access to GitHub Issues, Pull Requests,
 * and CI check status via the `gh` CLI. All operations are read-only - the
 * board never writes to GitHub through this service (PR creation is handled
 * separately via routes/git.ts).
 *
 * All commands use `gh` with `--json` output for reliable parsing.
 * Commands fail gracefully (return empty results) when `gh` is not
 * authenticated or the repository has no GitHub remote.
 */
export class GitHubService {
  private repo: TaskRepository;

  constructor(repo: TaskRepository) {
    this.repo = repo;
  }

  /**
   * Run a `gh` command and parse the JSON output.
   * Returns null if the command fails (e.g., not authenticated, no remote).
   */
  private async ghJson(taskId: string, args: string[]): Promise<any> {
    const task = await this.repo.getById(taskId);
    if (!task || !task.repoPath) return null;

    try {
      const output = execFileSync(
        'gh',
        args,
        {
          cwd: task.repoPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
        },
      );
      const text = output.toString().trim();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Get issues for a task's repository.
   * Returns issues sorted by updated date (most recent first).
   */
  async getIssues(taskId: string, limit = 10): Promise<any[]> {
    const result = await this.ghJson(taskId, [
      'issue', 'list',
      '--json', 'number,title,state,author,createdAt,updatedAt,url,htmlUrl,labels,assignees',
      '--limit', String(limit),
      '--sort', 'updated',
      '--direction', 'desc',
    ]);
    return result || [];
  }

  /**
   * Get pull requests for a task's repository.
   * Returns PRs sorted by updated date (most recent first).
   */
  async getPullRequests(taskId: string, limit = 10): Promise<any[]> {
    const result = await this.ghJson(taskId, [
      'pr', 'list',
      '--json', 'number,title,state,author,createdAt,updatedAt,url,htmlUrl,labels,assignees,reviews,mergeable,isDraft',
      '--limit', String(limit),
      '--sort', 'updated',
      '--direction', 'desc',
    ]);
    return result || [];
  }

  /**
   * Get CI check status for a task's repository.
   * Returns the most recent CI runs.
   */
  async getCIStatus(taskId: string, limit = 10): Promise<any[]> {
    const result = await this.ghJson(taskId, [
      'run', 'list',
      '--json', 'name,status,conclusion,createdAt,url,htmlUrl,headBranch,headSha',
      '--limit', String(limit),
    ]);
    return result || [];
  }

  /**
   * Get detailed information about a specific PR.
   */
  async getPullRequest(taskId: string, prNumber: number): Promise<any> {
    const result = await this.ghJson(taskId, [
      'pr', 'view', String(prNumber),
      '--json', 'number,title,state,author,createdAt,updatedAt,url,htmlUrl,labels,assignees,reviews,mergeable,isDraft,body',
    ]);
    return result || null;
  }

  /**
   * Get detailed information about a specific issue.
   */
  async getIssue(taskId: string, issueNumber: number): Promise<any> {
    const result = await this.ghJson(taskId, [
      'issue', 'view', String(issueNumber),
      '--json', 'number,title,state,author,createdAt,updatedAt,url,htmlUrl,labels,assignees,body',
    ]);
    return result || null;
  }
}
