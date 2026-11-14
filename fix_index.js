const fs = require('fs');
let lines = fs.readFileSync('packages/server/src/index.ts', 'utf8').split('\n');
lines[71] = "    const auditLogger = new AuditLogger(taskRepo);";
lines[72] = "    const { PostgresProjectRepository } = await import('./repositories/postgres-projects.js');";
fs.writeFileSync('packages/server/src/index.ts', lines.join('\n'));
console.log('Fixed lines 71-72');