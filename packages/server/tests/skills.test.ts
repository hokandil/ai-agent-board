import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { discoverSkills, parseSkillFrontmatter } from '../src/services/skills.js';
import type { Task } from '../src/types.js';

/**
 * Stage D regression tests — local SKILL.md discovery + delivery to supporting agents.
 * Deterministic: temp skills dir + in-memory SQLite + fake providers. No real CLI/network.
 */

function makeSkillsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-skills-'));
  fs.mkdirSync(path.join(root, 'alpha-skill'));
  fs.writeFileSync(path.join(root, 'alpha-skill', 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: Does alpha things.\n---\n\n# Alpha\nBody.');
  fs.mkdirSync(path.join(root, 'beta-skill'));
  fs.writeFileSync(path.join(root, 'beta-skill', 'SKILL.md'),
    '---\nname: beta-skill\ndescription: Does beta things.\n---\n\n# Beta');
  // A directory without SKILL.md must be ignored.
  fs.mkdirSync(path.join(root, 'not-a-skill'));
  fs.writeFileSync(path.join(root, 'not-a-skill', 'README.md'), 'no skill here');
  return root;
}

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

test('parseSkillFrontmatter extracts name/description', () => {
  const { name, description } = parseSkillFrontmatter('---\nname: my-skill\ndescription: "A skill."\n---\nbody');
  assert.equal(name, 'my-skill');
  assert.equal(description, 'A skill.');
  assert.deepEqual(parseSkillFrontmatter('no frontmatter'), {});
});

test('discoverSkills finds SKILL.md dirs and ignores non-skills', () => {
  const root = makeSkillsRoot();
  try {
    const skills = discoverSkills(root);
    assert.deepEqual(skills.map((s) => s.name), ['alpha-skill', 'beta-skill']);
    assert.equal(skills[0].description, 'Does alpha things.');
    assert.ok(skills[0].path.endsWith('SKILL.md'));
    assert.deepEqual(discoverSkills(path.join(root, 'does-not-exist')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function runDelivery(agentType: 'copilot' | 'claude', root: string) {
  const { db, repo } = makeRepo();
  process.env.AGENTBOARD_SKILLS_DIR = root;
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    let captured: any = null;
    const provider = {
      name: agentType, displayName: 'Fake', model: 'fake',
      start: async () => {}, stop: async () => {},
      createSession: async (config: any) => {
        captured = config;
        return { sessionId: 's', execute: async () => ({ status: 'complete' }), send: async () => {}, abort: async () => {}, destroy: async () => {} };
      },
    };
    (manager as any).providers.set(agentType, provider);
    (manager as any).availableAgents = [{ name: agentType, displayName: 'Fake', available: true }];
    const task: Task = {
      id: `task-skill-${agentType}`, projectId: 'default', title: 'Skill task', description: '',
      priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType,
      createdAt: Date.now(), archived: false, useWorktree: false,
    } as Task;
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, async (s) => { seen.push(s); await repo.update(task.id, { agentStatus: s }); });
    const start = Date.now();
    while (!seen.includes('complete') && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 15));
    await new Promise((r) => setTimeout(r, 30));
    return captured;
  } finally {
    delete process.env.AGENTBOARD_SKILLS_DIR;
    db.close();
  }
}

test('skills are delivered to Copilot as skillDirectories', async () => {
  const root = makeSkillsRoot();
  try {
    const captured = await runDelivery('copilot', root);
    assert.ok(captured, 'createSession called');
    assert.deepEqual(captured.skillDirectories, [root], 'Copilot receives the skills root');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skills are delivered to Claude as enabled skill names', async () => {
  const root = makeSkillsRoot();
  try {
    const captured = await runDelivery('claude', root);
    assert.ok(captured, 'createSession called');
    assert.deepEqual(captured.skills, ['alpha-skill', 'beta-skill'], 'Claude receives skill names');
    assert.ok(Array.isArray(captured.settingSources), 'Claude settingSources provided');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
