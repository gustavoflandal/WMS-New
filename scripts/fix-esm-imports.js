#!/usr/bin/env node
/**
 * Fix ESM imports by adding .js extensions to local module imports
 * Solves: Cannot find module without .js in ESM
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist', 'apps', 'backend');

function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.map')) {
      callback(fullPath);
    }
  }
}

function fixImportsInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;
  const filename = path.basename(filePath);

  // Find all from statements for debugging
  const allFroms = content.match(/from\s+['"][^'"]*['"]/g) || [];
  if (allFroms.length > 0 && filePath.includes('main.js')) {
    console.log(`DEBUG ${filename}: Found ${allFroms.length} from statements`);
    allFroms.forEach(f => console.log(`    - ${f}`));
  }

  // Match: from './something' or from '../something'
  // But NOT from '@nestjs/core' or other scoped packages
  const beforeReplace = content;
  content = content.replace(
    /from\s+(['"])(\.[^'"]+)\1/g,
    (match, quote, importPath) => {
      console.log(`  REGEX MATCHED: "${match}" → quote="${quote}", path="${importPath}"`);
      // Check if already has a file extension like .js, .json, .ts, etc.
      // Common extensions: .js, .json, .ts, .mjs, .cjs, .d.ts
      const hasFileExtension = /\.(js|json|ts|mjs|cjs|d\.ts)$/i.test(importPath);
      console.log(`    hasFileExtension=${hasFileExtension}`);

      if (!hasFileExtension) {
        console.log(`  Fixing: ${importPath} → ${importPath}.js in ${filename}`);
        return `from ${quote}${importPath}.js${quote}`;
      }
      return match;
    }
  );
  if (beforeReplace !== content && filePath.includes('main.js')) {
    console.log(`  Content changed for ${filename}`);
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✓ Fixed imports in ${path.relative(distDir, filePath)}`);
    return true;
  }
  return false;
}

console.log('Fixing ESM imports...');
console.log(`Looking in: ${distDir}`);
console.log(`Dir exists: ${fs.existsSync(distDir)}`);

let found = 0;
let fixed = 0;
walkDir(distDir, (filePath) => {
  found++;
  if (fixImportsInFile(filePath)) {
    fixed++;
  }
});
console.log(`Done! Found ${found} files, fixed ${fixed} files.`);
