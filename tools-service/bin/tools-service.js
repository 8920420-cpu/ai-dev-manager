#!/usr/bin/env node
// TOOLS-SERVICE-001 — HTTP-сервер микросервиса инструментов (builtin + MCP-конфиг).
import process from 'node:process';
import { createServer } from 'node:http';
import { handleRoute } from '../src/server.js';
import { parseAllowedRoots } from '../src/builtins.js';

const PORT = Number(process.env.TOOLS_SERVICE_PORT || 4188);
const TOKEN = String(process.env.ORCHESTRATOR_API_TOKEN || '').trim();
const BODY_LIMIT = 8 << 20; // 8 МБ
// SECURITY: allowlist серверных корней для args.root в /execute. Пусто = выключен.
const ALLOWED_ROOTS = parseAllowedRoots(process.env.TOOLS_ALLOWED_ROOTS);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

// Опциональная защита токеном (как у остальных сервисов). /health всегда открыт.
function authorized(req, path) {
  if (!TOKEN) return true;
  if (path === '/health' || path === '/readiness') return true;
  const h = String(req.headers.authorization || '');
  return h === `Bearer ${TOKEN}`;
}

const server = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  try {
    if (!authorized(req, path)) return send(res, 401, { ok: false, error: 'unauthorized' });
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
    }
    const { status, body: out } = await handleRoute(req.method, path, body, { allowedRoots: ALLOWED_ROOTS });
    send(res, status, out);
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => console.log(`tools-service listening on :${PORT}`));

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
