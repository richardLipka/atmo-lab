/**
 * Builds dist/atmo-lab.html: the entire laboratory as one self-contained file.
 *
 * The modular version needs a web server, because browsers refuse both fetch()
 * and ES module imports over file:// URLs. A school laptop may not have one, so
 * this produces a single page that can be copied onto a memory stick and opened
 * by double-clicking it.
 *
 * It is a small bundler, not a general one. It relies on the house style used
 * throughout this project: every module imports with
 *     import { a, b } from './path.js';
 * and exports with a leading `export` keyword. Modules are sorted so that
 * dependencies come first, the import and export keywords are stripped, and
 * everything ends up sharing one scope - so the build fails loudly if two
 * modules ever declare the same top-level name.
 *
 *   node tools/build-standalone.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'js/main.js';

const IMPORT_RE = /^\s*import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;

function readModule(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/** Depth-first walk of the import graph, emitting dependencies first. */
function collectModules(entry) {
  const order = [];
  const state = new Map();   // 'visiting' | 'done'

  function visit(relative) {
    if (state.get(relative) === 'done') return;
    if (state.get(relative) === 'visiting') {
      throw new Error(`import cycle reached ${relative}`);
    }
    state.set(relative, 'visiting');

    const source = readModule(relative);
    const dir = path.posix.dirname(relative.split(path.sep).join('/'));
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) {
        throw new Error(`${relative}: cannot bundle the bare import "${specifier}"`);
      }
      visit(path.posix.normalize(path.posix.join(dir, specifier)));
    }

    state.set(relative, 'done');
    order.push(relative);
  }

  visit(entry);
  return order;
}

/** Remove the module syntax, leaving plain script-scope declarations. */
function stripModuleSyntax(source) {
  return source
    .replace(IMPORT_RE, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default = ')
    .replace(/^(\s*)export\s+(const|let|var|function|class|async)\b/gm, '$1$2');
}

/** Top-level declarations, so collisions can be reported before they bite. */
function topLevelNames(source) {
  const names = [];
  const re = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(re)) names.push(match[1]);
  return names;
}

const modules = collectModules(ENTRY);
const seen = new Map();
const pieces = [];

for (const relative of modules) {
  const stripped = stripModuleSyntax(readModule(relative));
  for (const name of topLevelNames(stripped)) {
    if (seen.has(name)) {
      console.error(
        `name collision: "${name}" is declared in both ${seen.get(name)} and ${relative}.\n` +
        'Rename one of them; the single-file build puts every module in one scope.');
      process.exit(1);
    }
    seen.set(name, relative);
  }
  pieces.push(`/* ===== ${relative} ===== */\n${stripped.trim()}\n`);
}

const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const configBundle = fs.readFileSync(path.join(root, 'config/bundle.js'), 'utf8');

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html
  .replace(/<link rel="stylesheet" href="css\/style\.css">/,
    `<style>\n${css}\n</style>`)
  .replace(/<!--[\s\S]*?-->\s*<script src="config\/bundle\.js"[^>]*><\/script>/,
    `<script>\n${configBundle}\n</script>`)
  .replace(/<script type="module" src="js\/main\.js"><\/script>/,
    `<script>\n(function () {\n'use strict';\n${pieces.join('\n')}\n})();\n</script>`);

// The standalone build has no server to fetch from; make that explicit rather
// than letting every load spend time on requests that are certain to fail.
html = html.replace(
  /const BASE = ['"]config\/['"];/,
  "const BASE = 'config/';\nconst STANDALONE = true;");

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const target = path.join(distDir, 'atmo-lab.html');
fs.writeFileSync(target, html);

console.log(`dist/atmo-lab.html written`);
console.log(`  ${modules.length} modules, ${seen.size} top-level names, ${(html.length / 1024).toFixed(0)} kB`);
console.log(`  module order: ${modules.map((m) => path.basename(m)).join(' -> ')}`);
