import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentProvider, AgentSession, AgentSessionConfig, AgentResult } from '@codewithdan/agent-sdk-core';

export class OpenCodeCliProvider implements AgentProvider {
  readonly name = 'opencode' as any;
  readonly displayName = 'OpenCode';
  readonly model: string;
  constructor() {
    this.model = process.env.OPENCODE_MODEL?.trim() || 'configured default';
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new OpenCodeCliSession(config);
  }
}

class OpenCodeCliSession implements AgentSession {
  private aborted = false;
  private child: ReturnType<typeof spawn> | null = null;
  readonly sessionId: string | null = null;
  constructor(private readonly config: AgentSessionConfig) {}
  async execute(prompt: string): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const safePrompt = prompt.replace(/\r?\n+/g, ' ').trim();
      const quotedPrompt = process.platform === 'win32' ? `\"${safePrompt}\"` : safePrompt;
      const args = ['run', '--format', 'json', quotedPrompt];
      const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : 'opencode';
      const spawnArgs = process.platform === 'win32' ? ['/c', 'opencode', ...args] : args;
      const child = spawn(spawnCmd, spawnArgs, { cwd: this.config.workingDirectory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let failed = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'text' && ev.part?.text) {
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'output', content: ev.part.text, timestamp: Date.now() });
            } else if (ev.type === 'step_start') {
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'thinking', content: 'Starting...', timestamp: Date.now() });
            } else if (ev.type === 'error') {
              failed = true;
              this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'error', content: String(ev.error ?? 'OpenCode error'), timestamp: Date.now() });
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
        if (this.aborted) { resolve({ status: 'failed', error: 'aborted' }); return; }
        if (failed || (code !== 0 && code !== null)) {
          this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'error', content: `OpenCode exited with code ${code}`, timestamp: Date.now() });
          resolve({ status: 'failed', error: `OpenCode exited with code ${code}` });
        } else {
          this.config.onEvent({ id: randomUUID(), contextId: this.config.contextId, type: 'complete', content: 'Task completed.', timestamp: Date.now(), metadata: { agentType: 'opencode' as any } });
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