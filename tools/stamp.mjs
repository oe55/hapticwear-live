// Stamps sw.js with a hash of every file in its SHELL list, so each deploy that changes the site
// installs as a new, complete offline copy. Run before every push:  node tools/stamp.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
const hash = createHash('sha256');
for (const p of list) if (p !== './') hash.update(p).update(readFileSync(join(root, p)));
const build = hash.digest('hex').slice(0, 10);
writeFileSync(swPath, sw.replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`));
console.log(`sw.js BUILD ${build} (${list.length} files)`);
