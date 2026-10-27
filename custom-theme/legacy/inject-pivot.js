/**
 * PivotAI Theme Injection Script
 * Run inside the lobechat container to inject theme into all server-rendered HTML files.
 * Usage: node /app/inject-pivot.js
 */
const fs = require('fs');
const path = require('path');

const THEME_INJECT = `<link rel="stylesheet" href="/pivot-theme.css" data-pivot="true"/><script src="/pivot-theme.js" defer data-pivot="true"></script>`;

function findHtmlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) results.push(...findHtmlFiles(p));
    else if (f.endsWith('.html')) results.push(p);
  }
  return results;
}

const htmlDir = '/app/.next/server/app';
const htmlFiles = findHtmlFiles(htmlDir);
console.log(`Found ${htmlFiles.length} HTML files to process...`);

let injectedCount = 0;
let skippedCount = 0;

for (const file of htmlFiles) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('data-pivot="true"')) {
    skippedCount++;
    continue;
  }
  content = content.replace('</head>', THEME_INJECT + '</head>');
  fs.writeFileSync(file, content);
  injectedCount++;
}

console.log(`Injected into: ${injectedCount} files`);
console.log(`Already injected (skipped): ${skippedCount} files`);

// Also ensure pivot-theme.css and pivot-theme.js are in public
if (!fs.existsSync('/app/public/pivot-theme.css')) {
  fs.copyFileSync('/app/pivot-theme.css', '/app/public/pivot-theme.css');
  console.log('Copied pivot-theme.css to public');
}
if (!fs.existsSync('/app/public/pivot-theme.js')) {
  fs.copyFileSync('/app/pivot-theme.js', '/app/public/pivot-theme.js');
  console.log('Copied pivot-theme.js to public');
}

// ALSO inject into the server-side RSC render manifests for root HTML served dynamically
// Patch the RSC HTML that Next.js generates from server components
const serverAppDir = '/app/.next/server/app';
const rscPatchTarget = `${serverAppDir}/[variants]`;
if (fs.existsSync(rscPatchTarget)) {
  console.log('RSC variants dir exists - HTML already patched via file scan above.');
}

console.log('Done! PivotAI Theme injection complete.');
