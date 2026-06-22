import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { TesterService, TesterInputError } from './TesterService.js';

const MAX_BODY_BYTES = 1_000_000; // 1 МБ — входные данные роли невелики

// Опциональный корень рабочих каталогов: за его пределы не выпускаем чтение
// результатов через GET /results (projectPath приходит из запроса).
const WORKSPACE_ROOT = process.env.TESTER_WORKSPACE_ROOT
  ? path.resolve(process.env.TESTER_WORKSPACE_ROOT)
  : null;

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Создать HTTP-сервер микросервиса «Тестировщик».
 *
 * Маршруты:
 *   GET  /health          — проверка живости { status: "ok" }
 *   POST /test            — запустить проверку задачи (тело = входные данные роли)
 *   GET  /results/:taskId — отдать сохранённый результат проверки задачи
 *
 * @param {Object} [opts]
 * @param {TesterService} [opts.service] переопределение ядра (для тестов)
 * @param {(message: string, meta?: Object) => void} [opts.log]
 * @returns {import('node:http').Server}
 */
export function createServer({ service, log } = {}) {
  const logger = log ?? defaultLog;
  const tester = service ?? new TesterService({ log: logger });

  return http.createServer((req, res) => {
    handle(req, res, tester, logger).catch((err) => {
      sendJson(res, 500, { status: 'error', message: String(err?.message ?? err) });
    });
  });
}

async function handle(req, res, tester, logger) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /health') {
    return sendJson(res, 200, { status: 'ok', role: 'Tester (Pipeline Service)' });
  }

  if (route === 'POST /test') {
    let input;
    try {
      input = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { status: 'error', message: String(err?.message ?? err) });
    }
    try {
      const result = await tester.runCheck(input);
      const code = result.status === 'error' ? 422 : 200;
      return sendJson(res, code, result);
    } catch (err) {
      if (err instanceof TesterInputError) {
        return sendJson(res, 400, { status: 'error', message: err.message });
      }
      logger('Внутренняя ошибка при выполнении проверки', { error: String(err?.message ?? err) });
      return sendJson(res, 500, { status: 'error', message: 'internal_error' });
    }
  }

  const resultsMatch = url.pathname.match(/^\/results\/([^/]+)$/);
  if (req.method === 'GET' && resultsMatch) {
    const projectPath = url.searchParams.get('projectPath');
    if (!projectPath) {
      return sendJson(res, 400, { status: 'error', message: 'требуется параметр projectPath' });
    }
    const absProject = path.resolve(projectPath);
    if (WORKSPACE_ROOT && !isWithin(WORKSPACE_ROOT, absProject)) {
      return sendJson(res, 403, { status: 'error', message: 'projectPath вне рабочего каталога' });
    }
    const taskId = decodeURIComponent(resultsMatch[1]).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const file = path.join(absProject, '.tmp', 'tester-results', `${taskId}.json`);
    try {
      const raw = await readFile(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(raw);
    } catch {
      return sendJson(res, 404, { status: 'error', message: 'результат не найден' });
    }
  }

  return sendJson(res, 404, { status: 'error', message: 'not_found' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('тело запроса слишком велико'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`некорректный JSON в теле запроса: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2) + '\n');
}

function defaultLog(message, meta) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[tester-service] ${message}${suffix}\n`);
}
