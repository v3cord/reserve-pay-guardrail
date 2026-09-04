const fs = require('fs');

function fix() {
  ['lib/postgresStore.ts', 'lib/sqliteStore.ts'].forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix default policies
    content = content.replace(/amountCeiling: 50000,\s*category: 'Electronics',\s*allowedMerchants: \['Amazon', 'BestBuy'\],/g, "amountCeiling: 50000,\n        category: 'Electronics',\n        merchantMode: 'allowlist',\n        allowedMerchants: ['Amazon', 'BestBuy'],");
    
    content = content.replace(/if \(!row\) return \{ amountCeiling: 50000, category: 'Electronics', allowedMerchants: \['Amazon', 'BestBuy'\], sessionCap: 100000, version: 1 \};/g, "if (!row) return { amountCeiling: 50000, category: 'Electronics', merchantMode: 'allowlist', allowedMerchants: ['Amazon', 'BestBuy'], sessionCap: 100000, version: 1 };");

    // Fix database SELECT deserialization
    content = content.replace(/version: (row\.version|row\.version_),\s*amountCeiling: (row\.amountCeiling|row\.amountCeiling_),.*?allowedMerchants:.*?\,/gs, (match) => {
       if (match.includes('merchantMode')) return match; // Already fixed
       return match.replace(/allowedMerchants:/, "merchantMode: row.merchantMode || 'unrestricted',\n      allowedMerchants:");
    });

    // Fix SQLite SELECT
    content = content.replace(/version: row\.version,\s*amountCeiling: row\.amountCeiling,\s*category: row\.category,\s*allowedMerchants: JSON\.parse\(row\.allowedMerchantsJson \|\| '\[\]'\),/g, "version: row.version,\n      amountCeiling: row.amountCeiling,\n      category: row.category,\n      merchantMode: row.merchantMode || 'unrestricted',\n      allowedMerchants: JSON.parse(row.allowedMerchantsJson || '[]'),");

    fs.writeFileSync(file, content);
  });
}
fix();
