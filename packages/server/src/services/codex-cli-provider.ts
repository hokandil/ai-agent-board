import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentProvider, AgentSession, AgentSessionConfig, AgentResult } from '@codewithdan/agent-sdk-core';

export class CodexCliProvider implements AgentProvider {
  readonly name = 'codex' as any;
  readonly displayName = 'OpenAI Codex';
  readonly model: string;
  constructor() {
    this.model = process.env.CODEX_MODEL?.trim() || 'gpt-6.2-sol';
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new CodexCliSession(config);
  }
}

class CodexCliSession implements AgentSession {
  private aborted = false;
  private child: ReturnType<typeof spawn> | null = null;
  readonly sessionId: string | null = null;
  constructor(private readonly config: AgentSessionConfig) {}
  async execute(prompt: string): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const safePrompt = prompt.replace(/\r?\n+/g, ' ').trim();
      const quotedPrompt = process.platform === 'win32' ? `\"${safePrompt}\"` : safePrompt;
      const args = ['exec', '--json', '--skip-git-repo-check', quotedPrompt];
      const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : 'codex';
      const spawnArgs = process.platform === 'win32' ? ['/c', 'codex', ...args] : args;
      const child = spawn(spawnCmd, spawnArgs, { cwd: this.config.workingDirectory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'output', content: ev.item.text ?? '', timestamp: Date.now() });
            } else if (ev.type === 'turn.completed') {
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'complete', content: 'Task completed.', timestamp: Date.now(), metadata: { agentType: 'codex' as any } });
            } else if (ev.type === 'item.completed' && ev.item?.type === 'error') {
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'error', content: ev.item.message ?? 'Codex error', timestamp: Date.now() });
            }
          } catch {
            // ignore non-JSON
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'error', content: text, timestamp: Date.now() });
        }
      });
      child.on('close', (code) => {
        if (this.aborted) {
          resolve({ status: 'failed', error: 'aborted' });
          return;
        }
        if (code !== 0 && code !== null) {
          resolve({ status: 'failed', error: `Codex exited with code ${code}` });
        } else {
          resolve({ status: 'complete' });
        }
      });
      child.on('error', (err) => {
        this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'error', content: err.message, timestamp: Date.now() });
        resolve({ status: 'failed', error: err.message });
      });
    });
  }
  async send(): Promise<void> {}
  async abort(): Promise<void> { this.aborted = true; this.child?.kill(); }
  async destroy(): Promise<void> { this.child?.kill(); }
}