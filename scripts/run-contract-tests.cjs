const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(name, command, args) {
  console.log(`==> ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Resolve an npm invocation that child_process can actually spawn. On Windows,
 * Node refuses to spawn a .cmd shim without a shell (spawnSync fails with
 * EINVAL), so run the npm CLI entry point with the current Node binary instead
 * and fall back to the command processor when it cannot be located.
 */
function npmInvocation(args) {
  if (process.platform !== 'win32') return { file: 'npm', args };
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) return { file: process.execPath, args: [npmCli, ...args] };
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] };
}

const serverTests = npmInvocation(['test', '-w', '@ai-agent-board/server']);
run('Run server contract tests', serverTests.file, serverTests.args);

const pythonCandidates = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]];
let python;
for (const [command, prefix] of pythonCandidates) {
  const probe = spawnSync(command, [...prefix, '--version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) {
    python = { command, prefix };
    break;
  }
}
if (!python) {
  console.error('Python 3 is required for Hermes integration tests');
  process.exit(1);
}
run('Run Hermes integration tests', python.command, [
  ...python.prefix,
  '-m', 'unittest', 'discover', '-s', 'integrations/hermes-agent-board/tests', '-v',
]);
