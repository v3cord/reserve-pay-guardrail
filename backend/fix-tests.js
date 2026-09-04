const fs = require('fs');
const glob = require('glob');

function fix() {
  const files = [
    'lib/postgresStore.ts',
    'lib/sqliteStore.ts',
    ...glob.sync('lib/__tests__/**/*.ts'),
    ...glob.sync('tests/**/*.ts')
  ];

  files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Add merchantMode: 'unrestricted' or 'allowlist' to mock policies
    content = content.replace(/allowedMerchants:\s*\[\]/g, "merchantMode: 'unrestricted', allowedMerchants: []");
    content = content.replace(/allowedMerchants:\s*\[([^\]]+)\]/g, "merchantMode: 'allowlist', allowedMerchants: [$1]");
    
    // Fix the specific row returning logic in stores
    content = content.replace(/id: row\.id,\s*version: row\.version,\s*amountCeiling: row\.amountCeiling,\s*category: row\.category,\s*allowedMerchants:/g, 
    "id: row.id,\n      version: row.version,\n      amountCeiling: row.amountCeiling,\n      category: row.category,\n      merchantMode: row.merchantMode || 'unrestricted',\n      allowedMerchants:");

    content = content.replace(/id: (row\.id|policyRow\.id),\s*version: (row\.version_|policyRow\.version),\s*amountCeiling: (row\.amountCeiling_|policyRow\.amountCeiling),\s*category: (row\.category|policyRow\.category),\s*allowedMerchants:/g, 
    "id: $1,\n      version: $2,\n      amountCeiling: $3,\n      category: $4,\n      merchantMode: $1 === 'row.id' ? (row.merchantMode || 'unrestricted') : (policyRow.merchantMode || 'unrestricted'),\n      allowedMerchants:");

    fs.writeFileSync(file, content);
  });
}
fix();
