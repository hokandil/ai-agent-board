const fs = require('fs');
let lines = fs.readFileSync('packages/server/src/index.ts', 'utf8').split('\n');
let result = [];
for (let i = 0; i < lines.length; i++) {
  // Remove duplicate auditLogger declarations (keep only one per block)
  if (lines[i].includes('const auditLogger = new AuditLogger(taskRepo);')) {
    if (i > 0 && lines[i-1].includes('const auditLogger = new AuditLogger(taskRepo);')) {
      continue; // skip duplicate
    }
    result.push(lines[i]);
    continue;
  }
  result.push(lines[i]);
}
fs.writeFileSync('packages/server/src/index.ts', result.join('\n'));
console.log('Fixed duplicate auditLogger declarations');