/**
 * Generates config/bundle.js from the JSON files.
 *
 * The JSON files are the source of truth. This bundle exists only so the page
 * still works when it is opened directly from disk, where the browser refuses
 * fetch() on file:// URLs. Re-run it after editing anything under /config.
 *
 *   node tools/build-bundle.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(here, '..', 'config');

const index = JSON.parse(fs.readFileSync(path.join(configDir, 'index.json'), 'utf8'));

const wanted = ['index.json'];
for (const [dir, key] of [
  ['atmospheres', 'atmospheres'],
  ['stars', 'stars'],
  ['scattering', 'scattering'],
  ['experiments', 'experiments'],
  ['localization', 'localization'],
  ['color', 'color'],
]) {
  for (const id of index[key]) wanted.push(`${dir}/${id}.json`);
}

const payload = {};
for (const relative of wanted) {
  const full = path.join(configDir, relative);
  if (!fs.existsSync(full)) {
    console.error(`missing: ${relative}`);
    process.exitCode = 1;
    continue;
  }
  payload[relative] = JSON.parse(fs.readFileSync(full, 'utf8'));
}

const output = `/* GENERATED FILE - do not edit.
 * Rebuild with: node tools/build-bundle.js
 * Source of truth: the JSON files under /config.
 */
window.__ATMO_CONFIG__ = ${JSON.stringify(payload)};
`;

const target = path.join(configDir, 'bundle.js');
fs.writeFileSync(target, output);
console.log(`bundle.js written: ${wanted.length} files, ${(output.length / 1024).toFixed(1)} kB`);
