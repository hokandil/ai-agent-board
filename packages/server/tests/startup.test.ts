import assert from 'node:assert/strict';
import test from 'node:test';
import { describeListenError, withStartupTimeout, StartupProgress } from '../src/startup.js';

test('describeListenError gives an actionable EADDRINUSE diagnostic', () => {
  const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  const msg = describeListenError(err, 8080, '127.0.0.1');
  assert.match(msg, /8080/);
  assert.match(msg, /already in use/i);
  assert.match(msg, /orphaned process/i);
  assert.match(msg, /netstat|lsof/i);
});

test('describeListenError handles EACCES and EADDRNOTAVAIL distinctly', () => {
  const eacces = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
  assert.match(describeListenError(eacces, 80, '0.0.0.0'), /permission denied/i);
  const ena = Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
  assert.match(describeListenError(ena, 8080, '10.0.0.99'), /not available/i);
});

test('describeListenError falls back to the raw message for unknown codes', () => {
  const err = Object.assign(new Error('something odd'), { code: 'EWEIRD' });
  const msg = describeListenError(err, 8080, '127.0.0.1');
  assert.match(msg, /something odd/);
  assert.match(msg, /8080/);
});

test('withStartupTimeout resolves when the promise settles in time', async () => {
  const value = await withStartupTimeout(Promise.resolve(42), 1000, 'fast step');
  assert.equal(value, 42);
});

test('withStartupTimeout rejects with a labelled error when the step hangs', async () => {
  const never = new Promise<number>(() => { /* intentionally never settles */ });
  await assert.rejects(
    withStartupTimeout(never, 30, 'agent provider "x" start()'),
    /agent provider "x" start\(\) timed out after 30ms/,
  );
});

test('withStartupTimeout propagates the original rejection', async () => {
  await assert.rejects(
    withStartupTimeout(Promise.reject(new Error('boom')), 1000, 'step'),
    /boom/,
  );
});

test('StartupProgress tracks phases and readiness for the health endpoint', () => {
  const progress = new StartupProgress();
  const initial = progress.health();
  assert.equal(initial.status, 'ok');
  assert.equal(initial.ready, false);
  assert.equal(initial.phase, 'boot');
  assert.ok(typeof initial.uptimeMs === 'number');

  progress.begin('database');
  assert.equal(progress.health().phase, 'database');
  assert.equal(progress.health().ready, false);

  progress.begin('agents');
  assert.equal(progress.health().phase, 'agents');

  progress.markReady();
  const ready = progress.health();
  assert.equal(ready.ready, true);
  assert.equal(ready.phase, 'ready');
});
