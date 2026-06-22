// HTTP-сервер: REST API настроек/БД + раздача фронтенда (../../frontend).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, resolveSettings, redactSettings } from './config.js';
import {
  testConnection,
  bootstrap,
  runSeed,
  getStatus,
  acceptScannerCompletion,
  claimNextClaudeTask,
  releaseClaudeTask,
  claimNextHostTask,
  completeHostTask,
  releaseHostTask,
} from './db.js';
import {
  listConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  listExchanges,
  invokeConnector,
} from './connectors.js';
import { getProjectStages, saveProjectStages } from './stages.js';
import { getTaskStatistics } from './taskStats.js';
import {
  listProjectsRich,
  getProject,
  createOrUpsertProject,
  updateProject,
  setProjectStatus,
  deleteProject,
} from './projects.js';
import { listDatabases } from './databases.js';
import {
  listAdditionalDatabases,
  getAdditionalDatabase,
  createAdditionalDatabase,
  updateAdditionalDatabase,
  deleteAdditionalDatabase,
} from './additionalDatabases.js';
import { listRoleConnectors, saveRoleConnectors } from './roleConnectors.js';
import { importLegacy } from './importLegacy.js';
import { pickFolder } from './fsPicker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Единый фронтенд — React/Vite SPA из корня репозитория (src/ → dist/).
// В Docker-образе сборка лежит рядом, в /app/frontend (см. Dockerfile:
// COPY --from=frontend /web/dist ./frontend). При локальном запуске backend без
// Docker этого каталога нет — тогда берём корневой dist/. Переопределяется через
// FRONTEND_DIR. Старая plain-HTML страница удалена — фронтенд в проекте один.
const FRONTEND_DIR =
  process.env.FRONTEND_DIR ||
  [resolve(__dirname, '../../frontend'), resolve(__dirname, '../../../dist')].find((d) =>
    existsSync(d),
  ) ||
  resolve(__dirname, '../../frontend');

// Необязательная защита API. Если задан ORCHESTRATOR_API_TOKEN, все /api/*
// требуют заголовок Authorization: Bearer <token> (или X-Api-Token: <token>).
// По умолчанию выключено, чтобы не ломать локальную разработку, но в любом
// сетевом развёртывании токен обязателен — API создаёт БД и меняет настройки.
const API_TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === API_TOKEN) return true;
  if (req.headers['x-api-token'] === API_TOKEN) return true;
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, ''); // защита от path traversal
  const file = join(FRONTEND_DIR, rel);
  if (!file.startsWith(FRONTEND_DIR) || !existsSync(file)) {
    // SPA-фолбэк на index.html
    const index = join(FRONTEND_DIR, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(await readFile(index));
    }
    res.writeHead(404);
    return res.end('Not found');
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(await readFile(file));
}

// Разбор путей /api/projects/:projectId[/(stages|task-statistics|status)].
// Без суффикса → item (GET :id / PUT :id / DELETE :id).
function matchProjectRoute(pathname) {
  const m = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(stages|task-statistics|status))?$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), kind: m[2] || 'item' };
}

// Разбор путей /api/additional-databases[/:id].
function matchAdditionalDbRoute(pathname) {
  if (pathname === '/api/additional-databases') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/additional-databases\/([^/]+)$/);
  if (!m) return null;
  return { kind: 'item', id: decodeURIComponent(m[1]) };
}

// If-Match (optimistic concurrency) → updatedAt для updateProject.
function ifMatch(req) {
  const h = req.headers['if-match'];
  if (!h) return null;
  return String(h).replace(/^"+|"+$/g, '') || null; // снять кавычки ETag-формата
}

// Разбор путей /api/integrations[/:id[/exchanges|/invoke]].
function matchIntegrationRoute(pathname) {
  if (pathname === '/api/integrations') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/integrations\/([^/]+)(?:\/(exchanges|invoke))?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (m[2] === 'exchanges') return { kind: 'exchanges', id };
  if (m[2] === 'invoke') return { kind: 'invoke', id };
  return { kind: 'item', id };
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // --- API ---
      if (p.startsWith('/api/') || p === '/health') {
        if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { status: 'ok' });

        // /health открыт для healthcheck; всё остальное под /api требует токен,
        // если он сконфигурирован.
        if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

        if (req.method === 'GET' && p === '/api/settings')
          return sendJson(res, 200, redactSettings(await loadSettings()));

        if (req.method === 'POST' && p === '/api/settings')
          return sendJson(res, 200, redactSettings(await saveSettings(await readBody(req))));

        if (req.method === 'POST' && p === '/api/db/test')
          return sendJson(res, 200, await testConnection(await resolveSettings(await readBody(req))));

        if (req.method === 'POST' && p === '/api/db/init')
          return sendJson(res, 200, await bootstrap(await resolveSettings(await readBody(req))));

        if (req.method === 'POST' && p === '/api/db/seed')
          return sendJson(res, 200, await runSeed(await resolveSettings(await readBody(req))));

        if (req.method === 'GET' && p === '/api/db/status')
          return sendJson(res, 200, await getStatus(await loadSettings()));

        // Перечень подключённых БД с живым статусом — для карточек в UI.
        if (req.method === 'GET' && p === '/api/databases')
          return sendJson(res, 200, await listDatabases(await loadSettings()));

        if (req.method === 'POST' && p === '/api/scanner/task-completed')
          return sendJson(
            res,
            200,
            await acceptScannerCompletion(await loadSettings(), await readBody(req)),
          );

        // Обратный мост БД → файл: выдать Scanner-фидеру следующую задачу для Claude.
        if (req.method === 'GET' && p === '/api/runner/next-claude-task')
          return sendJson(res, 200, await claimNextClaudeTask(await loadSettings()));

        // Откат захвата, если фидер не смог записать файл.
        if (req.method === 'POST' && p === '/api/runner/release-claude-task')
          return sendJson(
            res,
            200,
            await releaseClaudeTask(await loadSettings(), (await readBody(req)).taskId),
          );

        // Host-мост: роли действия (PIPELINE_SERVICE/GIT_INTEGRATOR) исполняет
        // нативный host-runner — здесь он берёт задачу и сдаёт результат.
        if (req.method === 'GET' && p === '/api/runner/next-host-task')
          return sendJson(res, 200, await claimNextHostTask(await loadSettings(), url.searchParams.get('role')));

        if (req.method === 'POST' && p === '/api/runner/host-task-completed')
          return sendJson(res, 200, await completeHostTask(await loadSettings(), await readBody(req)));

        if (req.method === 'POST' && p === '/api/runner/release-host-task')
          return sendJson(
            res,
            200,
            await releaseHostTask(await loadSettings(), (await readBody(req)).taskId),
          );

        // --- Проекты: rich-список + идемпотентная регистрация по папке ---
        if (p === '/api/projects') {
          if (req.method === 'GET') return sendJson(res, 200, await listProjectsRich(await loadSettings()));
          if (req.method === 'POST')
            return sendJson(res, 200, await createOrUpsertProject(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Доп. БД (additional_databases) — секрет не отдаётся ---
        const adb = matchAdditionalDbRoute(p);
        if (adb) {
          if (adb.kind === 'collection') {
            if (req.method === 'GET')
              return sendJson(res, 200, await listAdditionalDatabases(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createAdditionalDatabase(await loadSettings(), await readBody(req)));
          } else {
            if (req.method === 'GET')
              return sendJson(res, 200, await getAdditionalDatabase(await loadSettings(), adb.id));
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateAdditionalDatabase(await loadSettings(), adb.id, await readBody(req)));
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteAdditionalDatabase(await loadSettings(), adb.id));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Назначения «роль → коннектор» (role_connectors) ---
        if (p === '/api/role-connectors') {
          if (req.method === 'GET') return sendJson(res, 200, await listRoleConnectors(await loadSettings()));
          if (req.method === 'PUT')
            return sendJson(res, 200, await saveRoleConnectors(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Нативный выбор папки на хосте backend (абсолютный путь) ---
        if (p === '/api/fs/pick-folder') {
          if (req.method === 'POST') return sendJson(res, 200, await pickFolder());
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Идемпотентный импорт legacy-данных (localStorage → сервер) ---
        if (p === '/api/import/legacy') {
          if (req.method === 'POST')
            return sendJson(res, 200, await importLegacy(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Проекты: rich CRUD + этапы (stage-config) + статистика задач ---
        const proj = matchProjectRoute(p);
        if (proj) {
          if (proj.kind === 'item') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getProject(await loadSettings(), proj.id));
            if (req.method === 'PUT') {
              const body = await readBody(req);
              if (body.updatedAt === undefined) body.updatedAt = ifMatch(req);
              return sendJson(res, 200, await updateProject(await loadSettings(), proj.id, body));
            }
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteProject(await loadSettings(), proj.id));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (proj.kind === 'status') {
            if (req.method === 'PATCH')
              return sendJson(
                res,
                200,
                await setProjectStatus(await loadSettings(), proj.id, (await readBody(req)).status),
              );
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (proj.kind === 'stages') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getProjectStages(await loadSettings(), proj.id));
            if (req.method === 'PUT')
              return sendJson(
                res,
                200,
                await saveProjectStages(await loadSettings(), proj.id, await readBody(req)),
              );
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (proj.kind === 'task-statistics') {
            if (req.method === 'GET')
              return sendJson(
                res,
                200,
                await getTaskStatistics(await loadSettings(), proj.id, {
                  limit: url.searchParams.get('limit'),
                  offset: url.searchParams.get('offset'),
                }),
              );
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
        }

        // --- Интеграции (коннекторы AI) + журнал обмена ---
        const intg = matchIntegrationRoute(p);
        if (intg) {
          if (intg.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, { integrations: await listConnectors() });
            if (req.method === 'POST')
              return sendJson(res, 201, await createConnector(await readBody(req)));
          } else if (intg.kind === 'item') {
            if (req.method === 'GET') return sendJson(res, 200, await getConnector(intg.id));
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateConnector(intg.id, await readBody(req)));
            if (req.method === 'DELETE') return sendJson(res, 200, await deleteConnector(intg.id));
          } else if (intg.kind === 'exchanges') {
            if (req.method === 'GET')
              return sendJson(res, 200, { exchanges: await listExchanges(intg.id) });
          } else if (intg.kind === 'invoke') {
            if (req.method === 'POST')
              return sendJson(res, 200, await invokeConnector(intg.id, await readBody(req)));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        return sendJson(res, 404, { error: 'not_found' });
      }

      // --- Static frontend ---
      if (req.method === 'GET') return await serveStatic(res, p);
      res.writeHead(405);
      res.end('Method not allowed');
    } catch (e) {
      const body = { ok: false, error: e.message };
      // Стабильный машинный код и привязанные к stageId ошибки валидации.
      if (e.code) body.code = e.code;
      if (Array.isArray(e.errors)) body.errors = e.errors;
      sendJson(res, e.statusCode || 500, body);
    }
  });
}
