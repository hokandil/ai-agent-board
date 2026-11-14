const fs = require('fs');
let content = fs.readFileSync('packages/server/src/services/audit-logger.ts', 'utf8');
content = content.replace(
  '        metadata: {\n        actorType: entry.actorType,\n        action: entry.action,\n        resourceType: entry.resourceType,\n        ...params.metadata,\n      },',
  '        metadata: {\n        ...params.metadata,\n      },'
);
fs.writeFileSync('packages/server/src/services/audit-logger.ts', content);
console.log("Removed actorType/action/resourceType from metadata");