#!/usr/bin/env node
// TOOLS-SERVICE-001 — HTTP-сервер микросервиса инструментов (builtin + MCP-конфиг).
import process from 'node:process';
import { createServer } from 'node:http';
import { handleRoute } from '../src/server.js';
import { parseAllowedRoots } from '../src/builtins.js';
import { isBearerOrApiTokenAuthorized, isPublicHealthPath, readTokenAuthConfig } from '../../shared/httpAuth.js';

const PORT = Number(process.env.TOOLS_SERVICE_PORT || 4188);
const AUTH = readTokenAuthConfig();
const BODY_LIMIT = 8 << 20; // 8 МБ
// SECURITY: allowlist серверных корней для args.root в /execute. Пусто = выключен.
const ALLOWED_ROOTS = parseAllowedRoots(process.env.TOOLS_ALLOWED_ROOTS);
const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);

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

function authorized(req, path) {
  return isPublicHealthPath(path) || isBearerOrApiTokenAuthorized(req, AUTH);
}

function validateExecutionPolicy(body) {
  const tool = String(body?.tool ?? '').trim();
  if (!tool) return null;
  if (ALLOWED_ROOTS.length === 0 && !AUTH.allowInsecureLocal && process.env.NODE_ENV !== 'test') {
    return { status: 403, body: { ok: false, error: 'allowed_roots_required' } };
  }
  if (MUTATING_TOOLS.has(tool) && !AUTH.token && !AUTH.allowInsecureLocal) {
    return { status: 403, body: { ok: false, tool, error: 'token_required_for_mutation' } };
  }
  return null;
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
    if (path === '/execute') {
      const policy = validateExecutionPolicy(body);
      if (policy) return send(res, policy.status, policy.body);
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
