import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let checked = 0;
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.name.endsWith('.js')) { execFileSync(process.execPath, ['--check', child], { stdio: 'pipe' }); checked++; }
    else if (entry.name.endsWith('.json')) { JSON.parse(readFileSync(child, 'utf8')); checked++; }
  }
}
for (const path of ['apps', 'packages', 'scripts', 'tests', 'config']) visit(path);
for (const path of ['package.json', 'package-lock.json']) { JSON.parse(readFileSync(path, 'utf8')); checked++; }
console.log(`Syntax and JSON validation passed (${checked} files).`);
