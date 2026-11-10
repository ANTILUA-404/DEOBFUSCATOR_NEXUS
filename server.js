'use strict';

/**
 * NXS9 / StudioDev57 Luau deobfuscator — zero-dependency HTTP service.
 * Deploy: Railway runs `npm start`; the port comes from $PORT.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { deobfuscate } = require('./lib/deob');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;      // 8 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload terlalu besar (maks 8 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/health') return sendJson(res, 200, { ok: true, uptime: process.uptime() });

  if (p === '/api/deobfuscate') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Gunakan POST.' });

    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'Body tidak valid.' });
    }

    const source = payload && payload.source;
    if (typeof source !== 'string' || !source.trim()) {
      return sendJson(res, 400, { ok: false, error: 'Field "source" kosong.' });
    }

    try {
      const t0 = Date.now();
      const result = deobfuscate(source);
      result.elapsedMs = Date.now() - t0;
      return sendJson(res, result.ok ? 200 : 422, result);
    } catch (err) {
      console.error('[deob] crash:', err);
      return sendJson(res, 500, {
        ok: false,
        error: 'Terjadi kesalahan internal saat memproses script.',
        detail: err.message,
      });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`NXS9 Deobfuscator listening on http://${HOST}:${PORT}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
