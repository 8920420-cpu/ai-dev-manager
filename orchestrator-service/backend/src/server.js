// HTTP-сервер: REST API настроек/БД + раздача фронтенда (../../frontend).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, resolveSettings, redactSettings } from './config.js';
import { getAppSettings, updateAppSettings } from './appSettings.js';
import { stats as connectorCapacity, allStats as connectorCapacityBuckets } from './connectorLimiter.js';
import {
  testConnection,
  bootstrap,
  runSeed,
  getStatus,
  getAppliedMigrations,
  acceptScannerCompletion,
  acceptScannerIntake,
  acceptIntakeReport,
  listUnassignedTasks,
  assignTaskProject,
  advanceTask,
  moveTask,
  setTaskPriority,
  restartStuckTasks,
  getAcceptanceBoard,
  acceptTask,
  claimNextClaudeTask,
  releaseClaudeTask,
  claimNextHostTask,
  completeHostTask,
  releaseHostTask,
  claimNextReasoningTask,
  completeReasoningTask,
  releaseReasoningTask,
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
import {
  listIntegrations as listIntakeIntegrations,
  getIntegration as getIntakeIntegration,
  createIntegration as createIntakeIntegration,
  updateIntegration as updateIntakeIntegration,
  rotateIntegrationToken as rotateIntakeIntegrationToken,
  deleteIntegration as deleteIntakeIntegration,
  getIntakeStats,
} from './intakeIntegrations.js';
import { acceptFeedback, saveScreenshot, readScreenshot } from './feedback.js';
import { getScheme, saveScheme } from './developmentScheme.js';
import { getTaskStatistics } from './taskStats.js';
import { getPerformanceMetrics, getVersionMetrics, getDailyModelStats, getRoleLoadTotals, getKpiMarkers, createKpiMarker } from './performance.js';
import { createAuditRun, listAuditRuns, completeAuditRun } from './auditRuns.js';
import { getTaskTree, getTaskStatusCounts, getTasksByStage, getTaskHistory } from './taskTree.js';
import { openTaskEventsStream, publishTaskChange } from './taskEvents.js';
import {
  listProjectsRich,
  getProject,
  createOrUpsertProject,
  updateProject,
  setProjectStatus,
  setProjectScanner,
  deleteProject,
} from './projects.js';
import { listDatabases } from './databases.js';
import { listServers, runServerAction } from './servers.js';
import { listRoleConnectors, saveRoleConnectors } from './roleConnectors.js';
import {
  listTools,
  getTool,
  createTool,
  updateTool,
  deleteTool,
  getRoleCapabilities,
  saveRoleCapabilities,
  getRoleTools,
  saveRoleTools,
} from './tools.js';
import { listRoles, getRole, updateRole, listAvailableSkills, uploadSkill } from './roles.js';
import {
  listMcpRoles,
  getMcpRole,
  createMcpRole,
  updateMcpRole,
  deleteMcpRole,
} from './mcpRoles.js';
import {
  listFields,
  createField,
  updateField,
  deleteField,
  getRoleFields,
  saveRoleFields,
} from './fields.js';
import {
  listRoleGroups,
  createRoleGroup,
  updateRoleGroup,
  deleteRoleGroup,
} from './roleGroups.js';
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnectionById,
} from './databaseConnections.js';
import { pickFolder } from './fsPicker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Версия сервиса из package.json — для healthcheck-эндпоинта /api/version
// (быстрая диагностика развёртывания: какая версия и какие миграции накатаны).
const SERVICE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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

function isAuthorized(req, { allowQueryToken = false } = {}) {
  if (!API_TOKEN) return true;
  const auth = req.headers['authorization'];
  const url = new URL(req.url || '/', 'http://localhost');
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === API_TOKEN) return true;
  if (req.headers['x-api-token'] === API_TOKEN) return true;
  if (allowQueryToken && url.searchParams.get('token') === API_TOKEN) return true;
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

const BODY_LIMIT_BYTES = 1e6; // 1 МБ на тело запроса по умолчанию

// Скриншоты обращений («Обратная связь») приходят data-URL'ом (base64) и крупнее
// глобального лимита readBody — для /api/feedback/screenshot нужен отдельный потолок.
const FEEDBACK_SCREENSHOT_BODY_LIMIT = Number(process.env.FEEDBACK_SCREENSHOT_BODY_LIMIT) || 8e6;

// maxBytes переопределяет BODY_LIMIT_BYTES для эндпоинтов с заведомо большим телом
// (напр. загрузка скриншота). Прочие вызовы (readBody(req)) сохраняют лимит 1 МБ.
export function readBody(req, { maxBytes = BODY_LIMIT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    // Собираем СЫРЫЕ буферы и декодируем UTF-8 один раз в конце. Нельзя делать
    // `data += chunk` (chunk.toString() на каждый чанк): многобайтовый символ
    // (кириллица и пр.) может попасть на границу TCP-чанков и декодироваться
    // раздельно → символы-замены «�» (битая кодировка заголовка/описания задачи).
    const chunks = [];
    let size = 0;
    let settled = false; // single-settle: промис резолвится/реджектится ровно один раз

    // Ошибка с машинным кодом и HTTP-статусом — внешний catch отдаёт 400/413,
    // а не 500 (битый/слишком большой ввод — вина клиента, не сервера).
    const fail = (message, code, statusCode) => {
      if (settled) return;
      settled = true;
      const e = new Error(message);
      e.code = code;
      e.statusCode = statusCode;
      // Прекращаем приём тела: pause() останавливает накопление памяти/CPU, но
      // оставляет сокет живым, чтобы внешний catch успел отдать 413/400 (destroy()
      // оборвал бы соединение до ответа). Обработчик 'data' ниже после settled
      // больше не пушит чанки, так что память дальше не растёт.
      if (typeof req.pause === 'function') req.pause();
      reject(e);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (c) => {
      if (settled) return;
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) fail('payload too large', 'payload_too_large', 413);
    });
    req.on('end', () => {
      if (settled) return;
      if (size === 0) return done({});
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        done(JSON.parse(data));
      } catch {
        fail('invalid JSON body', 'invalid_json', 400);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
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
  const m = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(task-statistics|status|scanner))?$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), kind: m[2] || 'item' };
}

// Разбор путей /api/database-connections[/:id[/test]] — единая модель подключений.
function matchDbConnectionRoute(pathname) {
  if (pathname === '/api/database-connections') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/database-connections\/([^/]+)(?:\/(test))?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (m[2] === 'test') return { kind: 'test', id };
  return { kind: 'item', id };
}

// If-Match (optimistic concurrency) → updatedAt для updateProject.
function ifMatch(req) {
  const h = req.headers['if-match'];
  if (!h) return null;
  return String(h).replace(/^"+|"+$/g, '') || null; // снять кавычки ETag-формата
}

// Разбор путей /api/roles[/:code[/fields]]. role-connectors сюда не попадает.
function matchRoleRoute(pathname) {
  if (pathname === '/api/roles') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/roles\/([^/]+)(?:\/(fields|capabilities|tools))?$/);
  if (!m) return null;
  const code = decodeURIComponent(m[1]);
  if (m[2] === 'fields') return { kind: 'fields', code };
  if (m[2] === 'capabilities') return { kind: 'capabilities', code };
  if (m[2] === 'tools') return { kind: 'role-tools', code };
  return { kind: 'item', code };
}

// Разбор путей /api/mcp-roles[/:code] — раздел «MCP роли».
function matchMcpRoleRoute(pathname) {
  if (pathname === '/api/mcp-roles') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/mcp-roles\/([^/]+)$/);
  if (!m) return null;
  return { kind: 'item', code: decodeURIComponent(m[1]) };
}

// Разбор путей /api/tools[/:id] — реестр инструментов.
function matchToolRoute(pathname) {
  if (pathname === '/api/tools') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/tools\/([^/]+)$/);
  if (!m) return null;
  return { kind: 'item', id: decodeURIComponent(m[1]) };
}

// Разбор путей /api/fields[/:id] — глобальный справочник полей.
function matchFieldRoute(pathname) {
  if (pathname === '/api/fields') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/fields\/([^/]+)$/);
  if (!m) return null;
  return { kind: 'item', id: decodeURIComponent(m[1]) };
}

// Разбор путей /api/role-groups[/:id] — смысловые группы ролей.
function matchRoleGroupRoute(pathname) {
  if (pathname === '/api/role-groups') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/role-groups\/([^/]+)$/);
  if (!m) return null;
  return { kind: 'item', id: decodeURIComponent(m[1]) };
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

function matchServerRoute(pathname) {
  if (pathname === '/api/servers') return { kind: 'collection' };
  const m = pathname.match(/^\/api\/servers\/([^/]+)\/actions$/);
  if (!m) return null;
  return { kind: 'actions', id: decodeURIComponent(m[1]) };
}

// INTAKE-INTEGRATIONS-001: разбор путей /api/intake-integrations[/(stats|:id[/rotate-token])].
// Отдельный префикс от /api/integrations (коннекторы-движки) — это разные сущности.
function matchIntakeIntegrationRoute(pathname) {
  if (pathname === '/api/intake-integrations') return { kind: 'collection' };
  if (pathname === '/api/intake-integrations/stats') return { kind: 'stats' };
  const m = pathname.match(/^\/api\/intake-integrations\/([^/]+)(?:\/(rotate-token))?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (m[2] === 'rotate-token') return { kind: 'rotate', id };
  return { kind: 'item', id };
}

// FEEDBACK-WIDGET-001: разбор пути отдачи скриншота обращения
// GET /api/feedback/screenshot/:id (id — hex[.ext], проверка формата в readScreenshot).
function matchFeedbackScreenshotRoute(pathname) {
  const m = pathname.match(/^\/api\/feedback\/screenshot\/([^/]+)$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]) };
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // --- API ---
      if (p.startsWith('/api/') || p === '/health') {
        if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { status: 'ok' });

        // Healthcheck версии: версия сервиса + сводка применённых миграций.
        // Открыт (как /health) — нужен мониторингу/деплою без токена для быстрой
        // диагностики «какая версия и до какой миграции накатан экземпляр».
        if (req.method === 'GET' && p === '/api/version') {
          // Healthcheck не должен падать, если БД недоступна: версию сервиса
          // отдаём всегда (она нужна для диагностики деплоя в т.ч. при упавшей
          // БД), а недоступность миграций фиксируем в migrations.error.
          let migrations = { count: 0, latest: null, applied: [] };
          try {
            const mig = await getAppliedMigrations(await loadSettings());
            migrations = {
              count: mig.count,
              latest: mig.migrations.length ? mig.migrations[mig.migrations.length - 1].filename : null,
              applied: mig.migrations.map((m) => m.filename),
            };
          } catch (err) {
            migrations.error = err.code || err.message || 'db_unavailable';
          }
          return sendJson(res, 200, {
            service: 'orchestrator-service',
            version: SERVICE_VERSION,
            migrations,
          });
        }

        // INTAKE-INTEGRATIONS-001: приём обращения о проблеме из приложения-источника.
        // Открыт МИМО orchestrator API-токена — авторизация по ТОКЕНУ ИНТЕГРАЦИИ,
        // который приложение шлёт в Authorization: Bearer <token> либо X-Intake-Token.
        // acceptIntakeReport сам валидирует токен, анти-спам и идемпотентность.
        if (req.method === 'POST' && p === '/api/intake/report') {
          const body = await readBody(req);
          const auth = req.headers['authorization'];
          const token = (auth && auth.startsWith('Bearer ') ? auth.slice(7) : '')
            || req.headers['x-intake-token'] || body.token || '';
          const result = await acceptIntakeReport(await loadSettings(), { ...body, token });
          publishTaskChange('intake_report_received', { taskId: result?.taskId ?? null });
          return sendJson(res, 200, result);
        }

        // FEEDBACK-WIDGET-001: приём обращений виджета «Обратная связь» UI оркестратора.
        // Same-origin, МИМО orchestrator API-токена (как /api/intake/report): backend сам
        // подставляет токен предзарегистрированной интеграции «orchestrator-ui» (секрет в
        // бандл не попадает) и переиспользует acceptIntakeReport — задача сразу в BACKLOG
        // под Приёмщиком, идемпотентность по externalId. Ответ — FeedbackResult.
        if (req.method === 'POST' && p === '/api/feedback') {
          const result = await acceptFeedback(await loadSettings(), await readBody(req));
          publishTaskChange('intake_report_received', { taskId: result?.taskId ?? null });
          return sendJson(res, 200, result);
        }

        // Загрузка скриншота обращения (data URL). Отдельный увеличенный лимит тела —
        // base64-скриншот превышает глобальные 1 МБ readBody. Ответ { id, url }; url
        // кладётся во screenshotUrl обращения и доступен GET-ом ниже.
        if (req.method === 'POST' && p === '/api/feedback/screenshot') {
          const body = await readBody(req, { maxBytes: FEEDBACK_SCREENSHOT_BODY_LIMIT });
          return sendJson(res, 200, await saveScreenshot(body.image));
        }

        // Отдача сохранённого скриншота обращения (ссылка из карточки задачи / <img>).
        // Открыт (same-origin запрос картинки не несёт API-токена).
        const feedbackShot = matchFeedbackScreenshotRoute(p);
        if (feedbackShot) {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
          const { buffer, mime } = await readScreenshot(feedbackShot.id);
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
          return res.end(buffer);
        }

        // /health и /api/version открыты для healthcheck; всё остальное под /api
        // требует токен, если он сконфигурирован.
        if (!isAuthorized(req, { allowQueryToken: p === '/api/tasks/events' }))
          return sendJson(res, 401, { error: 'unauthorized' });

        if (req.method === 'GET' && p === '/api/tasks/events') {
          return openTaskEventsStream(req, res);
        }

        // Рантайм-настройки приложения (APP-SETTINGS-001): параллельность runner и пр.
        if (req.method === 'GET' && p === '/api/app-settings')
          return sendJson(res, 200, await getAppSettings(await loadSettings()));

        // CONNECTOR-LIMITER-001: ёмкость внешнего LLM-коннектора. Сервисы
        // спрашивают перед отправкой: { free, canSend, limit, active, tpm, ... }.
        // canSend=false → есть смысл подождать, а не слать вызов вхолостую.
        if (req.method === 'GET' && p === '/api/connector/capacity')
          return sendJson(res, 200, { ...connectorCapacity(), buckets: connectorCapacityBuckets() });

        const serverRoute = matchServerRoute(p);
        if (serverRoute) {
          if (serverRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listServers());
          } else if (serverRoute.kind === 'actions') {
            if (req.method === 'POST') {
              const body = await readBody(req);
              return sendJson(res, 200, await runServerAction(serverRoute.id, body.action));
            }
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        if (req.method === 'PUT' && p === '/api/app-settings')
          return sendJson(res, 200, await updateAppSettings(await loadSettings(), await readBody(req)));

        // PERFORMANCE-MONITOR-001: НЕ-AI метрики оркестратора (read-only).
        // Опционально ?projectId=<uuid|code|root_path|name> сужает задачи проекта.
        if (req.method === 'GET' && p === '/api/performance')
          return sendJson(
            res,
            200,
            await getPerformanceMetrics(await loadSettings(), {
              projectId: url.searchParams.get('projectId'),
            }),
          );

        // VERSION-KPI-TRACKING-001: KPI роли по версиям (код/промт/модель) + дельты
        // к предыдущей версии + регресс-флаги. role обязателен.
        if (req.method === 'GET' && p === '/api/performance/versions')
          return sendJson(
            res,
            200,
            await getVersionMetrics(await loadSettings(), {
              role: url.searchParams.get('role'),
              windowHours: url.searchParams.get('windowHours'),
              projectId: url.searchParams.get('projectId'),
            }),
          );

        // ROLE-ENGINE-ROUTING-002: дневная статистика по коннекторам/моделям
        // (день → фактический connector/provider/model/driver). ?windowDays=N,
        // опционально ?projectId=<uuid|code|root_path|name>.
        if (req.method === 'GET' && p === '/api/performance/daily-models')
          return sendJson(
            res,
            200,
            await getDailyModelStats(await loadSettings(), {
              windowDays: url.searchParams.get('windowDays'),
              projectId: url.searchParams.get('projectId'),
            }),
          );

        // ROLE-LOAD-LAST-DATA-001: суммарные значения блока «Нагрузка по ролям» за
        // период (?period=month|week|day) — вкладка «Суммы». Окно заякорено к
        // последней активности (простой оркестратора не обнуляет данные).
        if (req.method === 'GET' && p === '/api/performance/role-load-totals')
          return sendJson(
            res,
            200,
            await getRoleLoadTotals(await loadSettings(), {
              period: url.searchParams.get('period'),
            }),
          );

        // Метки на оси времени KPI (правка промта/деплой/ручная отметка).
        if (req.method === 'GET' && p === '/api/kpi-markers')
          return sendJson(
            res,
            200,
            await getKpiMarkers(await loadSettings(), {
              role: url.searchParams.get('role'),
              windowHours: url.searchParams.get('windowHours'),
              limit: url.searchParams.get('limit'),
            }),
          );

        // Поставить метку вручную (например, «выкатил коммит abc123»).
        if (req.method === 'POST' && p === '/api/kpi-markers')
          return sendJson(res, 200, await createKpiMarker(await loadSettings(), await readBody(req)));

        // ORCHESTRATOR-AUDITOR-001: ручной запуск аудита оркестратора (off-route).
        if (req.method === 'POST' && p === '/api/audit/run')
          return sendJson(res, 200, await createAuditRun(await loadSettings(), await readBody(req)));

        if (req.method === 'GET' && p === '/api/audit/runs')
          return sendJson(
            res,
            200,
            await listAuditRuns(await loadSettings(), { limit: url.searchParams.get('limit') }),
          );

        // Сдача результата аудита исполнителем (внешняя сессия / будущий runner).
        const auditCompleteMatch = p.match(/^\/api\/audit\/runs\/([^/]+)\/complete$/);
        if (auditCompleteMatch && req.method === 'POST')
          return sendJson(
            res,
            200,
            await completeAuditRun(
              await loadSettings(),
              decodeURIComponent(auditCompleteMatch[1]),
              await readBody(req),
            ),
          );

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

        // Список реально применённых миграций БД (из таблицы _schema_migrations).
        if (req.method === 'GET' && p === '/api/db/migrations')
          return sendJson(res, 200, await getAppliedMigrations(await loadSettings()));

        // Перечень подключённых БД с живым статусом — для карточек в UI.
        if (req.method === 'GET' && p === '/api/databases')
          return sendJson(res, 200, await listDatabases(await loadSettings()));

        if (req.method === 'POST' && p === '/api/scanner/task-completed') {
          const result = await acceptScannerCompletion(await loadSettings(), await readBody(req));
          publishTaskChange('scanner_task_completed', { taskId: result?.task?.id ?? result?.taskId ?? null });
          return sendJson(res, 200, result);
        }

        // Интейк из файловой очереди tasks/*.md: импорт задачи со статусом
        // «выполнено» в БД (идемпотентно по external_id) → дальше runner ведёт цепочку.
        if (req.method === 'POST' && p === '/api/scanner/task-intake') {
          const result = await acceptScannerIntake(await loadSettings(), await readBody(req));
          publishTaskChange('scanner_task_intake', { taskId: result?.taskId ?? result?.id ?? null });
          return sendJson(res, 200, result);
        }

        // Обратный мост БД → файл: выдать Scanner-фидеру следующую задачу для Claude.
        if (req.method === 'GET' && p === '/api/runner/next-claude-task') {
          const result = await claimNextClaudeTask(await loadSettings());
          if (result?.task) publishTaskChange('claude_task_claimed', { taskId: result.task.id ?? null });
          return sendJson(res, 200, result);
        }

        // Откат захвата, если фидер не смог записать файл.
        if (req.method === 'POST' && p === '/api/runner/release-claude-task') {
          const body = await readBody(req);
          const taskId = body.taskId;
          // reason/meta опциональны: при reason='max_turns_exceeded' раннер
          // фиксирует упор программиста в лимит ходов — записываем событие KPI.
          const result = await releaseClaudeTask(await loadSettings(), taskId, {
            reason: body.reason, meta: body.meta,
          });
          publishTaskChange('claude_task_released', { taskId });
          return sendJson(res, 200, result);
        }

        // Host-мост: роли действия (PIPELINE_SERVICE/GIT_INTEGRATOR) исполняет
        // нативный host-runner — здесь он берёт задачу и сдаёт результат.
        if (req.method === 'GET' && p === '/api/runner/next-host-task') {
          const result = await claimNextHostTask(await loadSettings(), url.searchParams.get('role'));
          if (result?.task) publishTaskChange('host_task_claimed', { taskId: result.task.id ?? null });
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && p === '/api/runner/host-task-completed') {
          const body = await readBody(req);
          const result = await completeHostTask(await loadSettings(), body);
          publishTaskChange('host_task_completed', { taskId: body.taskId ?? null });
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && p === '/api/runner/release-host-task') {
          const taskId = (await readBody(req)).taskId;
          const result = await releaseHostTask(await loadSettings(), taskId);
          publishTaskChange('host_task_released', { taskId });
          return sendJson(res, 200, result);
        }

        // ROLE-ENGINE-ROUTING-001: generic-мост рассуждающих ролей на хостовые
        // драйверы. Роли, назначенные движку (codex/claude_code), исполняет
        // соответствующий драйвер; оркестратор отдаёт готовый промпт+схему и
        // принимает вердикт, прогоняя его тем же путём, что и DeepSeek.
        if (req.method === 'GET' && p === '/api/runner/next-reasoning-task') {
          const result = await claimNextReasoningTask(
            await loadSettings(), url.searchParams.get('engine'), url.searchParams.get('role'),
          );
          if (result?.task) publishTaskChange('reasoning_task_claimed', { taskId: result.task.id ?? null });
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && p === '/api/runner/reasoning-completed') {
          const body = await readBody(req);
          const result = await completeReasoningTask(await loadSettings(), body);
          publishTaskChange('reasoning_task_completed', { taskId: body.taskId ?? null });
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && p === '/api/runner/release-reasoning-task') {
          const taskId = (await readBody(req)).taskId;
          const result = await releaseReasoningTask(await loadSettings(), taskId);
          publishTaskChange('reasoning_task_released', { taskId });
          return sendJson(res, 200, result);
        }

        // Дерево задач для UI: Проект → Задача → Подзадача (read-only).
        if (req.method === 'GET' && p === '/api/tasks/tree')
          return sendJson(res, 200, await getTaskTree(await loadSettings()));

        // Счётчики задач по статусам (этапам) для «Схемы разработки» (read-only).
        if (req.method === 'GET' && p === '/api/tasks/stats')
          return sendJson(res, 200, await getTaskStatusCounts(await loadSettings()));

        // Задачи, прошедшие через конкретный этап схемы, и его результат (read-only).
        if (req.method === 'GET' && p === '/api/tasks/by-stage')
          return sendJson(
            res,
            200,
            await getTasksByStage(await loadSettings(), url.searchParams.get('roleId')),
          );

        // Хронология задачи: что сделала каждая роль по конкретной задаче (read-only).
        if (req.method === 'GET' && p === '/api/tasks/history')
          return sendJson(
            res,
            200,
            await getTaskHistory(await loadSettings(), url.searchParams.get('taskId')),
          );

        // Неразобранные задачи (project_id IS NULL) — корзина Приёмщика задач.
        if (req.method === 'GET' && p === '/api/tasks/unassigned')
          return sendJson(res, 200, await listUnassignedTasks(await loadSettings()));

        // Назначить неразобранной задаче проект → задача уходит по цепочке ролей.
        const assignMatch = p.match(/^\/api\/tasks\/([^/]+)\/assign-project$/);
        if (assignMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(assignMatch[1]);
          const body = await readBody(req);
          const result = await assignTaskProject(await loadSettings(), taskId, body.project ?? body.projectId);
          publishTaskChange('task_project_assigned', { taskId });
          return sendJson(res, 200, result);
        }

        // Продвинуть задачу на следующий этап маршрута проекта (авто, FORWARD).
        const advanceMatch = p.match(/^\/api\/tasks\/([^/]+)\/advance$/);
        if (advanceMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(advanceMatch[1]);
          const result = await advanceTask(await loadSettings(), taskId);
          publishTaskChange('task_advanced', { taskId });
          return sendJson(res, 200, result);
        }

        // Доска приёмки: завершённые задачи (DONE и CANCELLED) для подразделов
        // «Проверка» (не принятые DONE) и «Выполнено» (принятые DONE + все CANCELLED
        // с причиной отмены). Read-only.
        if (req.method === 'GET' && p === '/api/tasks/acceptance-board')
          return sendJson(res, 200, await getAcceptanceBoard(await loadSettings()));

        // Принять задачу из «Проверки» → она переходит в «Выполнено» (accepted_at).
        const acceptMatch = p.match(/^\/api\/tasks\/([^/]+)\/accept$/);
        if (acceptMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(acceptMatch[1]);
          const result = await acceptTask(await loadSettings(), taskId);
          publishTaskChange('task_accepted', { taskId });
          return sendJson(res, 200, result);
        }

        // Массовый перезапуск зависших задач: статус RESTART → Приёмщик берёт их сразу.
        if (req.method === 'POST' && p === '/api/tasks/restart-stuck') {
          const result = await restartStuckTasks(await loadSettings());
          publishTaskChange('tasks_restarted', { restarted: result.restarted });
          return sendJson(res, 200, result);
        }

        // Ручное перемещение задачи на выбранный этап проекта (manual, с аудитом).
        const moveMatch = p.match(/^\/api\/tasks\/([^/]+)\/move$/);
        if (moveMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(moveMatch[1]);
          const result = await moveTask(await loadSettings(), taskId, await readBody(req));
          publishTaskChange('task_moved', { taskId });
          return sendJson(res, 200, result);
        }

        // TASK-PRIORITY-SCALE-001: смена приоритета задачи из карточки/UI. Валидация в
        // db.js: 0 — только проект оркестратора; оркестраторную ниже 0 не понизить; без
        // вытеснения RUNNING (меняем только число). Принимаем PATCH и POST (совместимость).
        const priorityMatch = p.match(/^\/api\/tasks\/([^/]+)\/priority$/);
        if (priorityMatch && (req.method === 'PATCH' || req.method === 'POST')) {
          const taskId = decodeURIComponent(priorityMatch[1]);
          const body = await readBody(req);
          const result = await setTaskPriority(await loadSettings(), taskId, body.priority);
          publishTaskChange('task_priority_changed', { taskId });
          return sendJson(res, 200, result);
        }

        // --- Единая «Схема разработки» (общий конвейер ролей для всех проектов) ---
        if (p === '/api/development-scheme') {
          if (req.method === 'GET') return sendJson(res, 200, await getScheme(await loadSettings()));
          if (req.method === 'PUT')
            return sendJson(res, 200, await saveScheme(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Проекты: rich-список + идемпотентная регистрация по папке ---
        if (p === '/api/projects') {
          if (req.method === 'GET') return sendJson(res, 200, await listProjectsRich(await loadSettings()));
          if (req.method === 'POST')
            return sendJson(res, 200, await createOrUpsertProject(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Назначения «роль → коннектор» (role_connectors) ---
        if (p === '/api/role-connectors') {
          if (req.method === 'GET') return sendJson(res, 200, await listRoleConnectors(await loadSettings()));
          if (req.method === 'PUT')
            return sendJson(res, 200, await saveRoleConnectors(await loadSettings(), await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Единые подключения к БД (database_connections) — секрет не отдаётся ---
        const dbc = matchDbConnectionRoute(p);
        if (dbc) {
          if (dbc.kind === 'collection') {
            if (req.method === 'GET')
              return sendJson(res, 200, await listConnections(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createConnection(await loadSettings(), await readBody(req)));
          } else if (dbc.kind === 'item') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getConnection(await loadSettings(), dbc.id));
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateConnection(await loadSettings(), dbc.id, await readBody(req)));
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteConnection(await loadSettings(), dbc.id));
          } else if (dbc.kind === 'test') {
            if (req.method === 'POST')
              return sendJson(res, 200, await testConnectionById(await loadSettings(), dbc.id));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Доступные skill-файлы (только внутри настроенного каталога skills) ---
        if (p === '/api/skills') {
          if (req.method === 'GET') return sendJson(res, 200, await listAvailableSkills());
          if (req.method === 'POST') return sendJson(res, 201, await uploadSkill(await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Смысловые группы ролей (role_groups) ---
        const roleGroupRoute = matchRoleGroupRoute(p);
        if (roleGroupRoute) {
          if (roleGroupRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listRoleGroups(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createRoleGroup(await loadSettings(), await readBody(req)));
          } else {
            if (req.method === 'PUT')
              return sendJson(
                res,
                200,
                await updateRoleGroup(await loadSettings(), roleGroupRoute.id, await readBody(req)),
              );
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteRoleGroup(await loadSettings(), roleGroupRoute.id));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Карточка роли (description/prompt/skills/группа) ---
        const roleRoute = matchRoleRoute(p);
        if (roleRoute) {
          if (roleRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listRoles(await loadSettings()));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (roleRoute.kind === 'fields') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getRoleFields(await loadSettings(), roleRoute.code));
            if (req.method === 'PUT')
              return sendJson(res, 200, await saveRoleFields(await loadSettings(), roleRoute.code, await readBody(req)));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (roleRoute.kind === 'capabilities') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getRoleCapabilities(await loadSettings(), roleRoute.code));
            if (req.method === 'PUT')
              return sendJson(res, 200, await saveRoleCapabilities(await loadSettings(), roleRoute.code, await readBody(req)));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (roleRoute.kind === 'role-tools') {
            if (req.method === 'GET')
              return sendJson(res, 200, await getRoleTools(await loadSettings(), roleRoute.code));
            if (req.method === 'PUT')
              return sendJson(res, 200, await saveRoleTools(await loadSettings(), roleRoute.code, await readBody(req)));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (req.method === 'GET')
            return sendJson(res, 200, await getRole(await loadSettings(), roleRoute.code));
          if (req.method === 'PUT')
            return sendJson(res, 200, await updateRole(await loadSettings(), roleRoute.code, await readBody(req)));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Раздел «MCP роли» (роли, используемые через MCP) ---
        const mcpRoleRoute = matchMcpRoleRoute(p);
        if (mcpRoleRoute) {
          if (mcpRoleRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listMcpRoles(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createMcpRole(await loadSettings(), await readBody(req)));
            return sendJson(res, 405, { error: 'method_not_allowed' });
          }
          if (req.method === 'GET')
            return sendJson(res, 200, await getMcpRole(await loadSettings(), mcpRoleRoute.code));
          if (req.method === 'PUT')
            return sendJson(res, 200, await updateMcpRole(await loadSettings(), mcpRoleRoute.code, await readBody(req)));
          if (req.method === 'DELETE')
            return sendJson(res, 200, await deleteMcpRole(await loadSettings(), mcpRoleRoute.code));
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Реестр инструментов (tools): builtin + mcp ---
        const toolRoute = matchToolRoute(p);
        if (toolRoute) {
          if (toolRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listTools(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createTool(await loadSettings(), await readBody(req)));
          } else {
            if (req.method === 'GET')
              return sendJson(res, 200, await getTool(await loadSettings(), toolRoute.id));
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateTool(await loadSettings(), toolRoute.id, await readBody(req)));
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteTool(await loadSettings(), toolRoute.id));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Глобальный справочник полей (fields) ---
        const fieldRoute = matchFieldRoute(p);
        if (fieldRoute) {
          if (fieldRoute.kind === 'collection') {
            if (req.method === 'GET') return sendJson(res, 200, await listFields(await loadSettings()));
            if (req.method === 'POST')
              return sendJson(res, 201, await createField(await loadSettings(), await readBody(req)));
          } else {
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateField(await loadSettings(), fieldRoute.id, await readBody(req)));
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteField(await loadSettings(), fieldRoute.id));
          }
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }

        // --- Нативный выбор папки на хосте backend (абсолютный путь) ---
        if (p === '/api/fs/pick-folder') {
          if (req.method === 'POST') return sendJson(res, 200, await pickFolder());
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
          if (proj.kind === 'scanner') {
            if (req.method === 'PATCH')
              return sendJson(
                res,
                200,
                await setProjectScanner(await loadSettings(), proj.id, (await readBody(req)).enabled),
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

        // --- INTAKE-INTEGRATIONS-001: реестр интеграций-источников обращений ---
        // (раздел «Интеграции обращений» в карточке роли Task Intake Officer).
        // Управление под orchestrator API-токеном; сам приём обращений — отдельный
        // открытый endpoint /api/intake/report (авторизация по токену интеграции).
        const intake = matchIntakeIntegrationRoute(p);
        if (intake) {
          if (intake.kind === 'collection') {
            if (req.method === 'GET')
              return sendJson(res, 200, { integrations: await listIntakeIntegrations() });
            if (req.method === 'POST')
              return sendJson(res, 201, await createIntakeIntegration(await readBody(req)));
          } else if (intake.kind === 'stats') {
            if (req.method === 'GET') return sendJson(res, 200, await getIntakeStats());
          } else if (intake.kind === 'item') {
            if (req.method === 'GET') return sendJson(res, 200, await getIntakeIntegration(intake.id));
            if (req.method === 'PUT')
              return sendJson(res, 200, await updateIntakeIntegration(intake.id, await readBody(req)));
            if (req.method === 'DELETE')
              return sendJson(res, 200, await deleteIntakeIntegration(intake.id));
          } else if (intake.kind === 'rotate') {
            if (req.method === 'POST')
              return sendJson(res, 200, await rotateIntakeIntegrationToken(intake.id));
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
