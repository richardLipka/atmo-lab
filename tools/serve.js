/**
 * A dependency-free static file server for local use.
 *
 *   node tools/serve.js [port]
 *
 * The application itself makes no network calls; this exists only so the
 * browser will allow fetch() on the config files during development.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = path.join(root, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found: ' + pathname);
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(data);
  });
}).listen(port, () => {
  console.log(`Atmospheric Light Laboratory: http://localhost:${port}/`);
});
