import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitSpawnTarget, isGitWorkTree, validateRepoPath } from '../src/routes/helpers.js';

// Windows-only regression coverage for the git executable resolution used by
// repo detection. On Windows, execFile cannot spawn .cmd/.bat shims, so the
// board resolves a real git.exe from PATH and otherwise falls back to running
// git through the command processor.

const isWindows = process.platform === 'win32';

function createFixtureBin(testName: string): { binDir: string; cleanup: () => void } {
  const fixtureRoot = path.join(
    process.cwd(),
    'test-results',
    'git-spawn-target',
    `${process.pid}-${Date.now()}-${testName}`,
  );
  const binDir = path.join(fixtureRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  return {
    binDir,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

function createRepoFixture(): { repoPath: string; dispose: () => void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-git-detect-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'agentboard-tests@example.invalid']);
  git(['config', 'user.name', 'Agent Board Tests']);
  writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'base']);
  return {
    repoPath,
    dispose: () => rmSync(repoPath, { recursive: true, force: true }),
  };
}

/** Run `fn` with PATH replaced by `value`, restoring the original PATH after. */
function withPath<T>(value: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/** A .cmd shim that answers `git rev-parse --is-inside-work-tree` with `answer`. */
function writeGitShim(binDir: string, body: string): void {
  writeFileSync(path.join(binDir, 'git.cmd'), `@echo off\r\n${body}\r\n`);
}

test('git spawn target resolves plain git outside Windows', () => {
  assert.deepEqual(gitSpawnTarget({ PATH: '' }, 'linux'), { file: 'git', prefixArgs: [] });
  assert.deepEqual(gitSpawnTarget({ PATH: '' }, 'darwin'), { file: 'git', prefixArgs: [] });
});

test('git spawn target prefers a real git.exe found on the Windows PATH', (t) => {
  const { binDir, cleanup } = createFixtureBin('git-exe');
  t.after(cleanup);

  const gitExe = path.join(binDir, 'git.exe');
  copyFileSync(process.execPath, gitExe);

  const target = gitSpawnTarget({ PATH: binDir, SystemRoot: process.env.SystemRoot }, 'win32');
  assert.deepEqual(target, { file: gitExe, prefixArgs: [] });
});

test('git spawn target falls back to cmd.exe when the Windows PATH holds only a .cmd shim', (t) => {
  const { binDir, cleanup } = createFixtureBin('git-shim');
  t.after(cleanup);

  writeGitShim(binDir, 'echo true');

  const target = gitSpawnTarget({ PATH: binDir, SystemRoot: process.env.SystemRoot }, 'win32');
  assert.deepEqual(target.prefixArgs, ['/d', '/c', 'git']);
  assert.equal(path.basename(target.file).toLowerCase(), 'cmd.exe');
  assert.ok(
    path.isAbsolute(target.file),
    'cmd.exe must be resolved by absolute path so it stays reachable when PATH holds only the shim directory',
  );
});

test('git spawn target accepts the Windows Path variable casing', () => {
  const target = gitSpawnTarget({ Path: 'C:\\tools' }, 'win32');
  assert.deepEqual(target.prefixArgs, ['/d', '/c', 'git']);
});

test('git spawn target skips PATH entries where git.exe is not a regular file', (t) => {
  const { binDir, cleanup } = createFixtureBin('git-exe-dir');
  t.after(cleanup);

  mkdirSync(path.join(binDir, 'git.exe'));

  const target = gitSpawnTarget({ PATH: binDir, SystemRoot: process.env.SystemRoot }, 'win32');
  assert.deepEqual(target.prefixArgs, ['/d', '/c', 'git']);
});

test('git spawn target falls back to PATH-resolved cmd.exe when System32 is unavailable', () => {
  const target = gitSpawnTarget({ PATH: '', SystemRoot: 'C:\\not-a-real-root' }, 'win32');
  assert.deepEqual(target, { file: 'cmd.exe', prefixArgs: ['/d', '/c', 'git'] });
});

test('isGitWorkTree detects a work tree through a .cmd shim when git.exe is unavailable', { skip: !isWindows }, (t) => {
  const { binDir, cleanup } = createFixtureBin('shim-worktree');
  t.after(cleanup);

  writeGitShim(binDir, 'echo true');
  const repo = createRepoFixture();
  t.after(repo.dispose);

  const detected = withPath(binDir, () => isGitWorkTree(repo.repoPath));
  assert.equal(detected, true);
});

test('isGitWorkTree reports a non-work-tree through a .cmd shim', { skip: !isWindows }, (t) => {
  const { binDir, cleanup } = createFixtureBin('shim-not-worktree');
  t.after(cleanup);

  writeGitShim(binDir, 'echo false');
  const repo = createRepoFixture();
  t.after(repo.dispose);

  const detected = withPath(binDir, () => isGitWorkTree(repo.repoPath));
  assert.equal(detected, false);
});

test('isGitWorkTree returns false when the git executable fails', { skip: !isWindows }, (t) => {
  const { binDir, cleanup } = createFixtureBin('shim-failure');
  t.after(cleanup);

  writeGitShim(binDir, 'exit /b 1');
  const repo = createRepoFixture();
  t.after(repo.dispose);

  const detected = withPath(binDir, () => isGitWorkTree(repo.repoPath));
  assert.equal(detected, false);
});

test('validateRepoPath recognises a git repository when only a .cmd shim is on PATH', { skip: !isWindows }, (t) => {
  const { binDir, cleanup } = createFixtureBin('shim-validate');
  t.after(cleanup);

  writeGitShim(binDir, 'echo true');
  const repo = createRepoFixture();
  t.after(repo.dispose);

  const validation = withPath(binDir, () => validateRepoPath(repo.repoPath));
  assert.equal(validation.valid, true);
  assert.equal(validation.isGitRepo, true);
  assert.equal(validation.warning, undefined);
});

test('validateRepoPath accepts Windows backslash and forward-slash paths', { skip: !isWindows }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentboard-path-style-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const backslashPath = dir.replace(/\//g, '\\');
  const forwardSlashPath = dir.replace(/\\/g, '/');

  const backslash = validateRepoPath(backslashPath);
  const forwardSlash = validateRepoPath(forwardSlashPath);

  assert.equal(backslash.valid, true);
  assert.equal(forwardSlash.valid, true);
  assert.equal(backslash.exists, true);
  assert.equal(backslash.isDirectory, true);
  assert.equal(backslash.repoPath, forwardSlash.repoPath);
});

test('isGitWorkTree accepts a Windows backslash repository path', { skip: !isWindows }, (t) => {
  const repo = createRepoFixture();
  t.after(repo.dispose);

  const backslashPath = repo.repoPath.replace(/\//g, '\\');
  assert.equal(isGitWorkTree(backslashPath), true);
});

test('isGitWorkTree detects a real repository with the platform git', (t) => {
  const repo = createRepoFixture();
  t.after(repo.dispose);

  assert.equal(isGitWorkTree(repo.repoPath), true);
});

test('validateRepoPath flags a directory that is not a git repository', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentboard-not-a-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const validation = validateRepoPath(dir);
  assert.equal(validation.valid, true);
  assert.equal(validation.isDirectory, true);
  assert.equal(validation.isGitRepo, false);
  assert.match(validation.warning ?? '', /not a git repository/);
});
