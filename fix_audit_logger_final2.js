const fs = require('fs');
let lines = fs.readFileSync('packages/server/src/services/audit-logger.ts', 'utf8').split('\n');
// Remove line 96 (index 95) which has "auditId: entry.id,"
lines.splice(95, 1);
fs.writeFileSync('packages/server/src/services/audit-logger.ts', lines.join('\n'));
console.log("Removed line 96 (auditId: entry.id)");