/**
 * Node test runner.
 *
 *   npm test        or        node tests/run-tests.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHarness } from './harness.js';
import { registerTests } from './physics.test.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configDir = path.join(root, 'config');

const read = (relative) => JSON.parse(fs.readFileSync(path.join(configDir, relative), 'utf8'));
const index = read('index.json');

const collect = (dir, ids) => Object.fromEntries(ids.map((id) => [id, read(`${dir}/${id}.json`)]));

const config = {
  index,
  atmospheres: collect('atmospheres', index.atmospheres),
  stars: collect('stars', index.stars),
  scattering: collect('scattering', index.scattering),
  experiments: collect('experiments', index.experiments),
  localization: collect('localization', index.localization),
  color: read(`color/${index.color[0]}.json`),
};

const harness = createHarness();
const started = Date.now();
registerTests(harness, config);
const { results, passed, failed, total } = harness.summary();
const elapsed = Date.now() - started;

const colour = process.stdout.isTTY;
const green = (s) => (colour ? `[32m${s}[0m` : s);
const red = (s) => (colour ? `[31m${s}[0m` : s);
const dim = (s) => (colour ? `[2m${s}[0m` : s);

let lastGroup = null;
for (const result of results) {
  if (result.group !== lastGroup) {
    console.log(`\n  ${dim(result.group)}`);
    lastGroup = result.group;
  }
  if (result.passed) {
    console.log(`    ${green('pass')}  ${result.name}`);
  } else {
    console.log(`    ${red('FAIL')}  ${result.name}`);
    console.log(`          ${red(result.message)}`);
  }
}

console.log(`\n  ${passed}/${total} passed in ${elapsed} ms` +
  (failed ? red(`, ${failed} failed`) : green(', all green')) + '\n');

process.exit(failed ? 1 : 0);
