const fs = require('fs');
let lines = fs.readFileSync('packages/server/src/services/audit-logger.ts', 'utf8').split('\n');
lines[11] = "  | 'task.stop',";
fs.writeFileSync('packages/server/src/services/audit-logger.ts', lines.join('\n'));
console.log('Fixed line 12');