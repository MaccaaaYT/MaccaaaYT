// Локальный сервер для разработки без Vercel CLI: статика из public/ + функции из api/.
// Запуск: npm run dev  (переменные окружения берутся из .env, если он есть)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Простейшая загрузка .env
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Добавляет к ответу Node методы в стиле Vercel: res.status().json(). */
function vercelify(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (data) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/\/$/, '');
      const file = join(root, 'api', `${name}.js`);
      if (!/^[a-z-]+$/.test(name) || !existsSync(file)) {
        res.statusCode = 404;
        return res.end('Not found');
      }
      vercelify(req, res, url);
      req.body = await readBody(req);
      const mod = await import(file);
      return await mod.default(req, res);
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    let file = join(root, 'public', path);
    if (!(await stat(file).catch(() => null))?.isFile()) file = join(root, 'public', 'index.html');
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Server error');
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`🦊 Мия запущена: http://localhost:${port}`);
  if (!process.env.GEMINI_API_KEY) console.log('   ⚠️  GEMINI_API_KEY не задан — демо-режим');
  if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) console.log('   ⚠️  Redis не настроен — память только в оперативке');
});
