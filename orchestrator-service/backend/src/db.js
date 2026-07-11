// Работа с PostgreSQL: проверка подключения, автосоздание БД, миграции, seed.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW, fastForwardHiddenRoles } from './rolePipeline.js';
import { runReasoningRole, decideOutcome, summarizePriorRuns, LLM_ROLE_CODES, MAX_REWORK, buildUserPayload, buildVerdictJsonSchema, normalizeVerdict, parseVerdict, renderProjectMaps, isMissingArtifactComplaint, REVIEW_DELTA_ROLES } from './roleEngine.js';
import { buildRoute, resolveTransition, forwardFrom, routeIsUsable, TERMINAL_STATUSES } from './projectRoute.js';
import { buildGraph, nextNodeKey, forkBranchKeys, nodeByKey, reworkNodeKey } from './graphRoute.js';
import { extractOutputs, missingRequiredInputs } from './fieldsContract.js';
import { buildPipelineClaimContract } from './pipelineDispatch.js';
import { deriveServicePathFromFiles, resolveServiceRepoPath } from './serviceRepoPath.js';
import { reconcileClockSkew } from './clockGuard.js';
import { isDbConnectionError, noteDbConnectionFailure, claimGraceActive } from './bootClaimGuard.js';
import { resolveDuration, resolveInt, logEffectiveConfig, parseDurationMs } from './envConfig.js';
import { asObject, parseDataCard } from './dataCard.js';
import { isDriverProvider } from './connectors.js';
import { hashToken, messageFingerprint } from './intakeIntegrations.js';
import { exportLatestAgentRunObservation } from './clickhouseObservability.js';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || resolve(__dirname, '../db/migrations');
export const SEED_DIR = process.env.SEED_DIR || resolve(__dirname, '../db/seed');

export function clientConfig(s, database) {
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: database || s.database,
  };
}

function assertIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Недопустимое имя базы данных: "${name}"`);
  }
}

// ROLE-ENGINE-ROUTING-002 — снимок коннектора роли для agent_runs. Источник истины
// «чем исполнялся прогон»: включённый коннектор, назначенный коду роли в карточке
// роли (role_connectors → «Движок»). Возвращает неизменяемый снимок
// { connectorId, provider, model, driverType } на момент захвата задачи; все поля
// null, если роли не назначен включённый коннектор (исторические/локальные прогоны).
// driverType: 'driver' (хостовый движок codex/claude_code) либо 'api' (сетевой AI-API).
async function resolveConnectorSnapshot(c, roleCode) {
  const empty = { connectorId: null, provider: null, model: null, driverType: null };
  const code = String(roleCode ?? '').trim();
  if (!code) return empty;
  const r = await c.query(
    `SELECT cn.id::text AS id, cn.provider, cn.model
       FROM role_connectors rc
       JOIN connectors cn ON cn.id = rc.connector_id
      WHERE rc.role_code = $1 AND cn.is_enabled = true
      ORDER BY cn.priority ASC, cn.updated_at DESC
      LIMIT 1`,
    [code],
  );
  if (!r.rowCount) return empty;
  const row = r.rows[0];
  const provider = row.provider == null ? null : String(row.provider);
  return {
    connectorId: row.id ?? null,
    provider,
    model: row.model ? String(row.model) : null,
    driverType: provider == null ? null : (isDriverProvider(provider) ? 'driver' : 'api'),
  };
}

export async function withClient(cfg, fn) {
  const client = new Client(cfg);
  // DB-CONN-RESILIENCE-001: node-postgres эмитит на Client событие 'error' при
  // обрыве соединения (Patroni/PgBouncer/HAProxy периодически рвут коннект при
  // переключении лидера). Без слушателя 'error' Node роняет ВЕСЬ процесс
  // («Unhandled 'error' event»), и контейнер уходит в рестарт-луп. Слушатель
  // делает обрыв нефатальным: in-flight запрос всё равно отклонится и будет
  // обработан вызывающим (tick runner'а ловит ошибку и повторит на след. тике).
  client.on('error', (err) => {
    console.error(`[orchestrator-service] DB client error (не фатально): ${err.message}`);
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    // end() сам может бросить, если соединение уже оборвано — это не должно
    // маскировать исходную ошибку и не должно ронять процесс.
    try {
      await client.end();
    } catch (endErr) {
      console.error(`[orchestrator-service] DB client.end() error (игнор): ${endErr.message}`);
    }
  }
}

// Резолв id роли по её коду. Инлайн-форма
//   (await c.query('SELECT id FROM roles WHERE code = $1', [x])).rows[0]?.id ?? null
// повторялась в advanceOne/host/reasoning-путях — сведена в один хелпер.
// Нет роли с таким кодом → null (вызывающий сам решает, что делать).
async function roleIdByCode(c, code) {
  return (await c.query('SELECT id FROM roles WHERE code = $1', [code])).rows[0]?.id ?? null;
}

// Проверка подключения к серверу + существует ли целевая БД.
export async function testConnection(s) {
  return withClient(clientConfig(s, s.adminDatabase), async (c) => {
    const v = await c.query('SELECT version() AS version');
    const ex = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [s.database]);
    return {
      ok: true,
      serverVersion: v.rows[0].version,
      database: s.database,
      databaseExists: ex.rowCount > 0,
    };
  });
}

// «Создать базу, если её нет».
export async function ensureDatabase(s) {
  assertIdentifier(s.database);
  return withClient(clientConfig(s, s.adminDatabase), async (c) => {
    const ex = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [s.database]);
    if (ex.rowCount > 0) return { created: false };
    await c.query(`CREATE DATABASE "${s.database}"`);
    return { created: true };
  });
}

// Накат миграций. Идемпотентно: отслеживаем применённые файлы в _schema_migrations.
export async function runMigrations(s) {
  return withClient(clientConfig(s), async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM _schema_migrations WHERE filename = $1', [f]);
      if (done.rowCount > 0) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      await c.query(sql);
      await c.query('INSERT INTO _schema_migrations(filename) VALUES ($1)', [f]);
      applied.push(f);
    }
    return { applied };
  });
}

// Загрузка примеров данных (seed). Сид-файлы написаны идемпотентно (ON CONFLICT).
export async function runSeed(s) {
  return withClient(clientConfig(s), async (c) => {
    const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      const sql = await readFile(join(SEED_DIR, f), 'utf8');
      await c.query(sql);
      applied.push(f);
    }
    return { applied };
  });
}

// Полная инициализация: создать БД (если нет) + накатить миграции.
export async function bootstrap(s) {
  const db = await ensureDatabase(s);
  const mig = await runMigrations(s);
  return { created: db.created, migrated: mig.applied };
}

// Текущее состояние целевой БД (для дашборда).
export async function getStatus(s) {
  try {
    return await withClient(clientConfig(s), async (c) => {
      const t = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      const m = await c
        .query('SELECT filename FROM _schema_migrations ORDER BY filename')
        .catch(() => ({ rows: [] }));
      const counts = {};
      for (const tbl of ['projects', 'services', 'roles', 'agents', 'tasks']) {
        const r = await c
          .query(`SELECT count(*)::int AS n FROM ${tbl}`)
          .catch(() => ({ rows: [{ n: null }] }));
        counts[tbl] = r.rows[0].n;
      }
      return {
        connected: true,
        database: s.database,
        tables: t.rows[0].n,
        migrations: m.rows.map((r) => r.filename),
        rowCounts: counts,
      };
    });
  } catch (e) {
    return { connected: false, database: s.database, error: e.message };
  }
}

/**
 * Список РЕАЛЬНО применённых миграций БД. Источник истины учёта — таблица
 * `_schema_migrations` (filename PK + applied_at), которую ведёт runMigrations:
 * каждый накатанный файл из db/migrations попадает туда ровно один раз.
 * Возвращает { count, migrations: [{ filename, appliedAt }] } в порядке filename.
 */
export async function getAppliedMigrations(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c
      .query('SELECT filename, applied_at FROM _schema_migrations ORDER BY filename')
      .catch(() => ({ rows: [] }));
    const migrations = r.rows.map((row) => ({
      filename: row.filename,
      appliedAt: row.applied_at,
    }));
    return { count: migrations.length, migrations };
  });
}

// COMPLETION-SUMMARY-TEXT-001 — текстовый summary сдачи из поля result. Раннер
// программиста шлёт result ОБЪЕКТОМ ({ summary, outcome, agent, ... }); наивный
// String(object) давал «[object Object]» в task_events, в output_json прогона и в
// priorRoleOutputs следующих ролей (теряя читаемую сдачу). Строка → как есть;
// объект → .summary (иначе JSON); null/undefined → ''.
function resultSummaryText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.summary === 'string' && result.summary.trim()) return result.summary;
    try { return JSON.stringify(result); } catch { return ''; }
  }
  return result == null ? '' : String(result);
}

// PROGRAMMER-UNIFY-001 — финализировать RUNNING-прогон программиста при успешной
// сдаче. Захват создал ровно один agent_run RUNNING на эту задачу под ролью
// PROGRAMMER; переводим его в SUCCESS с KPI (turns=passes, model, code_version) —
// так программист считается в «Мониторе» (roleLoad) и версиях единообразно с
// рассуждающими ролями. Толерантно: нет прогона (legacy/прямое создание задачи) —
// 0 строк, сдача не падает. roleId — роль на момент ЗАХВАТА (PROGRAMMER), а не
// после продвижения задачи.
// BOOT-RECONCILE-GRACE-001: сопоставляем последний прогон в статусе RUNNING ЛИБО
// TIMEOUT. Claude-агент переживает рестарт оркестратора и досдаёт результат; если
// boot-жнец успел пометить прогон TIMEOUT, поздняя сдача переписывает исход на
// фактический SUCCESS (иначе KPI роли навсегда считает реально успешный прогон
// таймаутом). Свежий RUNNING имеет больший started_at и выбирается раньше старого
// TIMEOUT, поэтому переписываем именно осиротевший прогон этой сдачи.
async function finalizeProgrammerRunOnCompletion(c, { taskId, roleId, payload }) {
  if (roleId == null) return;
  // Читаемый summary (не «[object Object]») в output_json прогона — его же тянет
  // priorRoleOutputs в контекст следующих ролей.
  const summary = (resultSummaryText(payload?.result) || payload?.title || 'completed').slice(0, 2000);
  // OBSERVABILITY-PROGRAMMER-KPI-001 — usage/cost/cold start сдачи программиста в
  // agent_runs через те же хелперы, что и рассуждающие роли. Контракт с раннером:
  // tokensIn/tokensOut/tokensCacheRead/tokensCacheCreation/costUsd/coldStartMs +
  // numTurns (→ turns). token_input/output/cache/cost идут через COALESCE в
  // runKpiSet, поэтому СТАРЫЙ раннер без этих полей не затирает данные (остаются
  // нули/прежние значения) — обратная совместимость. Исход сдачи — всегда success.
  const kpi = normalizeRunKpi({ ...payload, turns: payload?.numTurns, outcome: 'success' });
  const outputJson = JSON.stringify({ status: 'DONE', summary, changedFiles: payload?.changedFiles ?? [] });
  const kpiSet = runKpiSet(kpi, 2);
  const roleIdx = 2 + kpiSet.params.length + 1;
  await c.query(
    `UPDATE agent_runs
        SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql}
      WHERE id = (
        SELECT id FROM agent_runs
         WHERE task_id = $1 AND role_id = $${roleIdx} AND status IN ('RUNNING','TIMEOUT')
         ORDER BY started_at DESC LIMIT 1
      )`,
    [taskId, outputJson, ...kpiSet.params, roleId],
  );
}

// STALE-COMPLETION-ROLE-GUARD-001 — вывести роль-источник сдачи из completionKey.
// Ключ сдачи программиста имеет вид `programmer-${taskRowId}-${agentAssignedEventId}`
// (см. claimNextClaudeTask), поэтому префикс кодирует роль-исполнителя, сделавшую
// сдачу. Неизвестный формат → null: ожидание роли не задаётся и guard не срабатывает
// (обратная совместимость с ключами без префикса роли).
function roleFromCompletionKey(key) {
  return String(key ?? '').startsWith('programmer-') ? 'PROGRAMMER' : null;
}

// REVIEWER-ONE-REWORK-001: считаем только реальные возвраты reviewer на Programmer.
// Общий reworkCount исторически считает FAILURE_ANALYSIS и не защищает эту петлю.
async function countTaskReviewerReworks(c, taskId) {
  const r = await c.query(
    `SELECT count(*)::int AS n
       FROM task_events e
       JOIN roles r ON r.id = e.role_id
      WHERE e.task_id = $1
        AND r.code = 'TASK_REVIEWER'
        AND e.from_status = 'REVIEW'
        AND e.to_status = 'CODING'
        AND e.payload_json->>'outcome' = 'REWORK'`,
    [taskId],
  );
  return Number(r.rows[0]?.n) || 0;
}

async function resolveAfterSkippedReviewer(c, route, task, currentStatus, currentStageKey) {
  if (routeIsUsable(route)) {
    const resolved = resolveTransition(route, 'TASK_REVIEWER', { outcome: 'FORWARD' }, {
      currentStatus,
      currentStageKey,
    });
    return {
      toStatus: resolved.toStatus,
      nextRoleCode: resolved.nextRole,
      nextStageKey: resolved.nextStageKey ?? null,
      nextRoleId: resolved.done || !resolved.nextRole ? null : await roleIdByCode(c, resolved.nextRole),
    };
  }
  const flow = ROLE_FLOW.TASK_REVIEWER;
  return {
    toStatus: flow.to,
    nextRoleCode: flow.next,
    nextStageKey: null,
    nextRoleId: flow.next ? await roleIdByCode(c, flow.next) : null,
  };
}

/**
 * Принять завершение от файлового Scanner bridge и передать задачу Task Reviewer.
 * scanner_dispatches и транзакция обеспечивают exactly-once переход на стороне БД.
 */
export async function acceptScannerCompletion(s, input) {
  const payload = normalizeScannerCompletion(input);
  return withClient(clientConfig(s), async (c) => {
    const result = await acceptScannerCompletionTx(c, payload);
    if (result?.accepted && !result.duplicate) {
      await exportLatestAgentRunObservation(c, result.taskId || payload.taskId, {
        eventType: 'programmer_completion',
        roleCode: 'PROGRAMMER',
        reason: result.kind === 'subtask' ? 'programmer_subtask_done' : 'programmer_completed',
        payload: { result },
      });
    }
    return result;
  });
}

/**
 * Транзакционное ядро приёма завершения Programmer (тестируется с fake-клиентом).
 * payload уже нормализован normalizeScannerCompletion.
 */
export async function acceptScannerCompletionTx(c, payload) {
  {
    await c.query('BEGIN');
    try {
      // Задачи может не быть в БД (её завели прямо в документе Claude) — тогда
      // Scanner создаёт её ПО координатам completion, но только внутри уже
      // зарегистрированного вручную проекта и сервиса. Проверки соответствия
      // проекта/сервиса и их существования выполняет findOrCreateScannerTask.
      const { task, created } = await findOrCreateScannerTask(c, payload);
      if (['DONE', 'CANCELLED'].includes(task.status)) throw scannerError(409, 'task_is_terminal');

      const inserted = await c.query(
        `INSERT INTO scanner_dispatches
           (task_id, source_document, completion_key, payload_json)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (task_id, completion_key) DO NOTHING
         RETURNING id`,
        [payload.taskId, payload.sourceDocument, payload.completionKey, JSON.stringify(payload)],
      );
      if (!inserted.rowCount) {
        await c.query('COMMIT');
        return { accepted: true, duplicate: true, autoCreated: created, taskId: payload.taskId, nextRole: 'TASK_REVIEWER' };
      }

      // STALE-COMPLETION-ROLE-GUARD-001: сдача, чей completionKey кодирует роль
      // PROGRAMMER (префикс `programmer-`), НЕ может закрывать этап, чей текущий
      // исполнитель — другая роль (задача уже ушла с CODING, напр. держится
      // PIPELINE_SERVICE на TESTING). Иначе fromRole берётся из
      // task.current_role_code и resolveTransition(FORWARD) закрывает ЧУЖОЙ этап
      // именем программиста — так дубль/опоздавшая сдача программиста закрыла TESTING
      // в COMMIT и затёрла changedFiles реальной сдачи (инцидент f43a9f6c). Дедуп по
      // (task_id, completion_key) это не ловит, если у сдачи новый ключ. Маршрут не
      // продвигаем; dispatch уже зафиксирован как «увиден и проигнорирован» —
      // фиксируем транзакцию и возвращаем сдачу как stale-дубль.
      const expectedRole = roleFromCompletionKey(payload.completionKey);
      if (expectedRole && task.current_role_code && task.current_role_code !== expectedRole) {
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: true, stale: true, autoCreated: created,
          taskId: payload.taskId, currentRole: task.current_role_code,
          expectedRole, nextRole: null,
        };
      }

      // Завершение Programmer → продвижение по маршруту проекта
      // (PIPELINE-DYNAMIC-ROUTE-001). Канонический фолбэк — REVIEW/TASK_REVIEWER.
      const route = await loadProjectRoute(c, task.project_id);
      const fromRole = task.current_role_code || 'PROGRAMMER';
      let toStatus = 'REVIEW';
      let nextRoleId = task.reviewer_role_id;
      let nextRoleCode = 'TASK_REVIEWER';
      // FORK-JOIN-STAGEKEY-001: при продвижении Programmer'а переносим и ПОЗИЦИЮ в
      // графе (current_stage_key), а не только status/role. Иначе задача с непустым
      // stage_key (graph-режим — её порождают Архитектор/work_stack) уходила в REVIEW,
      // но stage_key застревал на узле Programmer, и guard захвата claimLlmRoleTask
      // (ps.stage_key = current_stage_key) для этапа ревьюера не совпадал — задачу не
      // брал ни один движок и она зависала в REVIEW. Зеркалим host-путь
      // (completeHostTaskTx: current_stage_key = resolved.nextStageKey ?? null).
      // Линейный/канонический маршрут (route не usable) оставляет NULL — guard
      // трактует NULL как wildcard, поэтому такие задачи claim'ятся как раньше.
      let nextStageKey = null;
      if (routeIsUsable(route)) {
        const resolved = resolveTransition(route, fromRole, { outcome: 'FORWARD' }, {
          currentStatus: task.status,
          currentStageKey: task.current_stage_key,
        });
        toStatus = resolved.toStatus;
        nextRoleCode = resolved.nextRole;
        nextStageKey = resolved.nextStageKey ?? null;
        nextRoleId = resolved.done || !resolved.nextRole
          ? null
          : await roleIdByCode(c, resolved.nextRole);
      }
      let skippedReviewer = false;
      if (nextRoleCode === 'TASK_REVIEWER' && (await countTaskReviewerReworks(c, payload.taskId)) >= 1) {
        const skipped = await resolveAfterSkippedReviewer(c, route, task, toStatus, nextStageKey);
        toStatus = skipped.toStatus;
        nextRoleCode = skipped.nextRoleCode;
        nextStageKey = skipped.nextStageKey;
        nextRoleId = skipped.nextRoleId;
        skippedReviewer = true;
      }

      // Поля Programmer → кумулятивная карточка задачи.
      const progContract = await loadRoleContract(c, fromRole);
      const { values: progCardValues, missingRequired } = extractOutputs(
        payload.fields ?? { result: payload.result, changedFiles: payload.changedFiles },
        progContract.outputs,
      );
      // Строгий режим контракта роли: вернуть задачу нельзя, пока заполнены не все
      // обязательные исходящие поля. «Настройка» — сам контракт (role_fields): если
      // обязательных полей у роли нет, missingRequired пуст и сдача проходит без
      // требований. ROLLBACK откатит и запись scanner_dispatches, чтобы повтор с
      // заполненными полями не считался дублем.
      if (missingRequired.length) {
        const err = scannerError(422, 'missing_required_fields');
        err.code = 'missing_required_fields';
        err.errors = missingRequired;
        throw err;
      }

      // DECOMP-CONTRACT-001: подзадача-на-файл при сдаче закрывается в DONE
      // (терминально), а её родитель (задача-на-сервис) уходит в REVIEW к Task
      // Reviewer ТОЛЬКО когда у него не осталось открытых подзадач. Одиночные
      // legacy-задачи (kind != subtask) ведут себя как раньше — сразу в REVIEW.
      if (task.task_kind === 'subtask') {
        await c.query(
          `UPDATE tasks SET status = 'DONE', assigned_agent_id = NULL, data_card = data_card || $2::jsonb
            WHERE id = $1`,
          [payload.taskId, JSON.stringify(progCardValues || {})],
        );
        await c.query(
          `INSERT INTO task_events
             (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_DONE', $2::task_status, 'DONE', $3, $4::jsonb)`,
          [payload.taskId, task.status, task.current_role_id, JSON.stringify({
            source: 'scanner', completionKey: payload.completionKey, service: payload.service,
            result: resultSummaryText(payload.result), changedFiles: payload.changedFiles,
            worktreeBranch: payload.worktreeBranch, deliveredCommit: payload.deliveredCommit,
            fields: progCardValues,
            parentTaskId: task.parent_task_id, kind: 'subtask', passes: payload.numTurns,
            codeVersion: payload.codeVersion, model: payload.model,
          })],
        );
        // Промоут родителя, если открытых подзадач не осталось.
        let parentPromoted = false;
        if (task.parent_task_id) {
          const open = await c.query(
            `SELECT count(*)::int AS n FROM tasks
              WHERE parent_task_id = $1 AND task_kind = 'subtask'
                AND status NOT IN ('DONE','CANCELLED')`,
            [task.parent_task_id],
          );
          if (open.rows[0].n === 0) {
            const parent = await c.query(
              `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
                      current_stage_key = $4::uuid
                WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'
                RETURNING status`,
              [task.parent_task_id, toStatus, nextRoleId, nextStageKey],
            );
            if (parent.rowCount) {
              parentPromoted = true;
              await c.query(
                `INSERT INTO task_events
                   (task_id, event_type, from_status, to_status, role_id, payload_json)
                 VALUES ($1, 'STATUS_CHANGED', 'WAITING_FOR_CHILDREN', $4::task_status, $2, $3::jsonb)`,
                [task.parent_task_id, nextRoleId, JSON.stringify({
                  source: 'scanner', reason: 'all_subtasks_done', nextRole: nextRoleCode, kind: 'service',
                  skippedReviewer,
                }), toStatus],
              );
            }
          }
        }
        await finalizeProgrammerRunOnCompletion(c, {
          taskId: payload.taskId, roleId: task.current_role_id, payload,
        });
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: false, autoCreated: created, taskId: payload.taskId,
          kind: 'subtask', parentTaskId: task.parent_task_id, parentPromoted,
          nextRole: parentPromoted ? nextRoleCode : null,
        };
      }

      await c.query(
        `UPDATE tasks
         SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
             data_card = data_card || $4::jsonb, current_stage_key = $5::uuid
         WHERE id = $1`,
        [payload.taskId, toStatus, nextRoleId, JSON.stringify(progCardValues || {}), nextStageKey],
      );
      await c.query(
        `INSERT INTO task_events
           (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, $5::task_status, $3, $4::jsonb)`,
        [payload.taskId, task.status, nextRoleId, JSON.stringify({
          source: 'scanner',
          completionKey: payload.completionKey,
          service: payload.service,
          result: resultSummaryText(payload.result),
          changedFiles: payload.changedFiles,
          worktreeBranch: payload.worktreeBranch,
          deliveredCommit: payload.deliveredCommit,
          nextRole: nextRoleCode,
          skippedReviewer,
          skipReason: skippedReviewer ? 'review_rework_limit_forwarded' : undefined,
          fields: progCardValues,
          passes: payload.numTurns,
          codeVersion: payload.codeVersion,
          model: payload.model,
        }), toStatus],
      );
      await finalizeProgrammerRunOnCompletion(c, {
        taskId: payload.taskId, roleId: task.current_role_id, payload,
      });
      await c.query('COMMIT');
      return { accepted: true, duplicate: false, autoCreated: created, taskId: payload.taskId, nextRole: nextRoleCode };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
}

// Найти проект по id (uuid) | code | name | root_path. В отличие от requireProject
// НЕ бросает ошибку при отсутствии — возвращает null (для интейка: нет проекта →
// задача становится «неразобранной»). Сравнение по id через ::text безопасно для
// произвольной строки (без падения на не-uuid).
async function findProject(c, ref) {
  const v = String(ref ?? '').trim();
  if (!v) return null;
  const r = await c.query(
    `SELECT id, code, root_path FROM projects
      WHERE id::text = $1 OR code = $1 OR name = $1 OR root_path = $1
      ORDER BY created_at LIMIT 1`,
    [v],
  );
  return r.rowCount ? r.rows[0] : null;
}

// =====================================================================
// TASK-PRIORITY-SCALE-001 — шкала приоритетов задач (SMALLINT, меньше = важнее).
//   0 — зарезервирован ЗА ПРОЕКТОМ ОРКЕСТРАТОРА (форсит сервер);
//   1 — максимальный пользовательский; 2 — обычный (дефолт); 3 — низкий.
// =====================================================================

// Проект оркестратора: code = env ORCHESTRATOR_PROJECT_CODE (по умолчанию 'PROJECT')
// ИЛИ root_path содержит 'ai-dev-manager'. Принимает строку проекта из БД
// ({ code, root_path }); null/пустой → false.
export function isOrchestratorProject(projectRow) {
  if (!projectRow) return false;
  const orchCode = String(process.env.ORCHESTRATOR_PROJECT_CODE || 'PROJECT').trim().toLowerCase();
  const code = String(projectRow.code ?? '').trim().toLowerCase();
  if (code && code === orchCode) return true;
  const rootPath = String(projectRow.root_path ?? projectRow.rootPath ?? '');
  return /ai-dev-manager/i.test(rootPath);
}

// Нормализация ПОЛЬЗОВАТЕЛЬСКОГО приоритета к диапазону 1..3: 0 (и любое ≤0) → 1
// (клиент не может задать 0 — это привилегия сервера), >3 → 3, пусто/мусор → дефолт (2).
export function normalizeClientPriority(requested, def = 2) {
  if (requested === null || requested === undefined || requested === '') return def;
  const n = Math.trunc(Number(requested));
  if (!Number.isFinite(n)) return def;
  if (n <= 0) return 1;
  if (n >= 3) return 3;
  return n;
}

// Итоговый приоритет задачи при создании/смене проекта: проект оркестратора → 0
// (форс сервера), иначе нормализованный пользовательский (1..3, дефолт 2).
export function computeTaskPriority(projectRow, requested, def = 2) {
  if (isOrchestratorProject(projectRow)) return 0;
  return normalizeClientPriority(requested, def);
}

// Вычислить роль входа, стартовый узел графа и стартовый статус для задачи проекта.
// В граф-схеме (есть рёбра) задача стартует на узле с ролью входа; в линейной —
// stageKey NULL. Для неразобранной задачи (projectId = null) рёбер нет → stageKey NULL.
//
// TASK-INTAKE-OFFICER-MCP-001: entryRoleCode позволяет постановщику через MCP сдать
// уже выполненный интейк напрямую в целевую роль (например ARCHITECT) — задача
// создаётся сразу в статусе её этапа (ARCHITECTURE), минуя пайплайновый Приёмщик/
// BACKLOG. Если запрошенная роль входа не разрешается в включённый этап проекта —
// безопасный откат к штатному входу (Приёмщик, BACKLOG).
async function computeEntry(c, projectId, entryRoleCode = null) {
  const requested = String(entryRoleCode ?? '').trim().toUpperCase() || null;
  if (requested && projectId) {
    const r = await c.query(
      `SELECT r.id, r.code, ps.stage_key, ps.task_status::text AS task_status,
              EXISTS (SELECT 1 FROM project_stage_edges e WHERE e.project_id = $1) AS has_edges
         FROM project_stages ps
         JOIN project_stage_roles psr ON psr.stage_id = ps.id
         JOIN roles r ON r.id = psr.role_id
        WHERE ps.project_id = $1 AND r.code = $2 AND ps.enabled = true
          AND ps.task_status IS NOT NULL
        ORDER BY ps.position LIMIT 1`,
      [projectId, requested],
    );
    if (r.rowCount) {
      const row = r.rows[0];
      return {
        role: { id: row.id, code: row.code },
        entryStageKey: row.has_edges ? row.stage_key : null,
        status: row.task_status,
      };
    }
    // Роль входа не нашлась среди включённых этапов проекта — падаем на штатный вход.
  }
  const role = await entryRole(c);
  if (!projectId) return { role, entryStageKey: null, status: 'BACKLOG' };
  const hasEdges = (await c.query(
    'SELECT 1 FROM project_stage_edges WHERE project_id = $1 LIMIT 1', [projectId],
  )).rowCount > 0;
  let entryStageKey = null;
  if (hasEdges) {
    const es = await c.query(
      `SELECT ps.stage_key FROM project_stages ps
         JOIN project_stage_roles psr ON psr.stage_id = ps.id
        WHERE ps.project_id = $1 AND psr.role_id = $2 AND ps.enabled = true
        ORDER BY ps.position LIMIT 1`,
      [projectId, role.id],
    );
    entryStageKey = es.rows[0]?.stage_key ?? null;
  }
  return { role, entryStageKey, status: 'BACKLOG' };
}

// Роль входа задачи в конвейер: Приёмщик задач (TASK_INTAKE_OFFICER), иначе первая
// роль единой схемы, иначе ARCHITECT. Scanner создаёт задачу под этой ролью.
async function entryRole(c) {
  const intake = await c.query(`SELECT id FROM roles WHERE code = 'TASK_INTAKE_OFFICER'`);
  if (intake.rowCount) return { id: intake.rows[0].id, code: 'TASK_INTAKE_OFFICER' };
  const first = await c.query(
    `SELECT r.id, r.code FROM global_stages gs
       JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
       JOIN roles r ON r.id = gsr.role_id
      WHERE gs.enabled = true ORDER BY gs.position, gsr.position LIMIT 1`,
  );
  if (first.rowCount) return { id: first.rows[0].id, code: first.rows[0].code };
  const arch = await c.query(`SELECT id FROM roles WHERE code = 'ARCHITECT'`);
  return { id: arch.rows[0]?.id ?? null, code: 'ARCHITECT' };
}

/**
 * TASK-DUPLICATE-CLOSE-001 — поиск живого «оригинала» по отпечатку текста
 * (messageFingerprint в data_card). Ловит повторную подачу одной и той же задачи
 * с РАЗНЫМИ external_id (пользователь дважды отправил репорт из виджета,
 * постановщик повторно завёл ту же задачу) — идемпотентность по external_id такое
 * не видит. Скоуп: канал интеграции (intakeIntegrationId) ЛИБО проект (projectId,
 * включая NULL-пул неразобранных). Дублем считаем только НЕтерминальную задачу
 * (DONE/CANCELLED/FAILED не в счёт: повторное обращение после закрытия может быть
 * регрессом, а не дублем) не старше 30 дней.
 */
export async function findDuplicateTaskTx(c, { intakeIntegrationId = null, projectId, serviceId = undefined, fingerprint }) {
  const fp = String(fingerprint ?? '');
  if (!fp) return null;
  let r;
  if (intakeIntegrationId) {
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE intake_integration_id = $1 AND data_card->>'messageFingerprint' = $2
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      [intakeIntegrationId, fp],
    );
  } else if (projectId) {
    const serviceFilter = serviceId !== undefined ? 'AND service_id IS NOT DISTINCT FROM $3' : '';
    const params = serviceId !== undefined ? [projectId, fp, serviceId] : [projectId, fp];
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE project_id = $1 AND data_card->>'messageFingerprint' = $2
          ${serviceFilter}
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      params,
    );
  } else {
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE project_id IS NULL AND data_card->>'messageFingerprint' = $1
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      [fp],
    );
  }
  return r.rowCount ? r.rows[0] : null;
}

// TASK-DUPLICATE-CLOSE-001 — создать задачу-дубль СРАЗУ закрытой (CANCELLED) со
// ссылкой на оригинал: след подачи сохраняется в журнале (карточка + события
// TASK_CREATED/TASK_CANCELLED), но конвейер повторную работу не запускает.
async function insertDuplicateClosedTaskTx(c, {
  projectId = null, serviceId = null, externalId = null, intakeIntegrationId = null,
  title, description, roleId = null, dataCard, duplicateOf, source,
}) {
  const card = {
    ...asObject(dataCard),
    duplicateOf,
    duplicateNote: `Дубль живой задачи ${duplicateOf} (совпал отпечаток текста): закрыт автоматически`,
  };
  const ins = await c.query(
    `INSERT INTO tasks
       (project_id, service_id, external_id, intake_integration_id, title, description,
        status, current_role_id, current_stage_key, created_by, data_card)
     VALUES ($1, $2, $3, $4, $5, $6, 'CANCELLED'::task_status, NULL, NULL, $7, $8::jsonb)
     RETURNING id`,
    [projectId, serviceId, externalId, intakeIntegrationId, title, description, source, JSON.stringify(card)],
  );
  const taskId = ins.rows[0].id;
  await c.query(
    `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
     VALUES ($1, 'TASK_CREATED', 'CANCELLED'::task_status, $2, $3::jsonb)`,
    [taskId, roleId, JSON.stringify({ source, externalId, duplicate: true, duplicateOf })],
  );
  await c.query(
    `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     VALUES ($1, 'TASK_CANCELLED', 'CANCELLED'::task_status, 'CANCELLED'::task_status, $2, $3::jsonb)`,
    [taskId, roleId, JSON.stringify({ source, reason: 'duplicate_closed', duplicateOf })],
  );
  return taskId;
}

/**
 * SCANNER-INTAKE-001 (TASK-INTAKE-OFFICER-001). Приём сырой задачи: Scanner
 * забирает запрос из папки (или задача приходит из модального окна) и создаёт её
 * в БД под ПЕРВОЙ ролью движения — Приёмщиком задач (TASK_INTAKE_OFFICER) в статусе
 * BACKLOG, после чего runner ведёт её по цепочке (BACKLOG → ARCHITECTURE → …). Сервис
 * при импорте АВТО-регистрируется. Идемпотентность — по UNIQUE (project_id,
 * external_id): повторный приём того же файла возвращает duplicate, не создавая дубль.
 * TASK-DUPLICATE-CLOSE-001: повторная подача того же ТЕКСТА с другим external_id
 * создаёт задачу сразу закрытой (CANCELLED, duplicateOf в карточке).
 */
export async function acceptScannerIntake(s, input) {
  const payload = normalizeScannerIntake(input);
  return withClient(clientConfig(s), async (c) => {
    // Постановщик явно указывает папку проекта (projectPath) или иной идентификатор.
    // Сопоставляем детерминированно. Не нашли → проект НЕ задан, задача станет
    // неразобранной (project_id IS NULL) и попадёт в корзину Приёмщика.
    const project = await findProject(c, payload.project);
    // SERVICE-REPO-PATH-001: каталог сервиса выводим из общего префикса путей
    // сдачи — при авторегистрации сразу заполняем services.repository_path.
    const servicePath = deriveServicePathFromFiles(payload.changedFiles);
    const serviceId = project
      ? await getOrCreateService(c, project.id, payload.service, null, servicePath)
      : null;
    // Идемпотентный поиск дубля: для назначенной — в рамках проекта, для
    // неразобранной — среди задач без проекта (частичный uniq-индекс).
    const findDup = () => (project
      ? c.query('SELECT id FROM tasks WHERE project_id = $1 AND external_id = $2', [project.id, payload.externalId])
      : c.query('SELECT id FROM tasks WHERE project_id IS NULL AND external_id = $1', [payload.externalId]));

    // TASK-DUPLICATE-CLOSE-001: отпечаток содержимого задачи — по заголовку и
    // описанию (external_id у повторной подачи другой, его uniq-проверка не ловит).
    const fingerprint = messageFingerprint(`${payload.title}\n${payload.description}`);

    await c.query('BEGIN');
    try {
      const existing = await findDup();
      if (existing.rowCount) {
        await c.query('COMMIT');
        return {
          accepted: true, imported: false, duplicate: true,
          taskId: existing.rows[0].id, externalId: payload.externalId,
        };
      }

      // Повторная подача того же текста (другой external_id) → задача-дубль
      // создаётся сразу закрытой, конвейер не запускается.
      const original = await findDuplicateTaskTx(c, { projectId: project?.id ?? null, fingerprint });
      if (original) {
        const dupCard = project
          ? { project: project.code, projectPath: project.root_path, messageFingerprint: fingerprint }
          : { requestedProject: payload.project || null, messageFingerprint: fingerprint };
        const taskId = await insertDuplicateClosedTaskTx(c, {
          projectId: project?.id ?? null, serviceId, externalId: payload.externalId,
          title: payload.title, description: payload.description,
          dataCard: dupCard, duplicateOf: original.id, source: 'scanner-intake',
        });
        await c.query('COMMIT');
        return {
          accepted: true, imported: false, duplicate: true, duplicateClosed: true,
          taskId, duplicateOf: original.id, externalId: payload.externalId,
        };
      }

      const entry = await computeEntry(c, project?.id ?? null, payload.entryRole);
      const { role, entryStageKey } = entry;
      // Назначенная задача стартует в статусе роли входа: BACKLOG у Приёмщика, либо
      // ARCHITECTURE, когда постановщик через MCP сдал готовый интейк сразу в Architect
      // (entryRole=ARCHITECT). Неразобранная паркуется в BLOCKED и ждёт назначения проекта.
      const status = project ? entry.status : 'BLOCKED';
      // Проект кладём в карточку сразу (детерминированно по папке). Карточку интейка
      // (card) от постановщика через MCP сливаем в data_card — Architect получит уже
      // подготовленные поля (short_title, structured_description, task_type, …).
      const dataCard = project
        ? {
            project: project.code,
            projectPath: project.root_path,
            ...asObject(payload.card),
          }
        : { requestedProject: payload.project || null };
      // TASK-DUPLICATE-CLOSE-001: отпечаток текста — по нему ловится повторная
      // подача той же задачи с другим external_id (см. findDuplicateTaskTx).
      if (fingerprint) dataCard.messageFingerprint = fingerprint;

      // TASK-PRIORITY-SCALE-001: приоритет форсим/нормализуем СЕРВЕРОМ по проекту.
      // Проект оркестратора → 0 (клиент не влияет); иначе clamp(1..3) с нормализацией
      // 0→1 и дефолтом 2. Неразобранная (project=null) → не оркестратор → обычный.
      const priority = computeTaskPriority(project, payload.priority ?? payload.card?.priority);
      const ins = await c.query(
        `INSERT INTO tasks
           (project_id, service_id, external_id, title, description, priority, status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, $4, $5, $6::smallint, $7::task_status, $8, $9::uuid, 'scanner-intake', $10::jsonb)
         RETURNING id`,
        [project?.id ?? null, serviceId, payload.externalId, payload.title, payload.description,
         priority, status, role.id, entryStageKey, JSON.stringify(dataCard)],
      );
      const taskId = ins.rows[0].id;

      // Исходный запрос в событии — Приёмщик увидит его через buildRoleContext.
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', $2::task_status, $3, $4::jsonb)`,
        [taskId, status, role.id, JSON.stringify({
          source: 'scanner-intake',
          externalId: payload.externalId,
          service: payload.service,
          result: payload.result,
          changedFiles: payload.changedFiles,
          requestedProject: payload.project || null,
          unassigned: !project,
          // TASK-INTAKE-OFFICER-MCP-001: фиксируем прямой вход постановщика в Architect.
          ...(payload.entryRole ? { entryRole: payload.entryRole } : {}),
          ...(project ? {} : { reason: 'project_unresolved' }),
        })],
      );
      await c.query('COMMIT');
      return {
        accepted: true, imported: true, duplicate: false, unassigned: !project,
        taskId, externalId: payload.externalId, project: project?.code ?? null,
        service: payload.service, nextRole: role.code, toStatus: status,
      };
    } catch (error) {
      await c.query('ROLLBACK');
      // Гонка: тот же external_id импортирован параллельно — это не ошибка.
      if (error.code === '23505') {
        const again = await findDup();
        if (again.rowCount) {
          return {
            accepted: true, imported: false, duplicate: true,
            taskId: again.rows[0].id, externalId: payload.externalId,
          };
        }
      }
      throw error;
    }
  });
}

// INTAKE-INTEGRATIONS-001 — короткий заголовок обращения из первой строки текста
// (Приёмщик позже заменит его на short_title). Ограничиваем длину для карточки.
function intakeReportTitle(message) {
  const firstLine = String(message ?? '').split(/\r?\n/)[0].trim();
  const base = firstLine || 'Обращение пользователя';
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

// INTAKE-CATEGORY-VALIDATION-001 — допустимые категории обращения из виджета.
// Категория пользователя — лишь ПОДСКАЗКА (не истина): Приёмщик перепроверяет её
// по тексту сообщения. Невалидное/пустое значение приём не роняет (→ null).
const INTAKE_CATEGORY_VALUES = new Set(['bug', 'idea', 'feature', 'question']);
function normalizeIntakeCategory(v) {
  const c = String(v ?? '').trim().toLowerCase();
  return INTAKE_CATEGORY_VALUES.has(c) ? c : null;
}

// INTAKE-WORKER-FORMAT-001 — совместимость с воркерами доставки подсистем ПС
// (Go internal/problemreports|problemdelivery): они шлют snake_case-поля
// (id/message_text/reporter_login/screen/context{build_version,...}), а канонический
// контракт — externalId/message/user/form/autocontext. Признак формата воркера —
// message_text без message; такой вход переводим в канонический ДО валидации.
// reporter_login может быть пуст (анонимная сессия) — доставку не роняем ('unknown').
function adaptWorkerIntakeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const str = (v) => String(v ?? '').trim();
  if (str(input.message) || !str(input.message_text)) return input;
  const ctx = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
    ? input.context : {};
  return {
    token: input.token,
    externalId: input.id,
    message: input.message_text,
    user: str(input.reporter_login) || str(input.reporter_user_id) || 'unknown',
    service: str(input.service_code) || str(input.service),
    form: input.screen,
    category: input.category,
    sourceTicketNo: input.ticket_no,
    autocontext: {
      url: ctx.url,
      buildVersion: ctx.build_version,
      userAgent: ctx.user_agent,
      timestamp: str(ctx.client_timestamp) || str(input.created_at),
      jsErrors: ctx.recent_errors,
      lastFailedApiRequestId: ctx.last_failed_request_id,
    },
  };
}

/**
 * INTAKE-INTEGRATIONS-001 — нормализация обращения из канала «интеграции в
 * приложения» (POST /api/intake/report). Чистая функция (без БД): проверяет
 * обязательные поля и собирает автоконтекст. token приходит из заголовка запроса
 * (Authorization: Bearer / X-Intake-Token) — сервер кладёт его в input.token.
 * Формат Go-воркеров подсистем принимается через adaptWorkerIntakeReport.
 */
export function normalizeIntakeReport(rawInput) {
  const input = adaptWorkerIntakeReport(rawInput);
  const str = (v) => String(v ?? '').trim();
  const token = str(input?.token);
  if (!token) throw scannerError(401, 'token_required');
  const externalId = str(input?.externalId);
  if (!externalId) throw scannerError(422, 'external_id_required');
  const message = str(input?.message);
  if (!message) throw scannerError(422, 'message_required');
  const user = str(input?.user);
  if (!user) throw scannerError(422, 'user_required');
  // Битую кодировку отклоняем на входе (как в scanner-интейке): по такому тексту
  // обращение не восстановить.
  if (looksCorruptedText(message)) throw scannerError(422, 'corrupted_encoding');

  const ac = input?.autocontext && typeof input.autocontext === 'object' && !Array.isArray(input.autocontext)
    ? input.autocontext : {};
  const autocontext = {
    url: str(ac.url) || null,
    buildVersion: str(ac.buildVersion) || null,
    userAgent: str(ac.userAgent) || null,
    timestamp: str(ac.timestamp) || null,
    jsErrors: Array.isArray(ac.jsErrors) ? ac.jsErrors.map((e) => str(e)).filter(Boolean).slice(0, 50) : [],
    lastFailedApiRequestId: str(ac.lastFailedApiRequestId) || null,
  };
  return {
    token,
    externalId,
    message,
    user,
    service: str(input?.service),      // микросервис-источник
    form: str(input?.form),            // форма/экран, с которого написано сообщение
    // INTAKE-CATEGORY-VALIDATION-001 — категория из виджета (подсказка пользователя,
    // не истина). Невалидное/пустое значение → null, приём не роняем.
    category: normalizeIntakeCategory(input?.category),
    autocontext,
    // Ссылка на объект-скриншот в MinIO (грузит бэкенд приложения-источника).
    screenshotUrl: str(input?.screenshotUrl) || null,
    // Номер тикета в подсистеме-источнике (его видел пользователь в виджете).
    sourceTicketNo: Number.isFinite(Number(input?.sourceTicketNo)) && Number(input?.sourceTicketNo) > 0
      ? Number(input.sourceTicketNo) : null,
  };
}

/**
 * INTAKE-INTEGRATIONS-001 — приём обращения о проблеме от зарегистрированного
 * приложения-источника (третий канал приёма Task Intake Officer). Авторизация по
 * токену интеграции; анти-спам (rate-limit по интеграции и по пользователю +
 * минимальная длина сообщения); идемпотентность по (intake_integration_id,
 * external_id). Обращение создаётся БЕЗ проекта, но СРАЗУ в статусе BACKLOG под
 * Приёмщиком (не BLOCKED) — чтобы не зависать в «Неразобранных»; проект определит
 * сам Приёмщик по каталогу проектов. Ответ содержит человекочитаемый номер
 * обращения (reportNumber) — приложение показывает его пользователю.
 */
export async function acceptIntakeReport(s, input) {
  const payload = normalizeIntakeReport(input);
  const tokenHash = hashToken(payload.token);
  return withClient(clientConfig(s), async (c) => {
    // 1. Авторизация по токену интеграции.
    const integ = await c.query(
      `SELECT id, name, enabled, rate_limit_per_min, user_rate_limit_per_min, min_message_length
         FROM intake_integrations WHERE token_hash = $1 AND token_hash <> ''`,
      [tokenHash],
    );
    if (!integ.rowCount) throw scannerError(401, 'invalid_intake_token');
    const integration = integ.rows[0];
    if (!integration.enabled) throw scannerError(403, 'integration_disabled');

    // 2. Анти-спам: слишком короткое сообщение отклоняем.
    if (payload.message.length < integration.min_message_length) {
      throw scannerError(422, 'message_too_short');
    }

    // Идемпотентность: обращение с тем же external_id уже принято → тот же номер.
    const findDup = () => c.query(
      'SELECT id, data_card FROM tasks WHERE intake_integration_id = $1 AND external_id = $2',
      [integration.id, payload.externalId],
    );
    const dupResult = (row) => ({
      accepted: true, duplicate: true, imported: false,
      taskId: row.id, reportNumber: row.data_card?.reportNumber ?? null,
      externalId: payload.externalId,
    });
    const dup0 = await findDup();
    if (dup0.rowCount) return dupResult(dup0.rows[0]);

    // 3. Анти-спам: rate-limit по интеграции и по пользователю. Окно — 1 минута по
    // created_at (устойчиво к рестарту одного инстанса; горизонтального
    // масштабирования оркестратора нет — счётчик держим в БД, не в памяти).
    const perInt = await c.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE intake_integration_id = $1 AND created_at > now() - interval '1 minute'`,
      [integration.id],
    );
    if (perInt.rows[0].n >= integration.rate_limit_per_min) throw scannerError(429, 'rate_limited');
    const perUser = await c.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE intake_integration_id = $1 AND created_at > now() - interval '1 minute'
          AND data_card->>'reporterUser' = $2`,
      [integration.id, payload.user],
    );
    if (perUser.rows[0].n >= integration.user_rate_limit_per_min) throw scannerError(429, 'user_rate_limited');

    // 4. Создание обращения: беспроектная задача СРАЗУ в BACKLOG под Приёмщиком.
    const role = await entryRole(c);
    // TASK-DUPLICATE-CLOSE-001: отпечаток текста обращения — повторная отправка
    // того же сообщения приходит с НОВЫМ external_id, uniq-проверка её не ловит
    // (инцидент 08.07: один и тот же репорт об ошибке каталога прислан дважды →
    // два параллельных конвейера сделали одну работу).
    const fingerprint = messageFingerprint(payload.message);
    await c.query('BEGIN');
    try {
      // Повторная проверка дубля под транзакцией (гонка параллельной доставки).
      const dup = await findDup();
      if (dup.rowCount) {
        await c.query('COMMIT');
        return dupResult(dup.rows[0]);
      }
      const seq = await c.query("SELECT nextval('intake_report_seq')::bigint AS n");
      const reportNumber = Number(seq.rows[0].n);
      const dataCard = {
        source: 'intake-integration',
        integration: integration.name,
        reportNumber,
        externalId: payload.externalId,
        // Номер тикета в подсистеме-источнике (виджет показал его пользователю).
        sourceTicketNo: payload.sourceTicketNo,
        reporterUser: payload.user,
        reporterService: payload.service || null,
        reporterForm: payload.form || null,
        // INTAKE-CATEGORY-VALIDATION-001 — категория, выбранная пользователем в
        // виджете (подсказка). Приёмщик перепроверит её и зафиксирует user_category
        // + resolved_category в карточке.
        category: payload.category,
        autocontext: payload.autocontext,
        // Ссылка на скриншот в MinIO — сохраняется в карточке и доступна ролям.
        screenshotUrl: payload.screenshotUrl,
        // TASK-DUPLICATE-CLOSE-001: отпечаток текста для ловли повторной подачи.
        ...(fingerprint ? { messageFingerprint: fingerprint } : {}),
      };
      // Повторная подача того же текста в тот же канал при живом оригинале →
      // обращение фиксируем (пользователь получает номер), но задачу создаём сразу
      // закрытой (CANCELLED, duplicateOf) — конвейер повторную работу не запускает.
      const original = await findDuplicateTaskTx(c, { intakeIntegrationId: integration.id, fingerprint });
      if (original) {
        const taskId = await insertDuplicateClosedTaskTx(c, {
          externalId: payload.externalId, intakeIntegrationId: integration.id,
          title: intakeReportTitle(payload.message), description: payload.message,
          roleId: role.id, dataCard, duplicateOf: original.id, source: 'intake-integration',
        });
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: true, duplicateClosed: true, imported: false,
          taskId, duplicateOf: original.id, reportNumber, externalId: payload.externalId,
        };
      }
      const ins = await c.query(
        `INSERT INTO tasks
           (project_id, service_id, external_id, intake_integration_id, title, description,
            status, current_role_id, current_stage_key, created_by, data_card)
         VALUES (NULL, NULL, $1, $2, $3, $4, 'BACKLOG'::task_status, $5, NULL, 'intake-integration', $6::jsonb)
         RETURNING id`,
        [payload.externalId, integration.id, intakeReportTitle(payload.message), payload.message,
         role.id, JSON.stringify(dataCard)],
      );
      const taskId = ins.rows[0].id;
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', 'BACKLOG'::task_status, $2, $3::jsonb)`,
        [taskId, role.id, JSON.stringify({
          source: 'intake-integration', integration: integration.name, integrationId: integration.id,
          reportNumber, externalId: payload.externalId, reporterUser: payload.user,
          reporterService: payload.service || null, reporterForm: payload.form || null,
          category: payload.category,
          hasScreenshot: Boolean(payload.screenshotUrl),
        })],
      );
      await c.query('COMMIT');
      return {
        accepted: true, duplicate: false, imported: true,
        taskId, reportNumber, externalId: payload.externalId,
        nextRole: role.code, toStatus: 'BACKLOG',
      };
    } catch (error) {
      await c.query('ROLLBACK');
      // Гонка: тот же external_id принят параллельно — это не ошибка.
      if (error.code === '23505') {
        const again = await findDup();
        if (again.rowCount) return dupResult(again.rows[0]);
      }
      throw error;
    }
  });
}

/**
 * Список неразобранных задач (project_id IS NULL) — корзина роли Task Intake
 * Officer. Это задачи, для которых постановщик не указал/не сопоставился проект.
 */
export async function listUnassignedTasks(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT t.id, t.external_id, t.title, t.description, t.status::text AS status,
              t.priority, t.created_at, t.data_card
         FROM tasks t
        WHERE t.project_id IS NULL
          AND t.status NOT IN ('DONE', 'CANCELLED')
        ORDER BY t.priority ASC, t.created_at ASC`,
    );
    return {
      tasks: r.rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        requestedProject: row.data_card?.requestedProject ?? null,
      })),
    };
  });
}

/**
 * Назначить неразобранной задаче проект и пустить её по конвейеру. Только задача
 * без проекта (project_id IS NULL) может быть назначена. После назначения задача
 * получает project_id, роль входа (Приёмщик), статус BACKLOG — runner ведёт её
 * дальше по цепочке. Возвращает { assigned, taskId, project, nextRole }.
 */
export async function assignTaskProject(s, taskId, projectRef) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  return withClient(clientConfig(s), async (c) => {
    const project = await findProject(c, projectRef);
    if (!project) throw scannerError(404, 'project_not_registered');
    await c.query('BEGIN');
    try {
      const cur = await c.query(
        'SELECT id, external_id, project_id, priority FROM tasks WHERE id = $1 FOR UPDATE', [id],
      );
      if (!cur.rowCount) throw scannerError(404, 'task_not_found');
      if (cur.rows[0].project_id) throw scannerError(409, 'task_already_assigned');

      // В целевом проекте уже может быть задача с таким external_id — назначение
      // нарушило бы UNIQUE (project_id, external_id). Явно сообщаем о конфликте.
      const externalId = cur.rows[0].external_id;
      if (externalId) {
        const dup = await c.query(
          'SELECT id FROM tasks WHERE project_id = $1 AND external_id = $2', [project.id, externalId],
        );
        if (dup.rowCount) throw scannerError(409, 'external_id_conflict');
      }

      const { role, entryStageKey } = await computeEntry(c, project.id);
      // TASK-PRIORITY-SCALE-001: при назначении проекта форсим/пересчитываем приоритет.
      // Оркестратор → 0; уход из оркестратора при 0 → 2; иначе сохраняем текущий.
      const curPriority = cur.rows[0].priority;
      const newPriority = isOrchestratorProject(project)
        ? 0
        : (curPriority === 0 ? 2 : curPriority);
      const upd = await c.query(
        `UPDATE tasks
            SET project_id = $2, status = 'BACKLOG', current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL,
                priority = $7::smallint,
                data_card = COALESCE(data_card, '{}'::jsonb)
                            || jsonb_build_object('project', $5::text, 'projectPath', $6::text),
                updated_at = now()
          WHERE id = $1 AND project_id IS NULL
          RETURNING id`,
        [id, project.id, role.id, entryStageKey, project.code, project.root_path, newPriority],
      );
      if (!upd.rowCount) throw scannerError(409, 'task_already_assigned');

      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_UPDATED', 'BACKLOG', $2, $3::jsonb)`,
        [id, role.id, JSON.stringify({ source: 'intake-assign', project: project.code, nextRole: role.code })],
      );
      await c.query('COMMIT');
      return { assigned: true, taskId: id, project: project.code, nextRole: role.code };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

// TASK-MANUAL-MOVE-001 — UI-мутации продвижения/перемещения задачи из раздела
// «Задачи». advanceTask: авто-продвижение по маршруту проекта (как runner после
// успешного шага). moveTask: ручное перемещение на выбранный этап с аудитом.
// Обе пишут task_events и снимают assigned_agent_id (задача освобождается).

/**
 * Продвинуть задачу на следующий этап маршрута проекта (FORWARD). Применяет ту же
 * логику, что runner: граф-режим при current_stage_key, иначе позиционный маршрут.
 * Терминальные (DONE/CANCELLED/FAILED) и BLOCKED задачи авто-продвижению не
 * подлежат — для них ручное перемещение moveTask. Публичная обёртка над Tx.
 */
export async function advanceTask(s, taskId) {
  return withClient(clientConfig(s), (c) => advanceTaskTx(c, taskId));
}

export async function advanceTaskTx(c, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  await c.query('BEGIN');
  try {
    const cur = await c.query(
      `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id,
              t.current_stage_key, t.assigned_agent_id, r.code AS role_code
         FROM tasks t LEFT JOIN roles r ON r.id = t.current_role_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    if (!task.project_id) throw scannerError(409, 'task_without_project');
    if (TERMINAL_STATUSES.has(task.status)) throw scannerError(409, 'task_terminal');
    if (task.status === 'BLOCKED') throw scannerError(409, 'task_blocked_use_manual');
    // Захваченную исполнителем задачу авто-продвигать нельзя: пока её слот занят
    // (assigned_agent_id != NULL), безусловный перевод дальше потеряет/перетрёт
    // активный прогон. Такие задачи двигаем только ручным moveTask с аудитом.
    if (task.assigned_agent_id) throw scannerError(409, 'task_assigned_use_manual');

    const route = await loadProjectRoute(c, task.project_id);
    const decision = { outcome: 'FORWARD' };
    const resolved = task.current_stage_key
      ? await resolveGraphTransition(c, task, decision)
      : resolveTransition(route, task.role_code, decision, {
        currentStatus: task.status,
        currentStageKey: task.current_stage_key,
      });

    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);

    // Человекочитаемое имя целевого этапа (для аудита, как targetStage в moveTask):
    // в граф-режиме берём имя по nextStageKey, иначе деградируем до кода роли/DONE.
    let targetStage = null;
    if (resolved.nextStageKey) {
      const stRes = await c.query(
        'SELECT name FROM project_stages WHERE stage_key = $1 AND project_id = $2',
        [resolved.nextStageKey, task.project_id],
      );
      targetStage = stRes.rows[0]?.name ?? null;
    }
    if (!targetStage) targetStage = resolved.done ? 'DONE' : (resolved.nextRole ?? null);

    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
              assigned_agent_id = NULL, current_stage_key = $4::uuid, updated_at = now()
        WHERE id = $1`,
      [id, resolved.toStatus, nextRoleId, resolved.nextStageKey ?? null],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [id, task.status, resolved.toStatus, nextRoleId, JSON.stringify({
        source: 'manual-advance', via: resolved.via ?? null,
        fromRole: task.role_code ?? null, nextRole: resolved.nextRole ?? null,
        fromStatus: task.status, toStatus: resolved.toStatus, targetStage,
        done: resolved.done === true,
      })],
    );
    await c.query('COMMIT');
    return {
      advanced: true, taskId: id, fromStatus: task.status,
      toStatus: resolved.toStatus, nextRole: resolved.nextRole ?? null, done: resolved.done === true,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

/**
 * Ручное перемещение задачи на выбранный этап проекта (manual). Для заблокированных
 * или иначе непродвигаемых задач: пользователь выбирает целевой этап (его id), мы
 * пишем audit-событие source='manual' с прежним/новым статусом и комментарием,
 * снимаем назначение агента. Целевой этап обязан принадлежать проекту задачи и
 * иметь статус (контрольные узлы fork/join отклоняются). Публичная обёртка над Tx.
 */
export async function moveTask(s, taskId, input) {
  return withClient(clientConfig(s), (c) => moveTaskTx(c, taskId, input));
}

export async function moveTaskTx(c, taskId, input) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  const toStageId = String(input?.toStageId ?? '').trim();
  if (!toStageId) throw scannerError(422, 'target_stage_required');
  // Ручное перемещение обязано нести причину/комментарий: это audit-событие, по
  // которому видно, кто и зачем сдвинул задачу мимо обычного маршрута. Без неё
  // запись в task_events теряет смысл, поэтому пустой reason отклоняем.
  const reason = String(input?.reason ?? '').trim();
  if (!reason) throw scannerError(422, 'reason_required');
  await c.query('BEGIN');
  try {
    const cur = await c.query(
      `SELECT id, project_id, status::text AS status FROM tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    if (!task.project_id) throw scannerError(409, 'task_without_project');

    // Целевой этап обязан принадлежать проекту задачи; берём первую роль этапа.
    const st = await c.query(
      `SELECT ps.stage_key, ps.kind, ps.task_status::text AS task_status, ps.name,
              (SELECT psr.role_id FROM project_stage_roles psr
                WHERE psr.stage_id = ps.id ORDER BY psr.position LIMIT 1) AS role_id
         FROM project_stages ps
        WHERE ps.id = $1 AND ps.project_id = $2`,
      [toStageId, task.project_id],
    );
    if (!st.rowCount) throw scannerError(404, 'target_stage_not_found');
    const stage = st.rows[0];
    const toStatus = stage.task_status;
    // Контрольные узлы (fork/join) не несут статуса — на них вручную не переводим.
    if (!toStatus) throw scannerError(422, 'target_stage_no_status');

    // accepted_at = NULL: задача снова в работе (в т.ч. «доработка» из «Проверки»),
    // не должна числиться принятой/«Выполнено».
    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
              current_stage_key = $4::uuid, assigned_agent_id = NULL,
              accepted_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, toStatus, stage.role_id ?? null, stage.stage_key ?? null],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [id, task.status, toStatus, stage.role_id ?? null, JSON.stringify({
        source: 'manual', via: 'manual-move', fromStatus: task.status, toStatus,
        targetStage: stage.name ?? null, reason,
      })],
    );
    await c.query('COMMIT');
    return { moved: true, taskId: id, fromStatus: task.status, toStatus, targetStage: stage.name ?? null };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

/**
 * TASK-PRIORITY-SCALE-001 — смена приоритета задачи из карточки/UI (PATCH .../priority).
 * Та же валидация, что при создании: 0 разрешён ТОЛЬКО проекту оркестратора (форс
 * сервера) — клиент не может задать 0 чужой задаче; оркестраторную нельзя понизить
 * ниже 0 (её приоритет всегда 0). Меняем ТОЛЬКО число приоритета — статус/слот
 * (assigned_agent_id) не трогаем, RUNNING-прогоны не вытесняем. Публичная обёртка над Tx.
 */
export async function setTaskPriority(s, taskId, priority) {
  return withClient(clientConfig(s), (c) => setTaskPriorityTx(c, taskId, priority));
}

export async function setTaskPriorityTx(c, taskId, priority) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  if (priority === null || priority === undefined || priority === '') {
    throw scannerError(422, 'priority_required');
  }
  const n = Math.trunc(Number(priority));
  if (!Number.isFinite(n) || n < 0 || n > 3) throw scannerError(422, 'priority_out_of_range');
  await c.query('BEGIN');
  try {
    const cur = await c.query(
      `SELECT t.id, t.priority, p.code AS project_code, p.root_path
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const row = cur.rows[0];
    const isOrch = isOrchestratorProject({ code: row.project_code, root_path: row.root_path });
    // 0 — привилегия сервера для проекта оркестратора. Клиент не ставит 0 чужой задаче.
    if (n === 0 && !isOrch) throw scannerError(422, 'priority_zero_orchestrator_only');
    // Оркестраторную не понижать ниже 0: её приоритет всегда 0 (форс сервера).
    if (isOrch && n !== 0) throw scannerError(422, 'priority_orchestrator_forced_zero');
    if (row.priority === n) {
      await c.query('COMMIT');
      return { updated: true, taskId: id, priority: n, changed: false };
    }
    await c.query('UPDATE tasks SET priority = $2::smallint, updated_at = now() WHERE id = $1', [id, n]);
    await c.query(
      `INSERT INTO task_events (task_id, event_type, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::jsonb)`,
      [id, JSON.stringify({ source: 'manual-priority', fromPriority: row.priority, toPriority: n })],
    );
    await c.query('COMMIT');
    return { updated: true, taskId: id, priority: n, changed: true };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

/**
 * TASK-RESTART-001 — массовый перезапуск зависших задач из раздела «Задачи».
 * Зависшие = с проектом, НЕ терминальные (DONE/CANCELLED/FAILED), НЕ ждущие
 * подзадачи (WAITING_FOR_CHILDREN) и «не в работе» (свободный слот
 * assigned_agent_id IS NULL). Подзадачи учитываются наравне с верхним уровнем.
 *
 * RESTART-IN-PLACE: задача перезапускается НА ТЕКУЩЕМ ЭТАПЕ — current_role_id и
 * current_stage_key НЕ меняются, задача НЕ перебрасывается на Приёмщика. Раньше
 * restart-stuck возвращал всё в статус RESTART под TASK_INTAKE_OFFICER, и задачи
 * «улетали» со своих этапов на вход проекта, теряя прогресс. Со свободным слотом
 * задача и так переигрывается своей же ролью (claimLlmRoleTask выбирает по
 * current_role_id + status, не по прошлым прогонам; CODING ждёт programmer-runner),
 * поэтому достаточно отпустить зависшие захваты — переноса на другой этап не нужно.
 *
 * Перед выборкой освобождаем осиротевшие/просроченные захваты (resetStaleClaims):
 * зависшая сессия отпускает слот → её задача переигрывается на текущем этапе, а
 * реально активные задачи сохраняют назначение и не трогаются.
 */
export async function restartStuckTasks(s) {
  return withClient(clientConfig(s), (c) => restartStuckTasksTx(c));
}

export async function restartStuckTasksTx(c) {
  await resetStaleClaims(c);
  await c.query('BEGIN');
  try {
    // Перезапуск на текущем этапе: статус/роль/стадия не меняются. Пишем
    // диагностическое событие (to_status = from_status) и трогаем updated_at,
    // чтобы зафиксировать намерение «переиграть здесь же».
    const upd = await c.query(
      `WITH targets AS (
         SELECT id, status::text AS from_status, current_role_id FROM tasks
          WHERE project_id IS NOT NULL
            AND assigned_agent_id IS NULL
            AND status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN')
       ), upd AS (
         UPDATE tasks t SET updated_at = now()
           FROM targets WHERE t.id = targets.id
         RETURNING t.id
       )
       INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       SELECT targets.id, 'TASK_UPDATED', targets.from_status::task_status, targets.from_status::task_status,
              targets.current_role_id,
              jsonb_build_object('source', 'manual-restart', 'reason', 'restart_in_place')
         FROM targets
       RETURNING task_id`,
    );
    await c.query('COMMIT');
    return { restarted: upd.rowCount };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

/**
 * TASK-ACCEPTANCE-001 — доска приёмки для подразделов «Проверка»/«Выполнено».
 * Плоский список завершённых задач (status IN ('DONE','CANCELLED')) с проектом,
 * сервисом и признаком приёма. Клиент делит его так: «Проверка» — только не принятые
 * DONE (accepted = false); «Выполнено» — принятые DONE и все CANCELLED (у отменённых
 * приёма нет, но их показывают в архиве с причиной отмены). Подзадачи
 * (parent_task_id) учитываются наравне с верхним уровнем. Read-only.
 *
 * Для CANCELLED-задач отдаём причину отмены cancelReason: приоритет — заметка о
 * дубле (data_card->>'duplicateNote'), иначе reason/note последнего события
 * task_events с to_status='CANCELLED' (LEFT JOIN LATERAL ev), иначе ссылка на
 * оригинал (data_card->>'duplicateOf'). Для DONE cancelReason = null. Поле
 * duplicateOf пробрасывается из data_card (иначе null).
 *
 * Возвращает { tasks: [{ id, title, status, priority, projectId, projectName,
 * serviceName, accepted, acceptedAt, updatedAt, cancelReason, duplicateOf }] }.
 */
export async function getAcceptanceBoard(s) {
  return withClient(clientConfig(s), (c) => getAcceptanceBoardTx(c));
}

export async function getAcceptanceBoardTx(c) {
  const r = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.priority::text AS priority,
              t.accepted_at, t.updated_at,
              p.id AS project_id, p.name AS project_name,
              sv.service_name,
              t.data_card->>'duplicateNote' AS duplicate_note,
              t.data_card->>'duplicateOf'   AS duplicate_of,
              ev.reason AS ev_reason, ev.note AS ev_note
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN services sv ON sv.id = t.service_id
         LEFT JOIN LATERAL (
           SELECT te.payload_json->>'reason' AS reason,
                  te.payload_json->>'note'   AS note
             FROM task_events te
            WHERE te.task_id = t.id AND te.to_status = 'CANCELLED'
            ORDER BY te.created_at DESC, te.id DESC
            LIMIT 1
         ) ev ON true
        WHERE t.status IN ('DONE','CANCELLED')
        ORDER BY t.priority ASC, t.created_at ASC, t.id DESC
        LIMIT 1000`,
    );
    // Первое непустое строковое значение — аналог COALESCE(NULLIF(x, ''), …).
    const firstNonEmpty = (...vals) => {
      for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v;
      return null;
    };
    const tasks = r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      projectId: row.project_id,
      projectName: row.project_name,
      serviceName: row.service_name ?? null,
      accepted: row.accepted_at != null,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      // Причина отмены только у CANCELLED; у DONE — null.
      cancelReason: row.status === 'CANCELLED'
        ? firstNonEmpty(row.duplicate_note, row.ev_reason, row.ev_note, row.duplicate_of)
        : null,
      duplicateOf: firstNonEmpty(row.duplicate_of),
    }));
  return { tasks };
}

/**
 * TASK-ACCEPTANCE-001 — принять задачу из подраздела «Проверка». Проставляет
 * accepted_at = now() (задача переходит в «Выполнено»). Принять можно только
 * задачу в статусе DONE (прошедшую конвейер); статус не меняем. Идемпотентно:
 * повторный приём просто обновляет метку. Пишет audit-событие source='manual-accept'.
 * Публичная обёртка над Tx.
 */
export async function acceptTask(s, taskId) {
  return withClient(clientConfig(s), (c) => acceptTaskTx(c, taskId));
}

// TASK-AUTO-ACCEPT-001 — «не проверять выполненные задачи»: массово принять все
// задачи, дошедшие до DONE, но ещё не принятые (accepted_at IS NULL). Вызывается
// фоновым тиком, когда включена настройка auto_accept_done — тогда гейт «Проверка»
// пуст, а свежие DONE сразу попадают в «Выполнено». Идемпотентно (WHERE accepted_at
// IS NULL), пишет audit-событие source='auto-accept'. Возвращает число принятых.
export async function autoAcceptDoneTasks(c) {
  const r = await c.query(
    `WITH upd AS (
       UPDATE tasks SET accepted_at = now(), updated_at = now()
        WHERE status = 'DONE' AND accepted_at IS NULL
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', 'DONE'::task_status, 'DONE'::task_status, NULL,
            jsonb_build_object('source', 'auto-accept', 'via', 'acceptance-gate-disabled')
       FROM upd
     RETURNING task_id`,
  );
  return r.rowCount;
}

export async function acceptTaskTx(c, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  await c.query('BEGIN');
  try {
    const cur = await c.query(
      `SELECT id, status::text AS status, accepted_at FROM tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    // Принимать имеет смысл только задачу, завершившую конвейер (DONE). Иначе
    // приём «через голову» маршрута скрыл бы незаконченную работу из «В работе».
    if (task.status !== 'DONE') throw scannerError(409, 'task_not_done');

    await c.query(
      `UPDATE tasks SET accepted_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', 'DONE'::task_status, 'DONE'::task_status, NULL, $2::jsonb)`,
      [id, JSON.stringify({ source: 'manual-accept', via: 'acceptance-gate' })],
    );
    await c.query('COMMIT');
    return { accepted: true, taskId: id };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Найти сервис по (project, code) или СОЗДАТЬ его (авто-регистрация при импорте).
// Пустой код → null (задача без сервиса). service_name = code, если имени нет.
export async function getOrCreateService(c, projectId, serviceCode, serviceName, repositoryPath) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const found = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (found.rowCount) return found.rows[0].id;
  // SERVICE-REPO-PATH-001: при авторегистрации сразу пишем каталог сервиса
  // (выведенный из путей work_item/сдачи), чтобы PIPELINE_SERVICE не собирал от
  // корня репозитория. Пустой путь → NULL (бэкфилл по коду произойдёт на claim).
  const repoPath = String(repositoryPath ?? '').trim() || null;
  const ins = await c.query(
    `INSERT INTO services (project_id, service_code, service_name, repository_path)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, service_code) DO UPDATE SET service_code = EXCLUDED.service_code
     RETURNING id`,
    [projectId, code, String(serviceName ?? '').trim() || code, repoPath],
  );
  return ins.rows[0].id;
}

/**
 * Эвристика «битой кодировки» (mojibake). Текст приходит уже повреждённым с
 * клиента (напр. codex на Windows-консоли схлопывает кириллицу в «?»; разрыв
 * UTF-8 на границе чанков даёт символ-замену U+FFFD «�»). Такой текст бесполезен:
 * исходную задачу по нему не восстановить. Чтобы мусор не оседал в БД отдельной
 * BLOCKED-задачей, отклоняем его прямо на приёмке. Возвращает true, если текст
 * выглядит повреждённым:
 *  - содержит U+FFFD (символ-замену), либо
 *  - содержит подряд 3+ знака «?» (схлопнутое слово кириллицы), либо
 *  - доля «?» среди непробельных символов ≥ 25% (рассыпанные «?»).
 * Одиночные/двойные «?» (риторический вопрос) НЕ считаются порчей.
 */
export function looksCorruptedText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (s.includes('�')) return true;
  if (/\?{3,}/.test(s)) return true;
  const q = (s.match(/\?/g) || []).length;
  const nonSpace = s.replace(/\s/g, '').length;
  return q >= 3 && nonSpace > 0 && q / nonSpace >= 0.25;
}

export function normalizeScannerIntake(input) {
  const required = (key) => {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw scannerError(422, `${key}_required`);
    return value;
  };
  // Идентификатор проекта: приоритет у явной папки (projectPath), затем project.
  // НЕ обязателен — нераспознанный/пустой проект делает задачу неразобранной.
  const project = String(input?.projectPath ?? input?.project ?? '').trim();
  const title = required('title');
  const description = String(input?.description ?? '').trim() || null;
  // Битую кодировку отклоняем на входе: задачу по такому тексту не восстановить,
  // а клиенту нужно переприслать запрос в корректной UTF-8 (а не плодить мусор).
  if (looksCorruptedText(title) || looksCorruptedText(description)) {
    throw scannerError(422, 'corrupted_encoding');
  }
  return {
    externalId: required('externalId'),
    project,
    title,
    service: String(input?.service ?? '').trim(),
    description,
    result: String(input?.result ?? ''),
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map(String) : [],
    // TASK-INTAKE-OFFICER-MCP-001: роль входа (например ARCHITECT) — постановщик через
    // MCP сдаёт готовый интейк сразу в Architect, минуя пайплайновый Приёмщик/BACKLOG.
    entryRole: String(input?.entryRole ?? '').trim().toUpperCase() || null,
    // TASK-PRIORITY-SCALE-001: пользовательский приоритет (1..3) из тела или карточки.
    // Сырое значение — нормализацию/форс делает acceptScannerIntake по проекту.
    priority: input?.priority
      ?? (input?.card && typeof input.card === 'object' && !Array.isArray(input.card)
        ? input.card.priority : undefined)
      ?? null,
    // Карточка интейка (поля контракта Приёмщика) → сливается в data_card для Architect.
    card: input?.card && typeof input.card === 'object' && !Array.isArray(input.card)
      ? input.card : null,
  };
}

// SELECT задачи в форме, нужной диспетчеру Scanner (FOR UPDATE — блокируем строку).
const SCANNER_TASK_SELECT = `SELECT t.id, t.status::text AS status, p.id AS project_id,
        p.code AS project_code, s.service_code, rr.id AS reviewer_role_id,
        t.current_role_id, t.current_stage_key, cr.code AS current_role_code,
        t.task_kind, t.parent_task_id
   FROM tasks t
   JOIN projects p ON p.id = t.project_id
   LEFT JOIN services s ON s.id = t.service_id
   LEFT JOIN roles cr ON cr.id = t.current_role_id
   JOIN roles rr ON rr.code = 'TASK_REVIEWER'
  WHERE t.id = $1
  FOR UPDATE OF t`;

/**
 * Найти задачу по id или создать её из completion, если в БД её ещё нет.
 *
 * ВАЖНО: проекты и сервисы заводятся ТОЛЬКО вручную (через UI/API). Сканер их
 * больше НЕ создаёт: если проект/сервис из completion не зарегистрирован —
 * задача отклоняется (project_not_registered / service_not_registered). Раньше
 * по полям project/service из документа плодились «левые» проекты и сервисы
 * (напр. PS + Chat_Service/IAM_Service/…), не привязанные к папке проекта.
 *
 * Сама задача по-прежнему создаётся из completion (в статусе CODING под ролью
 * PROGRAMMER, с событием TASK_CREATED) — но только внутри уже существующих
 * проекта и сервиса. Идемпотентно: ON CONFLICT + повторный SELECT под блокировкой.
 * Возвращает { task, created } (created — была ли задача создана сейчас).
 */
export async function findOrCreateScannerTask(c, payload) {
  // Проект обязан существовать (создаётся только вручную). Резолвим гибко:
  // по code | name | root_path — чтобы поле project из документа совпало с
  // зарегистрированным проектом независимо от способа записи.
  const project = await requireProject(c, payload.project);

  const existing = await c.query(SCANNER_TASK_SELECT, [payload.taskId]);
  if (existing.rowCount) {
    const task = existing.rows[0];
    // Существующая задача должна принадлежать тому же проекту/сервису, что и completion.
    if (task.project_code !== project.code) throw scannerError(409, 'project_mismatch');
    if ((task.service_code ?? '') !== String(payload.service ?? '').trim()) {
      throw scannerError(409, 'service_mismatch');
    }
    return { task, created: false };
  }

  // Сервис тоже только ручной: пустой код → задача без сервиса; непустой неизвестный → ошибка.
  const serviceId = await requireService(c, project.id, payload.service);
  const role = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
  const programmerRoleId = role.rows[0]?.id ?? null;

  const ins = await c.query(
    `INSERT INTO tasks (id, project_id, service_id, title, status, current_role_id, created_by)
     VALUES ($1, $2, $3, $4, 'CODING', $5, 'scanner')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [payload.taskId, project.id, serviceId, payload.title, programmerRoleId],
  );
  if (ins.rowCount) {
    await c.query(
      `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_CREATED', 'CODING', $2, $3::jsonb)`,
      [payload.taskId, programmerRoleId, JSON.stringify({
        source: 'scanner', autoCreated: true, project: payload.project, service: payload.service, title: payload.title,
      })],
    );
  }

  const created = await c.query(SCANNER_TASK_SELECT, [payload.taskId]);
  if (!created.rowCount) throw scannerError(500, 'task_autocreate_failed');
  return { task: created.rows[0], created: ins.rowCount > 0 };
}

// Найти проект по code | name | root_path. Проекты создаются ТОЛЬКО вручную,
// поэтому при отсутствии — ошибка (а не авто-создание). Возвращает { id, code }.
async function requireProject(c, ref) {
  const v = String(ref ?? '').trim();
  if (!v) throw scannerError(422, 'project_required');
  const r = await c.query(
    `SELECT id, code FROM projects
      WHERE code = $1 OR name = $1 OR root_path = $1
      ORDER BY created_at LIMIT 1`,
    [v],
  );
  if (!r.rowCount) throw scannerError(404, 'project_not_registered');
  return r.rows[0];
}

// Найти сервис по (project, service_code). Сервисы тоже только ручные: пустой код
// → null (задача без сервиса); непустой неизвестный код → ошибка (не авто-создание).
async function requireService(c, projectId, serviceCode) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const r = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (!r.rowCount) throw scannerError(404, 'service_not_registered');
  return r.rows[0].id;
}

/**
 * Обратный мост БД → файл: атомарно захватить следующую задачу для Claude.
 * Берём задачу в статусе CODING под ролью PROGRAMMER, ещё не отданную (никому
 * не назначен агент), помечаем её claude_programmer и пишем событие AGENT_ASSIGNED.
 * FOR UPDATE SKIP LOCKED исключает выдачу одной задачи двум фидерам.
 * Возвращает { task: {...} } для записи в claude-tasks.json или { task: null }.
 */
// Ключ транзакционного advisory-lock для claim'а PROGRAMMER. Сериализует заявки
// между параллельными воркерами, чтобы условие «один активный CODING на сервис»
// (NOT EXISTS ниже) проверялось по уже зафиксированным назначениям, а не в гонке
// (иначе N воркеров одновременно проходят проверку и хватают ОДИН сервис).
const CLAUDE_CLAIM_LOCK_KEY = 911_017;

export async function claimNextClaudeTask(s) {
  return withClient(clientConfig(s), (c) => claimNextClaudeTaskTx(c));
}

/**
 * Транзакционное ядро claimNextClaudeTask (тестируется с fake-клиентом без живого
 * Postgres — как completeHostTaskTx/acceptScannerCompletionTx). Захват программиста
 * с cooldown-предикатом PROGRAMMER-RELEASE-BACKOFF-001 (см. picked ниже).
 */
export async function claimNextClaudeTaskTx(c) {
  {
    if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
    await c.query('BEGIN');
    try {
      await c.query('SELECT pg_advisory_xact_lock($1)', [CLAUDE_CLAIM_LOCK_KEY]);
      const picked = await c.query(
        `WITH picked AS (
           SELECT t.id
           FROM tasks t
           JOIN roles r ON r.id = t.current_role_id
           JOIN projects p ON p.id = t.project_id
           WHERE r.code = 'PROGRAMMER'
             AND r.hidden = false
             AND t.status = 'CODING'
             AND t.assigned_agent_id IS NULL
             AND t.service_id IS NOT NULL
             -- DECOMP-CONTRACT-001: программист клеймит ТОЛЬКО подзадачи-на-файл.
             -- Задачи-на-сервис (kind='service') ждут детей в WAITING_FOR_CHILDREN
             -- и не клеймятся; одиночные legacy-задачи остаются kind='service' со
             -- статусом CODING — для них правило не меняется (они клеймятся как
             -- раньше, см. ниже): поэтому фильтруем по «не epic», а не «= subtask».
             AND t.task_kind <> 'epic'
             AND p.status <> 'paused'
             -- PROGRAMMER-WORKTREE-PER-SERVICE: не более одной активной CODING-
             -- задачи на микросервис (один worktree на сервис). Если у сервиса уже
             -- есть назначенная задача — пропускаем его, чтобы воркеры разбирали
             -- РАЗНЫЕ сервисы параллельно, а не толпились на одном (иначе они
             -- сериализуются на сервис-локе runner'а и параллелизм теряется).
             AND NOT EXISTS (
               SELECT 1 FROM tasks t2
                WHERE t2.project_id = t.project_id
                  AND t2.service_id = t.service_id
                  AND t2.status = 'CODING'
                  AND t2.assigned_agent_id IS NOT NULL
             )
             -- PROGRAMMER-RELEASE-BACKOFF-001: cooldown на повторный захват ТОЙ ЖЕ
             -- задачи после подряд идущих неудачных release. Инцидент 03.07.2026:
             -- PRINT-054 крутилась в CODING-петле (агент падал за ~5с →
             -- releaseClaudeTask возвращал захват → задача бралась снова, 1407
             -- прогонов за 2 часа), и, так как у программиста ровно один агент, петля
             -- заблокировала стадию CODING для остальных. N = число неуспешных
             -- PROGRAMMER-прогонов (FAILED/TIMEOUT) ПОСЛЕ последнего SUCCESS этой
             -- задачи; backoff(N) берём из расписания $1 (int[] мс), индекс = LEAST(N,
             -- длина) → потолок на хвосте. Пока now() < last_fail + backoff(N) — задачу
             -- не выдаём (программист свободен разбирать ДРУГИЕ сервисы). Успех
             -- обнуляет N сам: считаем только прогоны после последнего SUCCESS. Один
             -- AND-предикат — приоритет (ORDER BY) и worktree-NOT EXISTS не затронуты.
             AND NOT EXISTS (
               SELECT 1 FROM (
                 SELECT count(*) AS n_fail, max(ar.finished_at) AS last_fail
                   FROM agent_runs ar
                  WHERE ar.task_id = t.id
                    AND ar.role_id = t.current_role_id
                    AND ar.status IN ('FAILED','TIMEOUT')
                    AND ar.finished_at IS NOT NULL
                    -- manual-move сбрасывает и cooldown: оператор перезапустил задачу
                    -- руками — не заставляем её досиживать хвост backoff.
                    AND ar.finished_at > GREATEST(
                          COALESCE((
                            SELECT max(ok.finished_at) FROM agent_runs ok
                             WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                               AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                          COALESCE((
                            SELECT max(mv.created_at) FROM task_events mv
                             WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                               AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
               ) cd
               WHERE cd.n_fail > 0
                 AND now() < cd.last_fail
                             + (($1::int[])[LEAST(cd.n_fail::int, array_length($1::int[], 1))])
                               * interval '1 millisecond'
             )
           ORDER BY t.priority ASC, t.created_at ASC
           FOR UPDATE OF t SKIP LOCKED
           LIMIT 1
         )
         UPDATE tasks t
            SET assigned_agent_id = (SELECT id FROM agents WHERE code = 'claude_programmer')
           FROM picked
          WHERE t.id = picked.id
          RETURNING t.id, t.title, t.description, t.project_id, t.service_id, t.current_role_id`,
        [PROGRAMMER_RELEASE_BACKOFF_MS],
      );
      if (!picked.rowCount) {
        await c.query('COMMIT');
        return { task: null };
      }
      const row = picked.rows[0];
      const meta = await c.query(
        `SELECT p.code AS project_code, s.service_code, t.task_kind
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id
          WHERE t.id = $1`,
        [row.id],
      );
      const { project_code, service_code, task_kind } = meta.rows[0];
      // Проброс контекста Programmer'у: вывод ARCHITECT/DECOMPOSER и последнее
      // ревью, чтобы Claude реализовывал по проекту, а не с нуля.
      const prior = await fetchPriorOutputs(c, row.id);
      // Инструменты PROGRAMMER: MCP-серверы (для запуска Claude Code) + уровни
      // доступа (read/modify/create/delete). Claude Code получит MCP-конфиг.
      const { getToolsForRole } = await import('./tools.js');
      const { buildMcpConfig } = await import('./toolsClient.js');
      const progTools = await getToolsForRole(c, 'PROGRAMMER');
      const mcpConfig = progTools.mcp.length ? await buildMcpConfig(progTools.mcp) : { mcpServers: {} };
      // Контракт роли: требования, которые Claude ОБЯЗАН выполнить перед сдачей.
      // Те же поля строго проверяет acceptScannerCompletion (нельзя вернуть без них).
      const progContract = await loadRoleContract(c, 'PROGRAMMER');
      const requiredFields = progContract.outputs.filter((f) => f.required).map((f) => f.key);
      const assigned = await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'AGENT_ASSIGNED', 'CODING', $2, $3::jsonb)
         RETURNING id`,
        [row.id, row.current_role_id, JSON.stringify({ target: 'claude-tasks.json', agent: 'claude_programmer' })],
      );
      // PROGRAMMER-UNIFY-001: программист наблюдается так же, как рассуждающие роли —
      // через agent_runs (а не только task_events). Создаём прогон RUNNING при
      // захвате; путь сдачи (acceptScannerCompletion) и releaseClaudeTask его
      // финализируют, осиротевший — закрывает releaseStaleClaudeClaims по
      // CLAUDE_ASSIGN_TIMEOUT_MS (resetStaleClaims программиста НЕ трогает — у него
      // более длинный таймаут сессии). Так PROGRAMMER попадает в «Монитор» (roleLoad)
      // и в версионные KPI единообразно со всеми.
      //
      // Движок роли (карточка роли → role_connectors): модель назначенного
      // включённого коннектора версионирует прогон и реально выбирает агента для
      // программиста (см. claudeAgent.js). Так «тот же промт, разные модели/агенты»
      // сравнимы в разрезе версий. Без назначения — модель агента по умолчанию.
      const progAgent = await c.query(
        `SELECT id, model FROM agents WHERE code = 'claude_programmer' LIMIT 1`,
      );
      const progAgentId = progAgent.rows[0]?.id ?? null;
      // Программиста исполняет Claude Agent SDK (programmer-runner), поэтому модель
      // берём ТОЛЬКО у Claude-совместимого движка (драйвер claude_code или
      // anthropic-API). Модель от deepseek/codex/openai не подсунет SDK имя чужой
      // модели; такой коннектор → fallback на дефолт агента.
      const progConn = await c.query(
        `SELECT cn.id::text AS connector_id, cn.provider, cn.model FROM role_connectors rc
           JOIN connectors cn ON cn.id = rc.connector_id
          WHERE rc.role_code = 'PROGRAMMER' AND cn.is_enabled = true
            AND lower(cn.provider) IN ('claude_code', 'anthropic')
          LIMIT 1`,
      );
      const connModel = String(progConn.rows[0]?.model ?? '').trim();
      const agentModel = String(progAgent.rows[0]?.model ?? '').trim();
      // PROGRAMMER-MODEL-ROUTING-001: модель по сложности задачи (Sonnet для мелких
      // подзадач-на-файл, Opus для цельных задач-на-сервис). Эффективная модель:
      // явный Claude-коннектор роли (осознанный override оператора) > роутинг по
      // сложности > дефолт агента > пусто (раннер сам решит).
      const routedModel = programmerModelForKind(task_kind);
      const programmerModel = connModel || routedModel || agentModel || null;
      // ROLE-ENGINE-ROUTING-002: неизменяемый снимок фактического движка программиста.
      // Источник истины — назначенный роли Claude-совместимый коннектор (см. выше). Нет
      // назначения → снимок пустой (раннер исполняет дефолтным агентом, коннектор не
      // зафиксирован). snapshot_model = эффективная модель, которой реально исполняется.
      const progProvider = progConn.rows[0]?.provider == null
        ? null : String(progConn.rows[0].provider);
      const progSnap = {
        connectorId: progConn.rows[0]?.connector_id ?? null,
        provider: progProvider,
        model: programmerModel,
        driverType: progProvider == null ? null : (isDriverProvider(progProvider) ? 'driver' : 'api'),
      };
      // Прогон закрывают по task_id (на задачу — ровно один RUNNING под PROGRAMMER),
      // поэтому id прогона дальше не нужен.
      if (progAgentId) {
        await c.query(
          `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json, model,
             snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
           VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8, $9)`,
          [row.id, progAgentId, row.current_role_id,
            JSON.stringify({ roleCode: 'PROGRAMMER', status: 'CODING' }), programmerModel,
            progSnap.connectorId, progSnap.provider, progSnap.model, progSnap.driverType],
        );
      }
      // Ключ сдачи ДОЛЖЕН быть уникален для каждого захвата задачи, а не только для
      // её id. Иначе после повторного входа задачи в CODING (RESTART/refeed/доработка
      // от ревьюера) её сдача попадёт в scanner_dispatches как дубль по уже
      // существующему (task_id, completion_key) → acceptScannerCompletion вернёт
      // duplicate БЕЗ продвижения, задача навсегда залипнет в CODING и claim_next_
      // claude_task начнёт по кругу выдавать одну и ту же «уже завершённую» задачу.
      // Привязка к id события AGENT_ASSIGNED (создаётся при каждом захвате) даёт
      // свежий ключ на каждый заход и сохраняет идемпотентность в рамках одного
      // захвата (исполнитель сдаёт ровно тем ключом, что получил здесь).
      const completionKey = `programmer-${row.id}-${assigned.rows[0].id}`;
      await c.query('COMMIT');
      return {
        task: {
          id: row.id,
          project: project_code,
          service: service_code ?? '',
          title: row.title,
          description: row.description ?? '',
          // PROGRAMMER-UNIFY-001: модель из движка роли (или дефолт) — раннер
          // запускает агента ровно на ней; null = раннер берёт свой дефолт.
          model: programmerModel,
          priorRoleOutputs: prior.priorRoleOutputs,
          lastReview: prior.lastReview,
          // Инструменты для Claude Code: MCP-конфиг и разрешённые уровни доступа.
          capabilities: progTools.capabilities,
          mcpConfig,
          // Требования контракта роли: ключи полей, которые обязательно вернуть
          // в fields при сдаче (orchestrator_complete_scanner_task). Пусто — нет требований.
          requiredFields,
          // ЖЁСТКОЕ УСЛОВИЕ сдачи: задача остаётся claimed в статусе CODING, пока
          // исполнитель не вернёт результат во внешнюю систему. Чтобы пайплайн НЕ
          // тормозил, исполнитель ОБЯЗАН СРАЗУ после внесения изменений вызвать
          // orchestrator_complete_scanner_task. Все обязательные параметры заранее
          // подставлены здесь (completionKey идемпотентен, повтор безопасен) —
          // придумывать ничего не нужно, рапорт делается немедленно.
          completion: {
            required: true,
            tool: 'orchestrator_complete_scanner_task',
            completionKey,
            project: project_code,
            service: service_code ?? '',
            title: row.title,
            sourceDocument: 'tasks/claude-tasks.json',
            instruction:
              'ОБЯЗАТЕЛЬНО: сразу после внесения изменений вызови ' +
              'orchestrator_complete_scanner_task с этими taskId, completionKey, ' +
              'project, service, title, sourceDocument; перечисли changedFiles и ' +
              'result. Не оставляй задачу без рапорта — иначе она зависнет на этапе ' +
              'Programmer (CODING) и затормозит весь пайплайн. После успешной сдачи ' +
              'результата очисти рабочий контекст сессии программиста (например, ' +
              'командой /clear в Claude Code), чтобы следующая задача не получила ' +
              'остатки контекста выполненной задачи.',
          },
        },
      };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Откат захвата: вернуть задачу в пул, если фидер не смог записать файл.
 * Снимаем назначение агента только с задачи, всё ещё ожидающей кодинга.
 */
// PROGRAMMER-RELEASE-REASON-001: предел длины outcome/error_text при освобождении
// захвата. Единая точка записи → защищает agent_runs от раздувания независимо от
// источника reason (длинный error.message, петля захват→провал→release). 500
// символов достаточно для диагностики причины.
const RELEASE_TEXT_MAX = 500;
function clipReleaseText(v) {
  const str = String(v ?? '');
  return str.length > RELEASE_TEXT_MAX ? str.slice(0, RELEASE_TEXT_MAX) : str;
}

// Публичная обёртка над Tx: открывает соединение и делегирует транзакционной части
// (её же дёргают юнит-тесты с поддельным клиентом, как advanceTaskTx/moveTaskTx).
export async function releaseClaudeTask(s, taskId, opts = {}) {
  return withClient(clientConfig(s), async (c) => {
    const result = await releaseClaudeTaskTx(c, taskId, opts);
    if (result?.released) {
      await exportLatestAgentRunObservation(c, taskId, {
        eventType: 'programmer_released',
        roleCode: 'PROGRAMMER',
        reason: opts.reason || 'released',
        payload: { result, meta: opts.meta ?? null },
      });
    }
    return result;
  });
}

export async function releaseClaudeTaskTx(c, taskId, opts = {}) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  {
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND status = 'CODING'
        RETURNING id, current_role_id`,
      [id],
    );
    const released = r.rowCount > 0;
    // PROGRAMMER-LIMIT-KPI-001: упор программиста в лимит ходов — отдельный KPI.
    // Пишем append-only событие (event_type=TASK_UPDATED + kind-дискриминатор),
    // чтобы Монитор считал его как сигнал плохой нарезки задачи (Декомпозитор/
    // Архитектор), не заводя новое значение в enum event_type. Записываем только
    // когда задача реально была освобождена из CODING (есть строка с контекстом).
    if (released && opts.reason === 'max_turns_exceeded') {
      const numTurns = Number(opts.meta?.numTurns);
      const maxTurns = Number(opts.meta?.maxTurns);
      await c.query(
        `INSERT INTO task_events (task_id, event_type, role_id, payload_json)
         VALUES ($1, 'TASK_UPDATED', $2, $3::jsonb)`,
        [id, r.rows[0].current_role_id, JSON.stringify({
          source: 'programmer-runner',
          kind: 'programmer_limit_exceeded',
          reason: 'max_turns_exceeded',
          numTurns: Number.isFinite(numTurns) ? numTurns : null,
          maxTurns: Number.isFinite(maxTurns) ? maxTurns : null,
        })],
      );
    }
    // PROGRAMMER-UNIFY-001: освобождение захвата = прогон не дал результата.
    // Финализируем RUNNING-прогон программиста (созданный при захвате), чтобы он не
    // висел вечно и корректно считался в KPI. Исход по причине: упор в лимит ходов и
    // прочие провалы → FAILED; таймаут агента → TIMEOUT. turns берём из meta, если
    // раннер прислал. Толерантно: нет прогона → 0 строк.
    if (released) {
      const reason = String(opts.reason ?? '').trim();
      const runStatus = reason === 'agent_timeout' ? 'TIMEOUT' : 'FAILED';
      // Обрезаем и outcome, и error_text до предела: reason приходит извне (может
      // быть длинным error.message), а петля release множит такие записи.
      const outcome = clipReleaseText(reason || 'released');
      const errorText = clipReleaseText(`programmer_released: ${outcome}`);
      const turns = Number.isFinite(Number(opts.meta?.numTurns))
        ? Math.trunc(Number(opts.meta.numTurns)) : null;
      await c.query(
        `UPDATE agent_runs
            SET status = $2::agent_run_status, finished_at = now(), turns = $3, outcome = $4,
                error_text = $5
          WHERE id = (
            SELECT id FROM agent_runs
             WHERE task_id = $1 AND role_id = $6 AND status = 'RUNNING'
             ORDER BY started_at DESC LIMIT 1
          )`,
        [id, runStatus, turns, outcome, errorText, r.rows[0].current_role_id],
      );
    }
    // PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: агент явно упёрся в контракт/сгенерированный
    // код ДРУГОГО сервиса (meta.blockerKind='cross_service'). Гонять такую задачу по
    // кругу в CODING бессмысленно — граница сервиса выбрана неверно. Сразу уводим в
    // BLOCKED с точной причиной и именем блокирующего сервиса: оператор переразобьёт
    // (Архитектор/Декомпозер) через manual-move. Ловим на ПЕРВОМ явном сигнале, а не
    // после исчерпания backoff/loop-cap (5 холостых прогонов). Причину дублируем в
    // data_card (видно в карточке, как у прочих авто-блоков).
    let crossServiceBlocked = false;
    if (released && opts.meta && opts.meta.blockerKind === 'cross_service') {
      const upd = await c.query(
        `UPDATE tasks SET status = 'BLOCKED' WHERE id = $1 AND status = 'CODING' RETURNING id`,
        [id],
      );
      if (upd.rowCount) {
        crossServiceBlocked = true;
        const blockedBy = opts.meta.blockedByService
          ? String(opts.meta.blockedByService).slice(0, 120) : null;
        const detail = 'Программист заблокирован контрактом/сгенерированным кодом другого '
          + 'сервиса — нужна ре-декомпозиция (Архитектор/Декомпозер), а не повтор в CODING.';
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_BLOCKED', 'CODING', 'BLOCKED', $2, $3::jsonb)`,
          [id, r.rows[0].current_role_id, JSON.stringify({
            runner: true, reason: 'cross_service_dependency', blockedByService: blockedBy, detail,
          })],
        );
        await c.query(
          `UPDATE tasks SET data_card = COALESCE(data_card, '{}'::jsonb) || jsonb_build_object(
             'cross_service_block',
             jsonb_build_object('reason', 'cross_service_dependency', 'blockedByService', $2::text))
            WHERE id = $1`,
          [id, blockedBy],
        );
      }
    }
    return { released, taskId: id, crossServiceBlocked };
  }
}

// --- Host-мост для ролей действия (PIPELINE_SERVICE, GIT_INTEGRATOR) ---------
// Эти роли требуют реального docker/git и не могут исполняться в контейнере
// оркестратора. Host-runner (нативный процесс) забирает задачу, выполняет
// действие на хосте и сообщает результат обратно. БД остаётся источником истины.

const HOST_ROLES = {
  PIPELINE_SERVICE: { from: 'TESTING' },
  GIT_INTEGRATOR: { from: 'COMMIT' },
};

/**
 * FORK-BRANCH-CONTEXT-001 — контекст host-задачи с учётом fork-веток. Ветка fork
 * (ребёнок, created_by='fork') не несёт событий сдачи программиста — они на
 * родителе/корне. Раньше scan смотрел только события самой задачи: у ребёнка их
 * нет → Git Integrator получал пустой changedFiles и завершался
 * note='no_changed_files', код оставался не закоммиченным. Ищем по всей цепочке
 * предков; пустые ([]/'') не считаются сдачей (иначе TASK_CREATED с changedFiles:[]
 * перекрыл бы реальную сдачу).
 *
 * STALE-COMPLETION-ROLE-GUARD-001: changedFiles АГРЕГИРУЕМ по всей цепочке событий
 * сдачи с дедупом (объединение непустых списков, порядок первого вхождения), а не
 * берём одно последнее событие. Иначе поздний дубль сдачи с changedFiles:[] (но
 * непустым result) выигрывал по created_at DESC и перекрывал реальный список файлов
 * из более ранней валидной сдачи (инцидент f43a9f6c: пустой список затёр 5 файлов →
 * Git Integrator получил no_changed_files, код не был закоммичен). result берём из
 * последней сдачи с непустым result. rootTask — корень цепочки (карточка Приёмщика
 * для коммита).
 */
export async function resolveHostTaskContext(c, taskId) {
  const chain = await c.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_task_id, title, description, 0 AS depth
         FROM tasks WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_task_id, p.title, p.description, chain.depth + 1
         FROM tasks p JOIN chain ON p.id = chain.parent_task_id
        WHERE chain.depth < 8
     )
     SELECT id, title, description, depth FROM chain ORDER BY depth`,
    [taskId],
  );
  const chainIds = chain.rows.length ? chain.rows.map((r) => r.id) : [taskId];
  const rootTask = chain.rows[chain.rows.length - 1] ?? null;
  const ev = await c.query(
    `SELECT payload_json FROM task_events
      WHERE task_id = ANY($1::uuid[])
        AND (
          (jsonb_typeof(payload_json->'changedFiles') = 'array'
            AND jsonb_array_length(payload_json->'changedFiles') > 0)
          OR COALESCE(payload_json->>'result', '') <> ''
        )
      ORDER BY created_at DESC`,
    [chainIds],
  );
  if (!ev.rows.length) return { chainIds, rootTask, scan: null };
  // Агрегируем changedFiles по всем событиям сдачи цепочки с дедупом; пустой список
  // одного события не перекрывает непустой из другого (см. docblock).
  const seen = new Set();
  const changedFiles = [];
  for (const row of ev.rows) {
    const files = row.payload_json?.changedFiles;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      const key = String(f);
      if (seen.has(key)) continue;
      seen.add(key);
      changedFiles.push(f);
    }
  }
  // result — последняя сдача с непустым результатом (события отсортированы DESC).
  // COMPLETION-SUMMARY-TEXT-001: извлекаем текстовый summary (result мог быть записан
  // объектом), а НЕ приводим объект через String() → иначе «[object Object]» уходит в
  // приоры следующих ролей.
  const withResult = ev.rows.find((row) => resultSummaryText(row.payload_json?.result) !== '');
  const result = withResult ? resultSummaryText(withResult.payload_json.result) : '';
  // WORKTREE-BRANCH-CONTEXT-001: последняя непустая ветка/коммит worktree сдачи
  // программиста по цепочке событий (события отсортированы created_at DESC, поэтому
  // первое непустое значение — самое свежее). Нужны Git Integrator, чтобы влить
  // ветку programmer/<...> в main. Старая сдача без этих полей → null (прежнее поведение).
  // DELIVERED-COMMIT-COUPLE-001: worktreeBranch и deliveredCommit ОБЯЗАНЫ браться из
  // ОДНОЙ и той же (самой свежей) сдачи. Раньше они резолвились независимо: после
  // повторного прогона с ПУСТОЙ дельтой у свежей сдачи deliveredCommit=null, но
  // worktreeBranch есть — и независимый поиск дотягивал deliveredCommit до СТАРОГО
  // цикла. Git Integrator пытался влить устаревший коммит и падал cherry_pick_failed,
  // хотя ветка уже сброшена на main и дельта пуста. Берём самую свежую сдачу с
  // непустым worktreeBranch и её deliveredCommit «как есть»: null → GI сам возьмёт
  // tip ветки (already_integrated + повтор доставки), а не устаревший SHA.
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const deliveryRow = ev.rows.find((r) => str(r.payload_json?.worktreeBranch) !== null);
  const worktreeBranch = deliveryRow ? str(deliveryRow.payload_json.worktreeBranch) : null;
  const deliveredCommit = deliveryRow ? str(deliveryRow.payload_json.deliveredCommit) : null;
  return { chainIds, rootTask, scan: { payload_json: { changedFiles, result, worktreeBranch, deliveredCommit } } };
}

/**
 * Захватить следующую задачу для host-роли. Аналог claimNextClaudeTask, но для
 * PIPELINE_SERVICE/GIT_INTEGRATOR. Помечает agent_run RUNNING и возвращает
 * контекст для исполнения на хосте (включая changedFiles сдачи программиста,
 * найденные по цепочке предков — см. resolveHostTaskContext).
 */
export async function claimNextHostTask(s, roleCode) {
  const role = HOST_ROLES[roleCode];
  if (!role) throw scannerError(422, 'unsupported_host_role');
  return withClient(clientConfig(s), async (c) => {
    if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
    await c.query('BEGIN');
    try {
      const picked = await c.query(
        `SELECT t.id, t.title, t.description, t.current_role_id, t.project_id, t.service_id,
                t.status::text AS status
           FROM tasks t
           JOIN roles r ON r.id = t.current_role_id
           JOIN projects p ON p.id = t.project_id
          WHERE r.code = $1 AND r.hidden = false AND t.assigned_agent_id IS NULL
            AND p.status <> 'paused'
            AND (
              EXISTS (
                SELECT 1 FROM project_stages ps
                  JOIN project_stage_roles psr ON psr.stage_id = ps.id
                 WHERE ps.project_id = t.project_id AND ps.enabled = true
                   AND psr.role_id = r.id AND ps.task_status::text = t.status::text
                   AND (t.current_stage_key IS NULL OR ps.stage_key = t.current_stage_key)
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM project_stages ps2
                   WHERE ps2.project_id = t.project_id AND ps2.enabled = true AND ps2.task_status IS NOT NULL
                )
                AND t.status = $2::task_status
              )
            )
          ORDER BY t.priority ASC, t.created_at ASC
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1`,
        [roleCode, role.from],
      );
      if (!picked.rowCount) {
        await c.query('COMMIT');
        return { task: null };
      }
      const t = picked.rows[0];
      // Исполнитель host-роли — активный агент роли; для не-AI ролей это local-
      // провайдер (pipeline-runner), который предпочитается AI-агенту.
      const agent = await c.query(
        `SELECT id FROM agents WHERE role_id = $1 AND is_active = true
          ORDER BY (provider = 'local') DESC, created_at LIMIT 1`,
        [t.current_role_id],
      );
      const agentId = agent.rows[0]?.id ?? null;
      if (!agentId) {
        await c.query('ROLLBACK');
        return { task: null };
      }
      await c.query('UPDATE tasks SET assigned_agent_id = $2 WHERE id = $1', [t.id, agentId]);
      // ROLE-ENGINE-ROUTING-002: снимок движка host-роли (обычно локальный
      // исполнитель без AI-коннектора → все поля NULL; заполняется, если роли явно
      // назначен включённый коннектор).
      const hostSnap = await resolveConnectorSnapshot(c, roleCode);
      const run = await c.query(
        `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json,
           snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
         VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8) RETURNING id`,
        [t.id, agentId, t.current_role_id, JSON.stringify({ roleCode, host: true }),
          hostSnap.connectorId, hostSnap.provider, hostSnap.model, hostSnap.driverType],
      );
      const meta = await c.query(
        `SELECT p.id AS project_id, p.code AS project, p.root_path,
                s.id AS service_id, s.service_code AS service, s.service_name, s.repository_path
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
        [t.id],
      );
      const m = meta.rows[0] ?? {};
      const { rootTask, scan } = await resolveHostTaskContext(c, t.id);

      // PIPELINE_SERVICE — не-AI исполнитель: контракт claim фиксирует точный
      // микросервис и разрешённую рабочую директорию (без AI agent run/LLM).
      // Неизвестный сервис или выход за корень проекта → диагностируемая ошибка
      // ДО запуска команд (транзакция откатывается, задача не выдаётся).
      let pipeline = null;
      if (roleCode === 'PIPELINE_SERVICE') {
        // PIPELINE-CLAIM-UNWEDGE-001: нерезолвящийся сервис раньше ронял claim
        // HTTP 422 — раннер получал отказ по кругу, а «кривая» задача (голова
        // выборки) заклинивала ВСЕ pipeline-задачи проекта. Теперь стопорим САМУ
        // задачу: прогон закрываем FAILED с ошибкой (видно в истории этапа),
        // задачу — в BLOCKED с причиной в карточке (пуск руками после заполнения
        // пути сервиса), COMMIT. Следующий тик claim берёт следующего кандидата.
        const blockPipelineTask = async (code, message) => {
          await c.query(
            `UPDATE agent_runs SET status = 'FAILED', finished_at = now(),
                    output_json = $2::jsonb, error_text = $3 WHERE id = $1`,
            [run.rows[0].id, JSON.stringify({ error: { code, message } }), message],
          );
          await c.query(
            `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL,
                    data_card = COALESCE(data_card, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
            [t.id, JSON.stringify({ pipeline_claim_block: { code, reason: message, service: m.service ?? null } })],
          );
          await c.query(
            `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
             VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
            [t.id, t.status, t.current_role_id,
             JSON.stringify({ runner: true, reason: code, detail: message, service: m.service ?? null })],
          );
          await c.query('COMMIT');
        };
        // SERVICE-REPO-PATH-001: репозиторный путь сервиса ОБЯЗАН указывать на
        // существующий каталог. Пустой/устаревший путь раньше проходил как
        // «сборка от корня» → pipeline_compose_not_found. Теперь: валидный путь
        // оставляем, иначе бэкфилл по коду (ленивое обновление), иначе —
        // диагностируемый провал service_path_unresolved ДО запуска стадий.
        const resolvedPath = resolveServiceRepoPath(m.root_path, m.service, m.repository_path);
        if (!resolvedPath.ok) {
          await blockPipelineTask(resolvedPath.code, resolvedPath.message);
          return { task: null, blocked: { taskId: t.id, code: resolvedPath.code } };
        }
        if (resolvedPath.changed) {
          await c.query('UPDATE services SET repository_path = $2 WHERE id = $1', [m.service_id, resolvedPath.repositoryPath]);
          m.repository_path = resolvedPath.repositoryPath;
        }
        try {
          pipeline = buildPipelineClaimContract({
            projectId: m.project_id,
            projectCode: m.project,
            serviceId: m.service_id,
            serviceCode: m.service,
            serviceName: m.service_name,
            projectRoot: m.root_path,
            repositoryPath: resolvedPath.repositoryPath,
          });
        } catch (err) {
          await blockPipelineTask(err.code || 'pipeline_contract_invalid', err.message || 'pipeline_contract_invalid');
          return { task: null, blocked: { taskId: t.id, code: err.code || 'pipeline_contract_invalid' } };
        }
      }

      await c.query('COMMIT');
      // FORK-BRANCH-CONTEXT-001: коммит Git Integrator подписывается карточкой
      // Приёмщика (short_title/structured_description) — они на КОРНЕВОЙ задаче,
      // а у fork-ребёнка заголовок с суффиксом «[ветка]». Для остальных host-ролей
      // заголовок оставляем как есть (в коммит он не попадает).
      const useRoot = roleCode === 'GIT_INTEGRATOR' && rootTask && rootTask.id !== t.id;
      return {
        task: {
          id: t.id,
          role: roleCode,
          title: useRoot ? rootTask.title : t.title,
          description: (useRoot ? rootTask.description : t.description) ?? '',
          projectId: m.project_id ?? null,
          project: m.project ?? '',
          serviceId: m.service_id ?? null,
          service: m.service ?? '',
          serviceName: m.service_name ?? '',
          projectRoot: m.root_path ?? '',
          repositoryPath: m.repository_path ?? '',
          changedFiles: scan?.payload_json?.changedFiles ?? [],
          programmerResult: scan?.payload_json?.result ?? '',
          // WORKTREE-BRANCH-CONTEXT-001: ветка/коммит worktree сдачи программиста —
          // Git Integrator вливает их в main (merge/cherry-pick), а не ищет
          // незакоммиченные файлы в основном дереве. Нет сдачи через worktree → null.
          worktreeBranch: scan?.payload_json?.worktreeBranch ?? null,
          deliveredCommit: scan?.payload_json?.deliveredCommit ?? null,
          agentRunId: run.rows[0].id,
          // Контракт прямого запуска pipeline (только для PIPELINE_SERVICE).
          ...(pipeline ? { pipeline } : {}),
        },
      };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

// Терминальные статусы задачи: жизненный цикл завершён, каноническая запись
// сохраняется как история проекта. Повторный сигнал завершения такой задачи
// обрабатывается идемпотентно — без новых событий, изменения истории и двойного
// учёта в «Завершено».
const TERMINAL_TASK_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Принять результат host-роли и сделать переход. Для PIPELINE_SERVICE пишет
 * pipeline_runs. Переход считает МАРШРУТ ПРОЕКТА (граф при current_stage_key,
 * иначе позиционный) — nextRole НЕ захардкожен: успех Pipeline Service ведёт в
 * следующий узел графа (напр. fork), Failure Analyst достижим только по ветке
 * провала. Для GIT_INTEGRATOR success → конец маршрута (DONE), fail → BLOCKED.
 */
export async function completeHostTask(s, input) {
  return withClient(clientConfig(s), async (c) => {
    const result = await completeHostTaskTx(c, input);
    if (result?.taskId) {
      await exportLatestAgentRunObservation(c, result.taskId, {
        eventType: 'host_role_completed',
        roleCode: result.role,
        reason: result.reason || (result.success === false ? 'host_failed' : 'host_completed'),
        payload: { result },
      });
    }
    return result;
  });
}

/**
 * Транзакционное ядро completeHostTask. Вынесено отдельной экспортируемой
 * функцией, чтобы тестировать переходы и идемпотентность на фейковом клиенте
 * без живого Postgres. Никогда не удаляет каноническую запись задачи: успешное
 * завершение лишь переводит её в DONE и пишет событие TASK_DONE.
 */
export async function completeHostTaskTx(c, input) {
  const taskId = String(input?.taskId ?? '').trim();
  const roleCode = String(input?.roleCode ?? input?.role ?? '').trim();
  const success = input?.success === true || input?.success === 'true';
  const output = input?.output ?? {};
  if (!taskId) throw scannerError(422, 'taskId_required');
  if (!HOST_ROLES[roleCode]) throw scannerError(422, 'unsupported_host_role');

  {
    await c.query('BEGIN');
    try {
      // LEFT JOIN: у терминальной задачи current_role_id = NULL, INNER JOIN дал
      // бы пустой результат и ложный 404 на повторном сигнале завершения.
      const found = await c.query(
        `SELECT t.id, t.status::text AS status, t.current_role_id, t.assigned_agent_id,
                t.project_id, t.current_stage_key, r.code AS role_code
           FROM tasks t LEFT JOIN roles r ON r.id = t.current_role_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [taskId],
      );
      if (!found.rowCount) throw scannerError(404, 'task_not_found');
      const t = found.rows[0];

      // Идемпотентность: задача уже завершена/отменена/провалена. Повторный
      // completion (двойной сигнал host-runner, ретрай, переотправка после
      // очистки активной очереди) не пишет событие, не меняет историю и не
      // увеличивает «Завершено» — каноническая запись остаётся как есть.
      if (TERMINAL_TASK_STATUSES.has(t.status)) {
        await c.query('COMMIT');
        return { accepted: true, duplicate: true, taskId, toStatus: t.status, nextRole: null };
      }

      if (t.role_code !== roleCode) throw scannerError(409, 'role_mismatch');

      // Целевой переход — по маршруту проекта (PIPELINE-DYNAMIC-ROUTE-001).
      // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (в т.ч.
      // Pipeline Service при успехе → узел fork, а НЕ захардкоженный Documentation
      // Auditor на родителе, минуя FORK_GATE). Без ключа — прежняя позиционная
      // маршрутизация (линейные схемы не затронуты).
      const route = await loadProjectRoute(c, t.project_id);
      const claimedLike = {
        id: t.id, project_id: t.project_id, current_stage_key: t.current_stage_key,
        role_code: roleCode, status: t.status,
      };
      const resolveHost = (decision) => (t.current_stage_key
        ? resolveGraphTransition(c, claimedLike, decision)
        : resolveTransition(route, roleCode, decision, {
          currentStatus: t.status,
          currentStageKey: t.current_stage_key,
        }));
      let resolved;
      if (roleCode === 'PIPELINE_SERVICE') {
        await c.query(
          `INSERT INTO pipeline_runs (task_id, status, failed_stage, started_at, finished_at, summary_json, log_path)
           VALUES ($1, $2::pipeline_status, $3, $4, now(), $5::jsonb, $6)`,
          [
            taskId,
            success ? 'SUCCESS' : 'FAILED',
            output.failedStage ?? null,
            output.startedAt ?? null,
            JSON.stringify(output.summary ?? output),
            output.logPath ?? null,
          ],
        );
        // Успех → вперёд по маршруту (граф минует аналитика на зелёном пути);
        // провал → к аналитику (ветка 'failure' графа / branch линейного маршрута).
        resolved = await resolveHost(success
          ? { outcome: 'FORWARD' }
          : { outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework' });
      } else {
        // GIT_INTEGRATOR: успех завершает маршрут, провал — стоп.
        // GI-BLOCK-KEEP-STAGE-001: при провале СОХРАНЯЕМ current_stage_key (nextStageKey
        // = текущий узел), иначе общий UPDATE ниже (current_stage_key = nextStageKey ??
        // null) обнулял позицию в графе, и ручной разблок (bulk_unblock_refeed) не мог
        // возобновить граф-задачу с нужного узла COMMIT. Ср. ветку next_role_missing,
        // которая current_stage_key не трогает.
        resolved = success
          ? await resolveHost({ outcome: 'FORWARD' })
          : { nextRole: null, toStatus: 'BLOCKED', done: false, blocked: true, nextStageKey: t.current_stage_key, via: t.current_stage_key ? 'graph' : 'route' };
      }
      const toStatus = resolved.toStatus;
      const nextRole = resolved.nextRole;

      // Значения исходящих полей host-роли → кумулятивная карточка задачи.
      const hostContract = await loadRoleContract(c, roleCode);
      const { values: hostCardValues } = extractOutputs(output?.fields ?? output, hostContract.outputs);

      const nextRoleId = !nextRole
        ? null
        : await roleIdByCode(c, nextRole);
      if (nextRole && !nextRoleId) {
        const reason = `next_role_missing:${nextRole}`;
        await c.query(
          `UPDATE tasks SET status = 'BLOCKED', current_role_id = NULL, assigned_agent_id = NULL,
                  data_card = data_card || $2::jsonb
            WHERE id = $1`,
          [taskId, JSON.stringify({ orchestration_error: reason, ...hostCardValues })],
        );
        const failureText = reason.slice(0, HOST_FAILURE_TEXT_MAX);
        await c.query(
          `UPDATE agent_runs
              SET status = 'FAILED', finished_at = COALESCE(finished_at, now()), error_text = $2,
                  output_json = COALESCE(output_json, '{}'::jsonb) || $3::jsonb
            WHERE task_id = $1 AND role_id = $4
              AND status IN ('RUNNING','TIMEOUT')`,
          [taskId, failureText, JSON.stringify({ reason, output }), t.current_role_id],
        );
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
          [taskId, t.status, t.current_role_id, JSON.stringify({
            runner: true, host: true, role: roleCode, reason, missingRole: nextRole,
            outcome: 'BLOCK', via: resolved.via,
          })],
        );
        await c.query('COMMIT');
        return { taskId, role: roleCode, success: false, toStatus: 'BLOCKED', nextRole: null, reason };
      }

      // FORK-JOIN-001: в граф-режиме переносим текущий узел на следующий (напр. на
      // узел fork после успеха Pipeline Service); в линейном режиме остаётся NULL.
      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
                data_card = data_card || $4::jsonb, current_stage_key = $5::uuid WHERE id = $1`,
        [taskId, toStatus, nextRoleId, JSON.stringify(hostCardValues || {}), resolved.nextStageKey ?? null],
      );
      // BOOT-RECONCILE-GRACE-001: закрыть прогон host-роли по фактическому исходу.
      // Берём последний прогон роли в статусе RUNNING ЛИБО TIMEOUT. Host-runner
      // переживает рестарт оркестратора и досылает результат ПОСЛЕ boot-жнеца; тот
      // уже снял assigned_agent_id и мог пометить прогон TIMEOUT — поэтому не гейтим
      // по assigned_agent_id и переписываем TIMEOUT на фактический SUCCESS/FAILED,
      // иначе KPI и «Нагрузка по ролям» навсегда считают такой прогон таймаутом.
      // HOST-FAILURE-TEXT-001: при провале host-роли пишем НЕПУСТОЙ структурированный
      // error_text (код причины из output), чтобы монитор показывал причину падения
      // PIPELINE_SERVICE, а не пустоту. При успехе error_text не трогаем ($5 не
      // добавляем). Общий формат кода причины (deriveHostFailureText) переиспользует
      // ветка GIT_INTEGRATOR (ORCH-GI-BLOCKED-OWNER-001).
      const runParams = [taskId, success ? 'SUCCESS' : 'FAILED', JSON.stringify(output), t.current_role_id];
      if (!success) runParams.push(deriveHostFailureText(roleCode, output));
      await c.query(
        `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb${success ? '' : ', error_text = $5'}
          WHERE id = (
            SELECT id FROM agent_runs
             WHERE task_id = $1 AND role_id = $4 AND status IN ('RUNNING','TIMEOUT')
             ORDER BY started_at DESC LIMIT 1
          )`,
        runParams,
      );
      const done = toStatus === 'DONE';
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
        [
          taskId,
          done ? 'TASK_DONE' : 'STATUS_CHANGED',
          t.status,
          toStatus,
          t.current_role_id,
          JSON.stringify({ host: true, role: roleCode, success, output, nextRole }),
        ],
      );
      await c.query('COMMIT');
      return { accepted: true, duplicate: false, taskId, toStatus, nextRole };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
}

// Откат захвата host-задачи (host-runner не смог выполнить действие).
export async function releaseHostTask(s, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND status IN ('TESTING','COMMIT') RETURNING id`,
      [id],
    );
    await c.query(
      `UPDATE agent_runs SET status = 'CANCELLED', finished_at = now() WHERE task_id = $1 AND status = 'RUNNING'`,
      [id],
    );
    const result = { released: r.rowCount > 0, taskId: id };
    if (result.released) {
      await exportLatestAgentRunObservation(c, id, {
        eventType: 'host_role_released',
        reason: 'host_released',
        payload: { result },
      });
    }
    return result;
  });
}

// --- ROLE-ENGINE-ROUTING-001: generic-мост рассуждающих ролей на хостовые драйверы
//
// Рассуждающие роли (Приёмщик/Архитектор/Декомпозитор и пр.), назначенные в
// настройках внешнему движку ('codex' или 'claude_code'), исполняет соответствующий
// хостовый драйвер: оркестратор в Linux-контейнере не может запустить локальный
// `codex`/`claude` и не видит их подписки. Контракт ЕДИН для обоих движков (claim
// возвращает роль+готовый промпт+схему; драйвер «тупой»): меняется лишь локальный
// агент, который гоняет драйвер. LLM-вызов делается внешне, а ВЕСЬ разбор вердикта
// и переход остаются в оркестраторе (applyReasoningVerdict) — поведение ролей не
// меняется, заменяется только источник вердикта (DeepSeek-коннектор → Codex/Claude).

// GET /api/runner/next-reasoning-task?engine=codex|claude_code[&role=CODE] —
// захватить одну задачу роли, назначенной ЭТОМУ движку, и вернуть ГОТОВЫЙ промпт +
// JSON-схему вердикта. Раннер «тупой»: сборка промпта и схема остаются здесь.
// Возвращает { task: null }, если брать нечего или движок/роль не сходятся.
// INFRA-DEPARTMENT-001 — read-only список задач Инфраструктурного отдела (проекты
// pipeline_kind='infrastructure') с текущей ролью и этапом графа. Обслуживает
// MCP-инструмент статуса инфра-задач. projectRef — необязательный фильтр по коду/id
// проекта (внутри инфра-конвейера может быть несколько проектов).
export async function listInfraTasks(s, projectRef = null) {
  return withClient(clientConfig(s), async (c) => {
    const ref = String(projectRef ?? '').trim();
    const params = [];
    let projFilter = "p.pipeline_kind = 'infrastructure'";
    if (ref) {
      params.push(ref);
      projFilter += ` AND (p.code = $${params.length} OR p.id::text = $${params.length})`;
    }
    const r = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.priority::text AS priority,
              t.parent_task_id, t.created_at, t.updated_at, p.code AS project_code,
              cr.code AS current_role_code, cr.name AS current_role_name,
              ps.name AS current_stage_name, ps.kind AS current_stage_kind
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND ${projFilter}
         LEFT JOIN roles cr ON cr.id = t.current_role_id
         LEFT JOIN project_stages ps
           ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key
        ORDER BY t.created_at DESC
        LIMIT 200`,
      params,
    );
    return { tasks: r.rows };
  });
}

export async function claimNextReasoningTask(s, engineParam = null, roleParam = null) {
  const engine = String(engineParam ?? '').trim().toLowerCase();
  const role = String(roleParam ?? '').trim() || null;
  return withClient(clientConfig(s), async (c) => {
    if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
    if (!EXTERNAL_ENGINES.has(engine)) return { task: null };
    const engines = await getRoleEngines(c);
    const mine = rolesForEngine(engines, engine);
    if (mine.length === 0) return { task: null };
    if (role && !mine.includes(role)) return { task: null };

    // claimLlmRoleTask делает свой BEGIN/COMMIT и создаёт agent_run RUNNING +
    // assigned_agent_id — захват защищён от внутреннего цикла и ловится реапером
    // (resetStaleClaims) по таймауту, если драйвер умрёт, не сдав результат.
    let claimed = null;
    const order = role ? [role] : mine;
    for (const rc of order) {
      claimed = await claimLlmRoleTask(c, rc);
      if (claimed) break;
    }
    if (!claimed) return { task: null };

    // Входной гейт полей (ROLE-FIELD-CONTRACT-001) — как в processClaimedRole:
    // нет обязательного входящего поля → BLOCKED, задачу Codex не отдаём.
    const contract = await loadRoleContract(c, claimed.role_code);
    const card = parseDataCard(claimed);
    const missingIn = missingRequiredInputs(card, contract.inputs);
    if (missingIn.length) {
      await blockClaimedForFields(c, claimed, missingIn);
      return { task: null, blocked: { taskId: claimed.id, reason: 'missing_required_inputs', fields: missingIn } };
    }

    const context = await buildRoleContext(c, claimed, { engine });
    const { composeRoleSystemPrompt, resolveRoleMaxTurns } = await import('./roles.js');
    const roleSystem = await composeRoleSystemPrompt(c, claimed.role_code);
    // ARCHITECT-TURN-CAP-001: персональный кап ходов роли (рунавей-гард). Драйвер
    // claude_code применит его вместо своего дефолта; codex maxTurns игнорирует.
    // ARCHITECT-BUDGET-SCALE-001: для Архитектора кап масштабируется размером эпика
    // (число сервисов/фронтов в описании + длина описания) — мега-эпику одного
    // фиксированного капа не хватает продумать разбивку за один прогон.
    const roleMaxTurns = resolveRoleMaxTurns(claimed.role_code, { description: claimed.description });
    // PROMPT-CACHE-001: для claude_code выносим СТАТИЧНУЮ часть (промт роли + карта) в
    // system-префикс — драйвер держит его в кэше (SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 5-мин
    // ephemeral), и повторные claim'ы того же проекта/роли не переоплачивают карту. У
    // codex/deepseek кэша нет: карта остаётся в user-payload как раньше (codex — short).
    const cacheClaude = engine === 'claude_code';
    const mapBlock = cacheClaude ? renderProjectMaps(context.projectMaps) : '';
    const systemPrompt = mapBlock ? `${roleSystem}\n\n${mapBlock}` : roleSystem;
    const userPrompt = buildUserPayload(claimed.role_code, context, contract.outputs, { includeMap: !cacheClaude });
    const outputSchema = buildVerdictJsonSchema(contract.outputs);

    return {
      task: {
        id: claimed.id,
        engine,
        role: claimed.role_code,
        title: claimed.title,
        projectId: claimed.project_id,
        project: context.project,
        // Реальный корень проекта: драйвер запускает агента с этим cwd, и тот сам
        // читает файлы (свой агентный tool-loop вместо tools-service).
        projectPath: context.projectPath,
        docsPath: context.docsPath,
        agentRunId: claimed.agentRunId,
        systemPrompt,
        userPrompt,
        // PROMPT-CACHE-001: claude-драйвер держит systemPrompt как кэшируемый статичный
        // префикс (роль+карта), а userPrompt шлёт как динамику. Для codex флаг игнорируется.
        cachePrefix: cacheClaude,
        // ARCHITECT-TURN-CAP-001: персональный кап ходов (null → драйвер возьмёт дефолт).
        maxTurns: roleMaxTurns,
        outputSchema,
      },
    };
  });
}

// POST /api/runner/reasoning-completed — принять вердикт от codex-runner и сделать
// переход тем же путём, что и внутренний DeepSeek (applyReasoningVerdict). Маршрутные
// данные перечитываем на сервере по taskId (раннеру не доверяем). Идемпотентно:
// если задача терминальна или RUNNING-прогона нет (реапер/повтор) — duplicate.
export async function completeReasoningTask(s, input) {
  return withClient(clientConfig(s), async (c) => {
    const result = await completeReasoningTaskTx(c, input);
    if (result?.taskId && !result.duplicate) {
      await exportLatestAgentRunObservation(c, result.taskId, {
        eventType: 'reasoning_role_completed',
        reason: result.reason || result.verdict || result.toStatus || 'reasoning_completed',
        payload: { result },
      });
    }
    return result;
  });
}

export async function completeReasoningTaskTx(c, input) {
  const taskId = String(input?.taskId ?? '').trim();
  if (!taskId) throw scannerError(422, 'taskId_required');

  const found = await c.query(
    `SELECT t.id, t.title, t.description, t.status::text AS status, t.project_id,
            t.data_card, t.current_stage_key,
            r.code AS role_code, r.id AS role_id,
            ar.id AS agent_run_id, ar.agent_id
       FROM tasks t
       LEFT JOIN roles r ON r.id = t.current_role_id
       LEFT JOIN agent_runs ar ON ar.task_id = t.id AND ar.status = 'RUNNING'
      WHERE t.id = $1`,
    [taskId],
  );
  if (!found.rowCount) throw scannerError(404, 'task_not_found');
  const row = found.rows[0];
  if (TERMINAL_TASK_STATUSES.has(row.status)) {
    return { accepted: true, duplicate: true, taskId, toStatus: row.status, nextRole: null };
  }
  // Нет RUNNING-прогона — захват уже снят/финализирован (реапер, двойная сдача).
  if (!row.agent_run_id) {
    return { accepted: true, duplicate: true, taskId, toStatus: row.status, nextRole: null };
  }
  const engines = await getRoleEngines(c);
  if (!EXTERNAL_ENGINES.has(engines[row.role_code])) throw scannerError(409, 'role_not_delegated_to_engine');

  // reworkCount — как в claimLlmRoleTask (сколько раз задача возвращалась с анализа).
  const rc = await c.query(
    `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND from_status = 'FAILURE_ANALYSIS'`,
    [taskId],
  );
  const claimed = {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    project_id: row.project_id,
    data_card: row.data_card,
    current_stage_key: row.current_stage_key,
    role_code: row.role_code,
    role_id: row.role_id,
    agentId: row.agent_id,
    agentRunId: row.agent_run_id,
    reworkCount: rc.rows[0].n,
  };

  // Вердикт: codex с --output-schema отдаёт валидный JSON-объект; принимаем либо
  // распарсенный объект (verdict), либо сырой текст (response, парсим толерантно).
  const text = typeof input?.response === 'string' && input.response.trim()
    ? input.response
    : (input?.verdict != null ? JSON.stringify(input.verdict) : '');
  const parsed = input?.verdict && typeof input.verdict === 'object' && !Array.isArray(input.verdict)
    ? input.verdict
    : parseVerdict(text);

  // Журнал обмена для UI «Промпты» (внешний движок без коннектора → connector_id
  // NULL). Необязателен — не валим сдачу, если запись не удалась.
  let exchangeId = null;
  try {
    const ins = await c.query(
      `INSERT INTO prompt_exchanges (connector_id, consumer_service, prompt, response, status, http_status, duration_ms, is_manual)
       VALUES (NULL, $1, $2, $3, 'завершен', NULL, $4, false) RETURNING id`,
      [
        `${engines[row.role_code]}:${row.role_code}`,
        String(input?.promptText ?? '').slice(0, 100000),
        text,
        Number.isFinite(Number(input?.durationMs)) ? Number(input.durationMs) : null,
      ],
    );
    exchangeId = ins.rows[0].id;
  } catch { /* журнал необязателен */ }

  // SILENT-FAIL-GUARD-001: вердикт не распознан. VERDICT-RETRY-001: сначала авто-повтор
  // прогона роли (задача освобождается — тот же внешний движок заберёт её снова), и
  // только после исчерпания лимита — терминальный FAILED (как DeepSeek-путь).
  if (parsed === null) {
    const outcome = await failRoleUnparsed(c, claimed, { response: text, exchangeId });
    if (outcome === null) {
      return { accepted: true, taskId, toStatus: null, reason: 'verdict_unparsed', retried: true };
    }
    return { accepted: true, taskId, toStatus: 'FAILED', reason: 'verdict_unparsed' };
  }

  const verdict = normalizeVerdict(row.role_code, parsed);
  const route = await loadProjectRoute(c, row.project_id);
  const contract = await loadRoleContract(c, row.role_code);
  const res = await applyReasoningVerdict(c, claimed, {
    route,
    contract,
    verdict,
    response: text,
    exchangeId,
    durationMs: Number.isFinite(Number(input?.durationMs)) ? Number(input.durationMs) : null,
    kpi: normalizeRunKpi(input),
  });
  return {
    accepted: true,
    duplicate: false,
    taskId,
    toStatus: res?.toStatus ?? null,
    nextRole: res?.nextRole ?? null,
    verdict: verdict.status,
  };
}

// POST /api/runner/release-reasoning-task — откат захвата (codex-runner не смог
// выполнить задачу): снять назначение, agent_run RUNNING → CANCELLED. Задача
// переигрывается штатно (тот же codex-мост заберёт её снова).
export async function releaseReasoningTask(s, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withClient(clientConfig(s), async (c) => {
    await c.query(
      `UPDATE agent_runs SET status = 'CANCELLED', finished_at = now() WHERE task_id = $1 AND status = 'RUNNING'`,
      [id],
    );
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND assigned_agent_id IS NOT NULL AND status NOT IN ('DONE','CANCELLED') RETURNING id`,
      [id],
    );
    const result = { released: r.rowCount > 0, taskId: id };
    if (result.released) {
      await exportLatestAgentRunObservation(c, id, {
        eventType: 'reasoning_role_released',
        reason: 'reasoning_released',
        payload: { result },
      });
    }
    return result;
  });
}

// Пары (роль, статус) только для ИИ-ролей: их продвигает runner через вызов
// модели. PIPELINE_SERVICE/GIT_INTEGRATOR исключены — их ведёт host-мост.
const LLM_FLOW_PAIRS = LLM_ROLE_CODES.flatMap((code) =>
  ROLE_FLOW[code].from.map((status) => ({ code, status })),
);

// Захваченная под ролью задача, у которой ИИ-вызов завис, не должна держать
// слот вечно: по таймауту снимаем захват и помечаем прогон TIMEOUT.
//
// CONFIG-AUDIT-001: единый дефолт орфан-таймаута роли = 10 мин — совпадает с
// docker-compose (RUNNER_ROLE_TIMEOUT_MS:-600000) и .env. Прежде здесь было 15 мин,
// в compose — 3 мин, в .env — 10 мин: один параметр имел ТРИ разных дефолта, и
// эффективное значение зависело от способа запуска. КОНТРАКТ: должно быть БОЛЬШЕ
// hard-timeout раннеров (start-runners.ps1 = 540000 ≈ 9 мин), иначе реапер
// освобождает захват раньше раннера → agent_aborted по кругу. Парсинг через
// `Number(env) || default`, а НЕ `Number(env || default)`: мусорный env → дефолт,
// а не NaN (NaN-таймаут срабатывал бы мгновенно). См. CONFIG_AUDIT.md.
const DEFAULT_ROLE_TIMEOUT_MS = 10 * 60 * 1000;
const roleTimeoutCfg = resolveDuration('RUNNER_ROLE_TIMEOUT_MS', DEFAULT_ROLE_TIMEOUT_MS, { min: 30_000, max: 2 * 60 * 60_000 });
const ROLE_TIMEOUT_MS = roleTimeoutCfg.value;

// Задача, выданная Claude (PROGRAMMER) через файловый мост, помечается
// assigned_agent_id, но НЕ создаёт agent_run RUNNING. Если completion от Claude
// не вернулся (сессия прервалась, Scanner был недоступен, слот очищен без
// доставки), задача навсегда зависает в CODING: фидер её не переподаёт (нужен
// assigned_agent_id IS NULL), а runner роль PROGRAMMER не ведёт. По таймауту
// освобождаем назначение — фидер переподаст её, как только слот освободится.
const claudeAssignCfg = resolveDuration('RUNNER_CLAUDE_TIMEOUT_MS', ROLE_TIMEOUT_MS, { min: 30_000, max: 2 * 60 * 60_000 });
const CLAUDE_ASSIGN_TIMEOUT_MS = claudeAssignCfg.value;

// HOST-ORPHAN-TIMEOUT-001: host-роли (PIPELINE_SERVICE из TESTING, GIT_INTEGRATOR
// из COMMIT) при claim через /api/runner/next-host-task создают agent_run RUNNING
// (claimNextHostTask). Если host-runner умирает посреди работы (docker compose build
// в PIPELINE_SERVICE, коммит в GIT_INTEGRATOR), release-host-task не приходит и прогон
// висит RUNNING, держа слот роли и назначение (AGENT_ASSIGNED) навсегда. Формально их
// реапят resetStaleClaims/reapOrphanRunningRuns, но по ОБЩЕМУ ROLE_TIMEOUT_MS (10 мин),
// который короче длинной docker-сборки → живой прогон срезался бы посреди build (тот же
// класс инцидента, что 10-минутный срез PROGRAMMER). Даём host-ролям ОТДЕЛЬНЫЙ больший
// таймаут: дефолт 40 мин — с запасом над самой долгой ожидаемой сборкой, но не
// бесконечность. КОНТРАКТ (CONFIG-AUDIT-001): дефолт совпадает в db.js/compose/.env и
// БОЛЬШЕ ROLE_TIMEOUT_MS. См. CONFIG_AUDIT.md.
const DEFAULT_HOST_TIMEOUT_MS = 40 * 60 * 1000;
const hostTimeoutCfg = resolveDuration('RUNNER_HOST_TIMEOUT_MS', DEFAULT_HOST_TIMEOUT_MS, { min: 60_000, max: 4 * 60 * 60_000 });
const HOST_TIMEOUT_MS = hostTimeoutCfg.value;
// Коды host-ролей для ветвления таймаута/события в жнецах (из единого HOST_ROLES).
const HOST_ROLE_CODES = Object.keys(HOST_ROLES);

// DOC-BRANCH-LIVENESS-001: максимальный возраст «зависания» документационной
// fork-ветви, после которого она принудительно продвигается к join (чтобы не
// держать родителя, даже если движок документации вообще не создаёт прогонов —
// напр. codex-драйвер завис/недоступен, bad_runs не растёт). Документация вправе
// идти ДОЛЬШЕ коммита (дефолт 1 час — щедро), но не бесконечно.
const docBranchAgeCfg = resolveDuration('RUNNER_DOC_BRANCH_MAX_AGE_MS', 60 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 });
const DOC_BRANCH_MAX_AGE_MS = docBranchAgeCfg.value;

// CONFIG-AUDIT-001: стартовый лог эффективных орфан-таймаутов с атрибуцией
// источника (env|default) — чтобы по логу было видно, что реально применилось.
logEffectiveConfig('orchestrator timeouts', [roleTimeoutCfg, claudeAssignCfg, hostTimeoutCfg]);

// PROGRAMMER-RELEASE-BACKOFF-001 — расписание backoff/cooldown на повторный захват
// одной задачи программистом после подряд идущих неудачных release и порог K для
// предохранителя от вечной петли (инцидент 03.07.2026, PRINT-054: 1407 бесполезных
// прогонов за 2 часа, стадия CODING заблокирована для остальных задач). Дефолт —
// 30с → 2мин → 10мин (потолок на хвосте) и K=5 подряд провалов. Оба параметра
// переопределяемы через env (рядом с CLAUDE_ASSIGN_TIMEOUT_MS для обозримости).
const DEFAULT_PROGRAMMER_RELEASE_BACKOFF_MS = [30_000, 120_000, 600_000];

// Разбор расписания backoff из env: CSV длительностей ("30s,2m,10m" или
// "30000,120000,600000"). Пусто/мусор целиком → дефолт; невалидные/непозитивные
// элементы отбрасываются, пустой результат → дефолт. Чистая функция (юнит-тест).
export function parseBackoffScheduleMs(raw, dflt = DEFAULT_PROGRAMMER_RELEASE_BACKOFF_MS) {
  if (raw == null || String(raw).trim() === '') return [...dflt];
  const vals = String(raw)
    .split(',')
    .map((p) => parseDurationMs(p))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n));
  return vals.length ? vals : [...dflt];
}

const PROGRAMMER_RELEASE_BACKOFF_MS = parseBackoffScheduleMs(
  process.env.PROGRAMMER_RELEASE_BACKOFF_MS_SCHEDULE,
);
const programmerLoopMaxCfg = resolveInt('PROGRAMMER_RELEASE_LOOP_MAX', 5, { min: 1, max: 1000 });
const PROGRAMMER_RELEASE_LOOP_MAX = programmerLoopMaxCfg.value;
// PROGRAMMER-MODEL-ROUTING-001: модель программиста по сложности задачи. Мелкая
// подзадача-на-файл декомпозиции (task_kind='subtask') — точечная правка: дефолт
// Sonnet (быстрее и дешевле Opus, без потери качества на узкой задаче). Цельная
// задача-на-сервис (task_kind='service', в т.ч. legacy-одиночки) — шире по контексту:
// дефолт Opus. Раньше ВСЕ CODING шли на Opus (дефолт агента/раннера) — избыточно для
// мелочи. Имена моделей переопределяемы через env (сменить поколение без правки кода).
// Явно назначенный роли Claude-коннектор (role_connectors) ПЕРЕБИВАЕТ роутинг — это
// осознанный выбор оператора «одна модель на всё» (см. claimNextClaudeTaskTx).
const PROGRAMMER_MODEL_SIMPLE = String(process.env.PROGRAMMER_MODEL_SIMPLE || 'claude-sonnet-5').trim();
const PROGRAMMER_MODEL_COMPLEX = String(process.env.PROGRAMMER_MODEL_COMPLEX || 'claude-opus-4-8').trim();
export function programmerModelForKind(taskKind) {
  return String(taskKind) === 'subtask' ? PROGRAMMER_MODEL_SIMPLE : PROGRAMMER_MODEL_COMPLEX;
}
// ARCHITECT-BUDGET-LOOP-001: сколько подряд CANCELLED/TIMEOUT-прогонов Архитектора
// (мега-эпик не влезает в бюджет одного прогона) уводят задачу в BLOCKED С ПРИЧИНОЙ.
// Дефолт 3 — по инциденту («три CANCELLED подряд по таймауту»). Настройка.
const architectBudgetLoopMaxCfg = resolveInt('ARCHITECT_BUDGET_LOOP_MAX', 3, { min: 1, max: 100 });
const ARCHITECT_BUDGET_LOOP_MAX = architectBudgetLoopMaxCfg.value;
// Человекочитаемая причина блока (кладём и в карточку задачи, и в событие).
const ARCHITECT_BUDGET_BLOCK_REASON = 'Архитектор не уложился в бюджет: несколько прогонов подряд отменены по таймауту рассуждения — задача слишком крупная. Разбейте эпик на пакеты по 4–5 сервисов/фронтов и верните в ARCHITECTURE, либо увеличьте бюджет ходов/времени Архитектора.';
// TASK-RUN-LOOP-CAP-001: общий предохранитель для ЛЮБОЙ роли — K подряд
// CANCELLED/TIMEOUT-прогонов этапа → BLOCKED с причиной («пуск руками»). Порог выше
// архитекторского (узкие жнецы срабатывают раньше со своим диагнозом). Настройка.
const taskRunLoopMaxCfg = resolveInt('TASK_RUN_LOOP_MAX', 5, { min: 1, max: 1000 });
const TASK_RUN_LOOP_MAX = taskRunLoopMaxCfg.value;
const TASK_RUN_LOOP_BLOCK_REASON = 'Автоматика остановлена: несколько прогонов этапа подряд оборваны без результата (таймаут/отмена) — задача перезапускалась по кругу и жгла токены. Разберите причину (лог прогонов этапа, бюджет времени роли) и запустите вручную: переместите задачу на нужный этап.';
logEffectiveConfig('programmer release loop', [programmerLoopMaxCfg]);
logEffectiveConfig('architect budget loop', [architectBudgetLoopMaxCfg]);
logEffectiveConfig('task run loop cap', [taskRunLoopMaxCfg]);
console.log(`programmer release backoff schedule (ms)=${JSON.stringify(PROGRAMMER_RELEASE_BACKOFF_MS)}`);

// --- Динамический маршрут проекта (PIPELINE-DYNAMIC-ROUTE-001) ---------------

// Прочитать этапы проекта и собрать плоский маршрут (buildRoute). Пустой массив
// — у проекта нет этапов (применяется канонический фолбэк ROLE_FLOW).
async function loadProjectRoute(c, projectId) {
  if (!projectId) return [];
  const stages = await c.query(
    `SELECT id, position, enabled, task_status::text AS task_status, stage_key
       FROM project_stages WHERE project_id = $1 ORDER BY position`,
    [projectId],
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT psr.stage_id, r.code, psr.position
       FROM project_stage_roles psr JOIN roles r ON r.id = psr.role_id
      WHERE psr.stage_id = ANY($1::uuid[]) ORDER BY psr.position, r.code`,
    [stages.rows.map((s) => s.id)],
  );
  const byStage = new Map();
  for (const row of roles.rows) {
    if (!byStage.has(row.stage_id)) byStage.set(row.stage_id, []);
    byStage.get(row.stage_id).push(row.code);
  }
  return buildRoute(
    stages.rows.map((s) => ({
      position: s.position,
      enabled: s.enabled,
      taskStatus: s.task_status,
      stageKey: s.stage_key,
      roleCodes: byStage.get(s.id) ?? [],
    })),
  );
}

// FORK-JOIN-001: узлы проекта по стабильному ключу (для граф-маршрутизации и
// подметателей fork/join). Первая роль этапа — исполнитель/gate узла.
async function loadProjectNodes(c, projectId) {
  const stages = await c.query(
    `SELECT id, stage_key, kind, join_key, name, enabled, task_status::text AS task_status
       FROM project_stages WHERE project_id = $1 ORDER BY position`,
    [projectId],
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT psr.stage_id, psr.role_id, r.code, psr.position
       FROM project_stage_roles psr JOIN roles r ON r.id = psr.role_id
      WHERE psr.stage_id = ANY($1::uuid[]) ORDER BY psr.position, r.code`,
    [stages.rows.map((s) => s.id)],
  );
  const firstRole = new Map();
  for (const row of roles.rows) {
    if (!firstRole.has(row.stage_id)) firstRole.set(row.stage_id, { roleId: row.role_id, roleCode: row.code });
  }
  return stages.rows.map((s) => ({
    stageKey: s.stage_key,
    kind: s.kind ?? 'stage',
    joinKey: s.join_key ?? null,
    name: s.name,
    enabled: s.enabled,
    status: s.task_status,
    roleId: firstRole.get(s.id)?.roleId ?? null,
    roleCode: firstRole.get(s.id)?.roleCode ?? null,
  }));
}

// Загрузить рёбра графа проекта (для граф-маршрутизации). [] — линейный проект.
async function loadProjectEdges(c, projectId) {
  const r = await c.query(
    `SELECT from_key, to_key, condition, position
       FROM project_stage_edges WHERE project_id = $1 ORDER BY from_key, position`,
    [projectId],
  );
  return r.rows.map((e) => ({
    fromKey: e.from_key, toKey: e.to_key, condition: e.condition ?? null, position: e.position,
  }));
}

// Построить граф проекта (узлы + рёбра) для graphRoute. null — нет рёбер (линейный).
async function loadProjectGraph(c, projectId) {
  const edges = await loadProjectEdges(c, projectId);
  if (!edges.length) return null;
  const nodes = await loadProjectNodes(c, projectId);
  return { graph: buildGraph(nodes, edges), nodes };
}

/**
 * FORK-JOIN-001: граф-переход для задачи с current_stage_key. Возвращает контракт
 * как resolveTransition, плюс nextStageKey. Узлы fork/join несут gate-роль —
 * задача «садится» на них, а дальше её обрабатывает подметатель.
 */
async function resolveGraphTransition(c, claimed, decision) {
  if (decision.outcome === 'BLOCK') {
    return { nextRole: null, toStatus: decision.blockStatus || 'BLOCKED', done: false, blocked: true, via: 'graph', nextStageKey: claimed.current_stage_key };
  }
  const loaded = await loadProjectGraph(c, claimed.project_id);
  if (!loaded) {
    // Рёбра исчезли (схему переписали в линейную) — фолбэк на позиционный резолвер.
    const route = await loadProjectRoute(c, claimed.project_id);
    return { ...resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    }), nextStageKey: null };
  }
  // FA-REWORK-ROUTE-001: доработка (напр. диагност сбоя вернул задачу) идёт НАЗАД к
  // ближайшему исполнителю по рёбрам графа, а не вперёд по маршруту — иначе вердикт
  // «на доработку» проглатывается следующим узлом (fork/join спавнит ветки как при
  // успехе). Цели нет (нет исполнителя выше по графу) → фолбэк на линейный резолвер.
  if (decision.outcome === 'REWORK') {
    const backKey = reworkNodeKey(loaded.graph, claimed.current_stage_key);
    if (backKey) {
      const backNode = nodeByKey(loaded.graph, backKey);
      return {
        nextRole: backNode?.roleCode ?? null,
        toStatus: backNode?.status || claimed.status,
        done: false, blocked: false, via: 'graph', nextStageKey: backKey,
      };
    }
    const route = await loadProjectRoute(c, claimed.project_id);
    return { ...resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    }), nextStageKey: null };
  }
  const nextKey = nextNodeKey(loaded.graph, claimed.current_stage_key, decision);
  if (!nextKey) {
    return { nextRole: null, toStatus: 'DONE', done: true, blocked: false, via: 'graph', nextStageKey: null };
  }
  const node = nodeByKey(loaded.graph, nextKey);
  return {
    nextRole: node?.roleCode ?? null,
    // gate-узлы (fork/join) не имеют статуса — сохраняем текущий статус задачи.
    toStatus: node?.status || claimed.status,
    done: false,
    blocked: false,
    via: 'graph',
    nextStageKey: nextKey,
  };
}

// Кэш наличия таблицы role_fields (контракт необязателен — может не быть миграции).
let _roleFieldsTablePresent;
async function roleFieldsTablePresent(c) {
  if (_roleFieldsTablePresent === undefined) {
    const reg = await c.query("SELECT to_regclass('public.role_fields') AS t");
    _roleFieldsTablePresent = Boolean(reg.rows[0]?.t);
  }
  return _roleFieldsTablePresent;
}

// Только для тестов: сбросить кэш наличия role_fields (он глобален на процесс,
// поэтому fake-клиенты разных тест-файлов могут зафиксировать чужое значение).
export function __resetRoleFieldsCacheForTests() {
  _roleFieldsTablePresent = undefined;
}

// Контракт одной роли: { inputs:[{key,required}], outputs:[{key,required}] }.
async function loadRoleContract(c, roleCode) {
  const empty = { inputs: [], outputs: [] };
  if (!(await roleFieldsTablePresent(c))) return empty;
  const r = await c.query(
    `SELECT rf.direction, rf.required, f.key, f.name, f.description, f.value_type
       FROM role_fields rf
       JOIN roles ro ON ro.id = rf.role_id
       JOIN fields f ON f.id = rf.field_id
      WHERE ro.code = $1 ORDER BY rf.position, f.key`,
    [roleCode],
  );
  const out = { inputs: [], outputs: [] };
  for (const row of r.rows) {
    (row.direction === 'in' ? out.inputs : out.outputs).push({
      key: row.key,
      required: row.required !== false,
      name: row.name ?? row.key,
      description: row.description ?? '',
      valueType: row.value_type ?? 'text',
    });
  }
  return out;
}

/**
 * Stage 3: один шаг фонового runner. Для каждой ИИ-роли:
 *   1) claim задачи в отдельной транзакции (FOR UPDATE SKIP LOCKED + пометка
 *      assigned_agent_id и agent_run RUNNING) — слот занят, повторно не возьмут;
 *   2) вызов модели ВНЕ транзакции (роль «думает»), журнал в prompt_exchanges;
 *   3) финализация в новой транзакции: переход по вердикту, agent_run, событие,
 *      для ревью — запись в reviews.
 * Сетевой вызов держим вне транзакции, чтобы не блокировать строки на минуты.
 * Возвращает массив применённых шагов.
 */
export async function advanceAutomatedTasks(s, opts = {}) {
  if (opts.orchestratorEnabled === false) return [];
  if (opts.orchestratorEnabled === undefined && !(await getOrchestratorEnabled(s))) return [];

  // RUNNER-CONCURRENCY-001: лимит «горутин на роль» берём из app_settings (UI),
  // переопределение через opts — для тестов. Минимум 1.
  const cap = Math.max(
    1,
    Number(opts.maxConcurrencyPerRole ?? (await getMaxConcurrencyPerRole(s))) || 1,
  );

  // Предшаги (реконсиляция, пропуск ролей, fork/join) — быстрые, на одном клиенте.
  // Здесь же планируем, сколько свободных слотов осталось по каждой роли.
  const slots = await withClient(clientConfig(s), async (c) => {
    await resetStaleClaims(c);
    // RUNNER-RUNTIME-REAP-001: помимо просроченных захватов, на каждом тике гасим
    // осиротевшие RUNNING-прогоны рассуждающих ролей старше таймаута. Свежие сироты
    // возникают в рантайме при обрыве соединения с БД (pgbouncer/Patroni) — их
    // финализация рвётся, и они держат слот роли до 30-минутного таймаута, заклинивая
    // очередь. ageCheck=true: возраст проверяется по RUNNER_ROLE_TIMEOUT_MS с
    // clockGuard, поэтому реально идущие прогоны не гасятся раньше срока.
    await reapOrphanRunningRuns(c, { ageCheck: true });
    // ORPHAN-ROLE-REATTACH-001: самоисцеление осиротевших по роли задач. Активная
    // задача без current_role_id НЕВИДИМА для claim (claimLlmRoleTask/claimHostTask
    // делают INNER JOIN roles по current_role_id) и висит вечно. Так получается после
    // массовых ручных операций (напр. bulk_unblock_refeed выставил статус, но не роль).
    // Восстанавливаем роль из этапов проекта ДО claim, чтобы задача поехала тем же тиком.
    await reattachOrphanStageRoles(c);
    await reattachBlockedOwnerRoles(c);
    await closeBlockedDuplicateTasks(c);
    // TESTS-GREEN-SKIP-FA-001 (fix B): разорвать бесконечный self-loop аналитика
    // сбоя. Прогон FAILURE_ANALYST на слабой модели может раз за разом упираться в
    // таймаут роли — resetStaleClaims возвращает задачу в тот же FAILURE_ANALYSIS, и
    // она переигрывается вечно, занимая слот. Задачу с РЕАЛЬНЫМ провалом тестов, у
    // которой накопилось >= MAX_REWORK безрезультатных прогонов аналитика, уводим в
    // BLOCKED (на человека). Зелёные задачи сюда не попадают — их раньше пропускает
    // maybeSkipFailureAnalyst (forward), поэтому здесь явно требуем провала пайплайна.
    await blockExhaustedFailureAnalysis(c);
    // PROGRAMMER-RELEASE-BACKOFF-001: предохранитель от вечной петли захвата одной
    // задачи программистом. После K подряд неуспешных PROGRAMMER-прогонов уводим
    // CODING-задачу в BLOCKED (см. escalateProgrammerReleaseLoop) — cooldown в
    // claimNextClaudeTask лишь тормозит захват, а этот свипер разрывает петлю, чтобы
    // задача не молотила часами и не держала единственный слот программиста.
    await escalateProgrammerReleaseLoop(c);
    // ARCHITECT-BUDGET-LOOP-001: Архитектор, K раз подряд отменённый/просроченный по
    // reasoning-таймауту на мега-эпике, уводится в BLOCKED С ВНЯТНОЙ ПРИЧИНОЙ (в
    // карточке и событии), а не молча — чтобы человек видел «задача слишком крупная,
    // разбейте на пакеты или увеличьте бюджет», а не пустой блок без диагноза.
    await escalateArchitectBudgetLoop(c);
    // TASK-RUN-LOOP-CAP-001: общий предохранитель — ЛЮБАЯ роль, K раз подряд
    // оборванная без вердикта (CANCELLED/TIMEOUT), останавливается в BLOCKED с
    // причиной в карточке; дальше пуск руками (move на этап после разбора).
    await escalateRunawayRoleLoops(c);
    // DOC-BRANCH-LIVENESS-001: документационная fork-ветвь не должна заклинивать
    // родителя на join. Мёртвую ветку документации (BLOCKED/FAILED/исчерпание попыток)
    // продвигаем на узел вперёд к join ДО снятия join-барьера, чтобы родитель поехал.
    await advanceStuckDocumentationBranches(c);
    // Пропускаемые роли (ROLE-GROUPS-001 / per-project) прокручиваются до первой
    // активной роли ДО любого claim — за пропущенные роли не создаётся agent/host run.
    await advanceSkippedStageRoles(c);
    // FORK-JOIN-001: расщепление в fork и снятие барьера в join — до claim, чтобы
    // дети попадали в очередь, а родитель не клеймился на gate-узле.
    await advanceForkNodes(c);
    await advanceJoinNodes(c);
    // WORK-STACK-001: очередь работ Архитектор→Программист. Reconcile промоутнутых
    // (терминальная дочерняя задача → терминальный элемент, снимаем замок сервиса) +
    // promote следующего PENDING-элемента на каждый свободный микросервис (заводит
    // дочернюю CODING-задачу). ДО роллапа — чтобы свежесозданные дети и освободившиеся
    // сервисы учитывались тем же тиком.
    await advanceWorkStack(c);
    // DECOMP-CONTRACT-001: эпик, у которого все задачи-на-сервис стали терминальны,
    // завершается (DONE) или блокируется (BLOCKED, если сервис упал). Линейный
    // аналог снятия join-барьера для декомпозиции по микросервисам.
    await advanceDecompositionParents(c);
    // TASK-AUTO-ACCEPT-001: авто-приёмка DONE по умолчанию ВЫКЛЮЧЕНА. Оба дефолта
    // (readAppSetting fallback и parseBoolSetting fallback) — false: при отсутствии
    // ключа 'auto_accept_done' гейт закрыт, autoAcceptDoneTasks НЕ вызывается, и свежие
    // DONE остаются в подразделе «Проверка» до ручного «Принять». Если авто-приёмку
    // включили в UI, помечаем свежие DONE принятыми в том же тике — задача сразу в
    // «Выполнено». Делаем ПОСЛЕ шагов, приводящих к DONE (join/rollup), чтобы не ждать
    // следующего тика.
    if (parseBoolSetting(await readAppSetting(c, 'auto_accept_done', false), false)) {
      await autoAcceptDoneTasks(c);
    }
    // ROLE-ENGINE-ROUTING-001: роли, делегированные внешнему движку (codex/
    // claude_code), внутренний DeepSeek-цикл НЕ исполняет — их захватывает
    // соответствующий хостовый драйвер через /api/runner/next-reasoning-task.
    // Иначе движки конкурировали бы за одни и те же задачи.
    const external = new Set(externalRoles(await getRoleEngines(c)));
    const internalRoles = LLM_ROLE_CODES.filter((r) => !external.has(r));
    return computeRoleFreeSlots(c, cap, internalRoles);
  });

  // ORCH-BOOT-CLAIM-GRACE-001 (проактивная часть): если недавно ловили обрыв
  // соединения с БД, придерживаем НОВЫЕ claim'ы на короткое окно. Предшаги выше
  // (реконсиляция часов, реап осиротевших RUNNING, fork/join) уже отработали и
  // расчищают залипшие прогоны — а новые claim'ы во время нестабильной БД только
  // плодили бы новых сирот (claim прошёл, финализация порвалась). opts.now —
  // монотонные мс (undefined в проде → текущее, заданное число — в тестах).
  if (claimGraceActive(opts.now)) return [];

  // По одному воркеру на каждый свободный слот роли. Каждый claim+process идёт в
  // СВОЁМ соединении и транзакции — задачи разных (и одной) ролей обрабатываются
  // параллельно. Двойной захват исключён FOR UPDATE SKIP LOCKED в claimLlmRoleTask.
  const jobs = [];
  for (const [roleCode, free] of slots) {
    for (let i = 0; i < free; i += 1) jobs.push(roleCode);
  }
  // DB-FINALIZE-RETRY-001: конфиг БД пробрасываем в processClaimedRole, чтобы ретрай
  // финализации мог открыть СВЕЖЕЕ соединение (withClient(cfg)), когда claim-соединение
  // порвалось. Один снимок конфига на тик — read-only данные, безопасно шарить.
  const cfg = clientConfig(s);
  const results = await Promise.all(
    jobs.map((roleCode) =>
      withClient(cfg, async (c) => {
        const claimed = await claimLlmRoleTask(c, roleCode);
        if (!claimed) return null;
        return processClaimedRole(c, claimed, cfg);
      }).catch((error) => {
        // ORCH-BOOT-CLAIM-GRACE-001 (реактивная часть): обрыв СОЕДИНЕНИЯ именно в
        // claim/process — главный источник осиротевших RUNNING-прогонов (claim
        // создан, но финализация порвалась). Фиксируем шторм, чтобы ближайшие тики
        // придержали новые claim'ы, пока БД не стабилизируется, и не плодили новых
        // сирот.
        if (isDbConnectionError(error)) noteDbConnectionFailure(opts.now);
        // DB-FINALIZE-RETRY-001: НЕ глушим ошибку молча. Пост-LLM запись уже прошла
        // ограниченный ретрай на свежем соединении (см. finalizeWithConnRetry); если
        // и он исчерпан — логируем явно. Прогон остаётся RUNNING и будет подобран
        // per-tick сбросом (reapOrphanRunningRuns/resetStaleClaims по таймауту роли).
        // Возврат null не роняет тик — прочие слоты и предшаги продолжают работать.
        console.error(
          `[orchestrator-service] прогон роли ${roleCode}: claim/финализация не завершена `
          + `(${error?.message ?? error}); прогон оставлен под per-tick сброс`,
        );
        return null;
      }),
    ),
  );
  return results.filter(Boolean);
}

// RUNNER-CONCURRENCY-001: сколько новых воркеров запускать по каждой ИИ-роли в
// этом тике. free = min(ожидающие задачи, cap − уже в работе). Считаем по всем
// видимым ролям активных проектов одним запросом; роли без ожидающих опускаем.
async function computeRoleFreeSlots(c, cap, roleCodes = LLM_ROLE_CODES) {
  if (!roleCodes || roleCodes.length === 0) return new Map();
  const r = await c.query(
    `SELECT r.code AS role_code,
            count(*) FILTER (WHERE t.assigned_agent_id IS NOT NULL)::int AS inflight,
            count(*) FILTER (WHERE t.assigned_agent_id IS NULL)::int AS pending
       FROM roles r
       JOIN tasks t ON t.current_role_id = r.id
       JOIN projects p ON p.id = t.project_id
      WHERE r.code = ANY($1::text[])
        AND r.hidden = false
        AND p.status <> 'paused'
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN')
      GROUP BY r.code`,
    [roleCodes],
  );
  const slots = new Map();
  for (const row of r.rows) {
    const free = Math.min(row.pending, Math.max(0, cap - row.inflight));
    if (free > 0) slots.set(row.role_code, free);
  }
  return slots;
}

// Низкоуровневое чтение app_settings (рантайм-конфиг). Таблицы может ещё не быть
// (миграция не накатана) — тогда отдаём fallback, не роняя runner.
export async function readAppSetting(c, key, fallback) {
  try {
    const r = await c.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

export function parseBoolSetting(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

async function getOrchestratorEnabledTx(c) {
  return parseBoolSetting(await readAppSetting(c, 'orchestrator_enabled', true), true);
}

export async function getOrchestratorEnabled(s) {
  return withClient(clientConfig(s), (c) => getOrchestratorEnabledTx(c));
}

// Лимит параллельных обработок на роль (app_settings.max_concurrency_per_role).
export async function getMaxConcurrencyPerRole(s) {
  return withClient(clientConfig(s), async (c) => {
    const v = await readAppSetting(c, 'max_concurrency_per_role', 3);
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : 3;
  });
}

// ROLE-ENGINE-ROUTING-001: карта «рассуждающая роль → движок».
//
// ИСТОЧНИК ИСТИНЫ — назначения «роль → интеграция (коннектор)» (role_connectors):
// движок роли = тип провайдера назначенного ВКЛЮЧЁННОГО коннектора. Это и есть
// объединение бывших полей «Интеграция (коннектор)» и «Движок» в одно — выбор
// интеграции в карточке роли определяет исполнителя:
//   provider codex/claude_code → хостовый драйвер (внешний движок);
//   deepseek/openai/прочее     → внутренний DeepSeek-цикл оркестратора.
const EXTERNAL_ENGINES = new Set(['codex', 'claude_code']);

// Тип провайдера коннектора → движок исполнения роли. Должен совпадать с
// frontend roleEngines.ts (providerToEngine).
function providerToEngine(provider) {
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'codex' || p === 'claude_code') return p;
  return 'deepseek';
}

async function getRoleEngines(c) {
  const allowed = new Set(LLM_ROLE_CODES);

  // Источник истины — role_connectors: движок роли = тип провайдера её назначенного
  // ВКЛЮЧЁННОГО коннектора. Выключенная интеграция = «не делегируем» (и в UI она не
  // показывается в списке движков).
  const assigned = new Map();
  const rc = await c.query(
    `SELECT rc.role_code, cn.provider
       FROM role_connectors rc
       JOIN connectors cn ON cn.id = rc.connector_id
      WHERE cn.is_enabled = true`,
  );
  for (const row of rc.rows) {
    const role = String(row.role_code).trim().toUpperCase();
    if (allowed.has(role)) assigned.set(role, providerToEngine(row.provider));
  }

  // Отдаём только внешние делегирования (codex/claude_code) — внутренний движок
  // (deepseek) есть дефолт и в карте не хранится, его консьюмеры трактуют как «не
  // внешний».
  const out = {};
  for (const role of allowed) {
    const engine = assigned.get(role);
    if (engine === 'codex' || engine === 'claude_code') out[role] = engine;
  }
  return out;
}

// Роли, делегированные ВНЕШНЕМУ движку (codex/claude_code): их не исполняет
// внутренний DeepSeek-цикл, а захватывает соответствующий хостовый драйвер.
function externalRoles(engines) {
  return Object.entries(engines).filter(([, e]) => EXTERNAL_ENGINES.has(e)).map(([r]) => r);
}

// Роли, назначенные конкретному внешнему движку (для claim хостовым драйвером).
function rolesForEngine(engines, engine) {
  return Object.entries(engines).filter(([, e]) => e === engine).map(([r]) => r);
}

/**
 * Пропуск скрытых ролей (ROLE-CONFIGURATION-001): задачи, чья текущая роль
 * помечена hidden, переводятся к первой следующей активной роли без вызова
 * исполнителя. Работает для одной и нескольких скрытых ролей подряд и для
 * пропущенной последней роли маршрута (задача штатно достигает DONE). Не трогает
 * задачи в работе (assigned_agent_id) и терминальные. Идемпотентно по тикам.
 * Возвращает число продвинутых задач.
 *
 * Per-project (ROLE-GROUPS-001): роль пропускается, если назначена на ОТКЛЮЧЁННЫЙ
 * этап проекта (project_stages.enabled = false) и не встречается ни на одном
 * включённом этапе того же проекта. Глобального скрытия (roles.hidden) больше нет
 * — пропуск настраивается отдельно для каждого проекта в «Этапы пайплайна».
 */
async function advanceSkippedStageRoles(c) {
  // Набор пропускаемых кодов ролей по проектам: роль в отключённом этапе и НЕ в
  // одном включённом этапе того же проекта (иначе она остаётся активной).
  const skippedRows = await c.query(
    `SELECT ps.project_id, r.code
       FROM project_stages ps
       JOIN project_stage_roles psr ON psr.stage_id = ps.id
       JOIN roles r ON r.id = psr.role_id
      GROUP BY ps.project_id, r.code
     HAVING bool_or(NOT ps.enabled) AND NOT bool_or(ps.enabled)`,
  );
  if (!skippedRows.rowCount) return 0;
  const byProject = new Map();
  for (const row of skippedRows.rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, new Set());
    byProject.get(row.project_id).add(row.code);
  }

  const tasks = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id, t.project_id, r.code AS role_code
       FROM tasks t JOIN roles r ON r.id = t.current_role_id
      WHERE t.project_id = ANY($1::uuid[])
        AND t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','WAITING_FOR_CHILDREN')`,
    [[...byProject.keys()]],
  );

  let moved = 0;
  for (const t of tasks.rows) {
    const skipped = byProject.get(t.project_id);
    if (!skipped || !skipped.has(t.role_code)) continue;
    // PIPELINE-DYNAMIC-ROUTE-001: прокручиваем через маршрут проекта — forwardFrom
    // возвращает первую ВКЛЮЧЁННУЮ роль после текущей (пропуская отключённые этапы).
    const route = await loadProjectRoute(c, t.project_id);
    const fwd = forwardFrom(route, t.role_code);
    if (fwd === undefined) continue; // роли нет в маршруте — не трогаем
    const done = fwd === null;
    const toStatus = done ? 'DONE' : fwd.status;
    const nextRoleCode = done ? null : fwd.roleCode;
    const nextRoleId = !nextRoleCode
      ? null
      : await roleIdByCode(c, nextRoleCode);
    await c.query('BEGIN');
    try {
      const upd = await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3
          WHERE id = $1 AND assigned_agent_id IS NULL AND status NOT IN ('DONE','CANCELLED')`,
        [t.id, toStatus, nextRoleId],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
          [
            t.id,
            done ? 'TASK_DONE' : 'STATUS_CHANGED',
            t.status,
            toStatus,
            t.current_role_id,
            JSON.stringify({
              runner: true,
              reason: 'skipped_disabled_stage_role',
              skippedRole: t.role_code,
              nextRole: nextRoleCode,
            }),
          ],
        );
        moved += 1;
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
  return moved;
}

/**
 * FORK-JOIN-001 (Phase 4) — расщепление в узле fork. Задача, доехавшая до узла
 * kind='fork' (current_stage_key), порождает по подзадаче на каждую исходящую
 * ветку и паркуется на парном join в WAITING_FOR_CHILDREN.
 * FORK-CHILD-001: расщепляется и ДОЧЕРНЯЯ задача (сервисная подзадача эпика) —
 * раньше `parent_task_id IS NULL` навсегда заклинивал детей на fork-узле (Git
 * Integrator не запускался, деливеребл не коммитился). Идемпотентно: расщепляем,
 * только если НЕЗАВЕРШЁННЫХ детей нет (терминальные дети прошлого прохода fork не
 * блокируют повторный проход после REWORK). Один txn на задачу.
 */
export async function advanceForkNodes(c) {
  const parents = await c.query(
    `SELECT t.id, t.project_id, t.title, t.description, t.service_id,
            t.status::text AS status, t.current_role_id, t.current_stage_key, t.data_card,
            ps.join_key
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'fork'
      WHERE t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN')
        AND NOT EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id
                          AND ch.status NOT IN ('DONE','CANCELLED','FAILED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  let forked = 0;
  for (const p of parents.rows) {
    const loaded = await loadProjectGraph(c, p.project_id);
    if (!loaded) continue;
    const branchKeys = forkBranchKeys(loaded.graph, p.current_stage_key);
    const branches = branchKeys.map((k) => nodeByKey(loaded.graph, k)).filter((n) => n && n.roleId);
    if (!branches.length) continue;
    const joinGate = await c.query(`SELECT id FROM roles WHERE code = 'JOIN_GATE'`);
    const joinGateId = joinGate.rows[0]?.id ?? null;
    const card = parseDataCard(p);
    await c.query('BEGIN');
    try {
      const childIds = [];
      for (const b of branches) {
        const ins = await c.query(
          `INSERT INTO tasks (project_id, service_id, parent_task_id, title, description,
                              status, current_role_id, current_stage_key, created_by, data_card)
           VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8::uuid, 'fork', $9::jsonb)
           RETURNING id`,
          [p.project_id, p.service_id, p.id, `${p.title} [${b.name || 'ветка'}]`, p.description,
           b.status, b.roleId, b.stageKey, JSON.stringify(card)],
        );
        const childId = ins.rows[0].id;
        childIds.push(childId);
        await c.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
           ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
          [p.id, childId],
        );
      }
      // Паркуем родителя на парном join (барьер снимет advanceJoinNodes).
      await c.query(
        `UPDATE tasks SET status = 'WAITING_FOR_CHILDREN', current_role_id = $2,
                current_stage_key = $3::uuid, assigned_agent_id = NULL WHERE id = $1`,
        [p.id, joinGateId, p.join_key],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
        [p.id, p.status, p.current_role_id,
         JSON.stringify({ runner: true, reason: 'fork_spawned', children: childIds, branches: branchKeys })],
      );
      await c.query('COMMIT');
      forked += 1;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
  return forked;
}

/**
 * FORK-JOIN-001 (Phase 5) — узел join. Двухшаговый подметатель:
 *  (1) дочерняя задача, доехавшая до узла kind='join', завершается (ветка сдала
 *      результат) → DONE;
 *  (2) родитель в WAITING_FOR_CHILDREN на узле join, у которого ВСЕ дети
 *      терминальны: при упавшей ветке → BLOCKED; иначе слить data_card детей и
 *      продвинуть родителя за join по рёбрам (нет рёбер → DONE).
 * Идемпотентно (предикаты статуса + SKIP LOCKED). Только UPDATE, без DELETE.
 */
export async function advanceJoinNodes(c) {
  let advanced = 0;
  // (1) Дети на join → DONE. FORK-CHILD-001: WAITING_FOR_CHILDREN исключён — это
  // ребёнок, сам ставший fork-родителем и припаркованный на join; его завершает
  // шаг (2), когда его собственные ветки станут терминальными.
  const kids = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.parent_task_id IS NOT NULL
        AND t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN')
      FOR UPDATE OF t SKIP LOCKED`,
  );
  for (const k of kids.rows) {
    await c.query('BEGIN');
    try {
      const upd = await c.query(
        `UPDATE tasks SET status = 'DONE', current_role_id = NULL, assigned_agent_id = NULL
          WHERE id = $1 AND status NOT IN ('DONE','CANCELLED','FAILED')`,
        [k.id],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_DONE', $2::task_status, 'DONE', $3, $4::jsonb)`,
          [k.id, k.status, k.current_role_id, JSON.stringify({ runner: true, reason: 'branch_reached_join' })],
        );
        advanced += 1;
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }

  // (2) Fork-родители на join со всеми терминальными детьми → снять барьер.
  // FORK-CHILD-001: без фильтра parent_task_id — припаркованный на join может быть
  // и сервисным ребёнком эпика, ставшим fork-родителем своих веток.
  const parents = await c.query(
    `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id, t.current_stage_key, t.data_card
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.status = 'WAITING_FOR_CHILDREN'
        AND t.assigned_agent_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id)
        AND NOT EXISTS (
              SELECT 1 FROM tasks ch
               WHERE ch.parent_task_id = t.id AND ch.status NOT IN ('DONE','CANCELLED','FAILED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  for (const p of parents.rows) {
    const childRows = await c.query(
      `SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id = $1`,
      [p.id],
    );
    const failed = childRows.rows.some((ch) => ch.status === 'FAILED' || ch.status === 'CANCELLED');
    await c.query('BEGIN');
    try {
      if (failed) {
        // Политика all-DONE-required: упавшая ветка → родитель BLOCKED (всплывает пользователю).
        await c.query(
          `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1`,
          [p.id],
        );
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'STATUS_CHANGED', 'WAITING_FOR_CHILDREN', 'BLOCKED', $2, $3::jsonb)`,
          [p.id, p.current_role_id, JSON.stringify({ runner: true, reason: 'join_child_failed' })],
        );
        await c.query('COMMIT');
        advanced += 1;
        continue;
      }
      // Слить карточки детей в родителя (накопительная карточка).
      let merged = { ...parseDataCard(p) };
      for (const ch of childRows.rows) {
        merged = { ...merged, ...parseDataCard(ch) };
      }
      // DOC-COMMIT-ON-JOIN-001: агрегируем changedFiles детей (правки Doc Keeper лежат
      // на СОСЕДНЕЙ ветке — их нет в цепочке предков родителя, поэтому
      // resolveHostTaskContext их не видит) в ОБЪЕДИНЕНИЕ с дедупом и выносим их
      // ВЕРХНИМ уровнем в событие продвижения родителя. resolveHostTaskContext берёт
      // непустые changedFiles по событиям цепочки → пост-join Git Integrator (роль
      // узла ЗА join, работает на РОДИТЕЛЕ) увидит doc-пути и закоммитит их отдельным
      // коммитом. Пустой список (Doc Auditor→NO_CHANGES: доки не редактировались) →
      // поля в событии нет → пост-join Git Integrator упрётся в уже закоммиченный код
      // (nothing_to_stage), второго коммита не будет — поведение как сейчас.
      const childChanged = [];
      const seenChanged = new Set();
      for (const ch of childRows.rows) {
        const files = ch.data_card && Array.isArray(ch.data_card.changedFiles) ? ch.data_card.changedFiles : [];
        for (const f of files) {
          const key = String(f);
          if (!key || seenChanged.has(key)) continue;
          seenChanged.add(key);
          childChanged.push(f);
        }
      }
      // Продвинуть родителя за join по рёбрам графа.
      const loaded = await loadProjectGraph(c, p.project_id);
      const nextKey = loaded ? nextNodeKey(loaded.graph, p.current_stage_key, { outcome: 'FORWARD' }) : null;
      const nextNode = nextKey ? nodeByKey(loaded.graph, nextKey) : null;
      const done = !nextNode;
      const nextRoleId = nextNode?.roleId ?? null;
      const toStatus = done ? 'DONE' : (nextNode.status || p.status);
      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL,
                data_card = data_card || $5::jsonb WHERE id = $1`,
        [p.id, toStatus, nextRoleId, nextKey, JSON.stringify(merged)],
      );
      const joinPayload = { runner: true, reason: 'join_completed', nextStageKey: nextKey };
      if (childChanged.length) joinPayload.changedFiles = childChanged;
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, done ? 'TASK_DONE' : 'STATUS_CHANGED', toStatus, p.current_role_id,
         JSON.stringify(joinPayload)],
      );
      await c.query('COMMIT');
      advanced += 1;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
  return advanced;
}

// WORK-STACK-001 — advisory-lock промоутера очереди работ. Сериализует промоушен
// между параллельными раннерами, чтобы «нет активного PROMOTED на сервис» проверялось
// по зафиксированным строкам, а не в гонке (иначе два раннера завели бы двух детей на
// один сервис). Отдельный ключ от claim'а программиста (CLAUDE_CLAIM_LOCK_KEY).
const WORK_STACK_LOCK_KEY = 911_018;

/**
 * WORK-STACK-001 — промоутер+реконсайлер очереди работ (work_stack). Тикается в
 * advanceAutomatedTasks ПЕРЕД advanceDecompositionParents. Обе фазы идемпотентны и
 * выполняются в одной транзакции под advisory-локом (сериализация раннеров):
 *
 *  (1) reconcile: PROMOTED-элемент, чья дочерняя задача стала терминальной, переводится
 *      в зеркальный терминал (DONE | FAILED | CANCELLED). Это снимает замок сервиса и
 *      разрешает промоутнуть следующий PENDING-элемент того же сервиса тем же тиком.
 *      Источник истины по успеху/провалу — статус дочерней задачи (BLOCKED/FAILED→FAILED).
 *
 *  (2) promote: для каждого сервиса, у которого есть PENDING-элемент и НЕТ активного
 *      PROMOTED-элемента (замок сервиса) и НЕТ незавершённой дочерней задачи на этот
 *      сервис, берём PENDING с наименьшим seq и заводим дочернюю CODING-задачу
 *      (task_kind='service', created_by='work-stack', БЕЗ messageFingerprint — иммунна к
 *      дедупу), линкуем зависимостью к эпику, элемент → PROMOTED. Claim программиста
 *      (PROGRAMMER-WORKTREE-PER-SERVICE) дальше держит один активный CODING на сервис.
 *
 * Возвращает { reconciled, promoted }.
 */
export async function advanceWorkStack(c) {
  await c.query('BEGIN');
  try {
    await c.query('SELECT pg_advisory_xact_lock($1)', [WORK_STACK_LOCK_KEY]);

    // (1) Reconcile: промоутнутые элементы, чьи задачи терминальны. Идемпотентно —
    // guard status='PROMOTED'. BLOCKED дочерней задачи считаем провалом элемента.
    const rec = await c.query(
      `UPDATE work_stack w
          SET status = CASE t.status::text
                         WHEN 'DONE' THEN 'DONE'
                         WHEN 'CANCELLED' THEN 'CANCELLED'
                         ELSE 'FAILED' END,
              updated_at = now()
         FROM tasks t
        WHERE t.id = w.promoted_task_id
          AND w.status = 'PROMOTED'
          AND t.status IN ('DONE','CANCELLED','FAILED','BLOCKED')`,
    );
    const reconciled = rec.rowCount;

    // (2) Promote: по одному PENDING-элементу на каждый свободный сервис.
    const roleRow = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
    const programmerRoleId = roleRow.rows[0]?.id ?? null;
    const pending = await c.query(
      `SELECT DISTINCT ON (w.project_id, w.service_id)
              w.id, w.epic_task_id, w.project_id, w.service_id, w.title, w.description,
              w.data_card, w.target_status, w.target_role_id, w.target_stage_key
         FROM work_stack w
        WHERE w.status = 'PENDING'
          -- замок сервиса: нет активного промоутнутого элемента на этот сервис
          AND NOT EXISTS (
            SELECT 1 FROM work_stack w2
             WHERE w2.project_id = w.project_id AND w2.service_id = w.service_id
               AND w2.status = 'PROMOTED')
          -- страховка: нет незавершённой дочерней задачи эпика на этот сервис
          AND NOT EXISTS (
            SELECT 1 FROM tasks t2
             WHERE t2.project_id = w.project_id AND t2.service_id = w.service_id
               AND t2.parent_task_id = w.epic_task_id
               AND t2.status NOT IN ('DONE','CANCELLED','FAILED'))
        ORDER BY w.project_id, w.service_id, w.seq, w.created_at`,
    );
    let promoted = 0;
    for (const item of pending.rows) {
      const roleId = item.target_role_id ?? programmerRoleId;
      const child = await c.query(
        `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                            status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, 'service', $4, $5, $6::task_status, $7, $8, 'work-stack', $9::jsonb)
         RETURNING id`,
        [item.project_id, item.service_id, item.epic_task_id, item.title, item.description,
         item.target_status, roleId, item.target_stage_key,
         JSON.stringify(parseDataCard(item))],
      );
      const childId = child.rows[0].id;
      await c.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [item.epic_task_id, childId],
      );
      await c.query(
        `UPDATE work_stack SET status = 'PROMOTED', promoted_task_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [item.id, childId],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', $2::task_status, $3, $4::jsonb)`,
        [childId, item.target_status, roleId, JSON.stringify({
          runner: true, reason: 'work_stack_promote', epicTaskId: item.epic_task_id,
          workStackId: item.id, serviceId: item.service_id,
        })],
      );
      promoted += 1;
    }
    await c.query('COMMIT');
    return { reconciled, promoted };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

/**
 * DECOMP-CONTRACT-001 — роллап эпиков декомпозиции. Эпик (task_kind='epic') стоит в
 * WAITING_FOR_CHILDREN, пока его дети-декомпозиции не станут терминальными. Когда все
 * терминальны: если хоть один BLOCKED/FAILED → эпик BLOCKED; иначе → DONE. Линейный
 * аналог join-барьера (без графа fork/join). Идемпотентно, по одному txn на эпик,
 * FOR UPDATE SKIP LOCKED.
 *
 * NESTED-EPIC-ROLLUP-001: дети считаются `task_kind IN ('service','epic')`, а не только
 * 'service'. Остаток старой рекурсии расщепления ([[architect-split-recursion]]) оставил
 * эпики с ДЕТЬМИ-ЭПИКАМИ (эпик→эпик→сервис). Раньше роллап видел только service-детей,
 * поэтому эпик с эпиком-ребёнком не закрывался никогда (без service-детей — вечный WFC;
 * со смесью — сервис под эпиком-ребёнком «числился непокрытым» → вечный epic_missing_services).
 * Вложенный эпик несёт свой service_id и, завершившись, покрывает сервис и считается в
 * bad-подсчёте наравне с service-ребёнком. Каскад идёт снизу вверх по тикам.
 */
export async function advanceDecompositionParents(c) {
  const parents = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id, t.data_card
       FROM tasks t
      WHERE t.task_kind = 'epic'
        AND t.status = 'WAITING_FOR_CHILDREN'
        AND t.assigned_agent_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id AND ch.task_kind IN ('service','epic'))
        AND NOT EXISTS (
              SELECT 1 FROM tasks ch
               WHERE ch.parent_task_id = t.id AND ch.task_kind IN ('service','epic')
                 AND ch.status NOT IN ('DONE','CANCELLED','BLOCKED','FAILED'))
        -- WORK-STACK-001: не сворачивать эпик, пока в очереди работ есть незакрытые
        -- элементы (PENDING ещё не промоутнуты, PROMOTED ещё в работе) — иначе роллап
        -- закрыл бы эпик по части сервисов, не дождавшись остальных. Легаси-эпики без
        -- строк work_stack проходят гейт свободно (NOT EXISTS тривиально истинно).
        AND NOT EXISTS (
              SELECT 1 FROM work_stack w
               WHERE w.epic_task_id = t.id AND w.status IN ('PENDING','PROMOTED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  let advanced = 0;
  for (const p of parents.rows) {
    await c.query('BEGIN');
    try {
      const bad = await c.query(
        `SELECT count(*)::int AS n FROM tasks
          WHERE parent_task_id = $1 AND task_kind IN ('service','epic') AND status IN ('BLOCKED','FAILED')`,
        [p.id],
      );
      // JOIN-PLANNED-COVERAGE-001: сверяем ФАКТИЧЕСКИХ детей с целевым списком
      // сервисов Архитектора (data_card.planned_services). Когда капы/таймауты урезают
      // work_items, дети создаются не на все заявленные сервисы (B1: заявлены
      // WEBSTORE/Smeta/IAM/FastTable, дети только на WEBSTORE+IAM) — и DONE по одним лишь
      // имеющимся детям скрыл бы, что половина фронтов не сделана. Сервис считается
      // покрытым, если у него есть хотя бы один НЕ отменённый ребёнок task_kind='service'
      // (сверяем по коду сервиса, а не по числу детей). Недостача приоритетно понижает
      // DONE→BLOCKED с перечнем недостающих сервисов (возврат Архитектору).
      const dc = parseDataCard(p);
      const planned = jsonArray(dc.planned_services).map((x) => String(x).trim()).filter(Boolean);
      let missing = [];
      if (planned.length) {
        const cov = await c.query(
          `SELECT DISTINCT lower(s.service_code) AS code
             FROM tasks ch JOIN services s ON s.id = ch.service_id
            WHERE ch.parent_task_id = $1 AND ch.task_kind IN ('service','epic') AND ch.status <> 'CANCELLED'`,
          [p.id],
        );
        const covered = new Set(cov.rows.map((r) => r.code));
        missing = planned.filter((code) => !covered.has(code.toLowerCase()));
      }
      let toStatus = bad.rows[0].n > 0 ? 'BLOCKED' : 'DONE';
      if (toStatus === 'DONE' && missing.length) toStatus = 'BLOCKED';
      await c.query(
        `UPDATE tasks SET status = $2::task_status, assigned_agent_id = NULL
          WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'`,
        [p.id, toStatus],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, toStatus === 'DONE' ? 'TASK_DONE' : 'TASK_BLOCKED', toStatus, p.current_role_id,
         JSON.stringify({
           runner: true,
           reason: (missing.length && bad.rows[0].n === 0) ? 'epic_missing_services' : 'epic_rollup',
           servicesFailed: bad.rows[0].n,
           missingServices: missing,
         })],
      );
      await c.query('COMMIT');
      advanced += 1;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
  return advanced;
}

// Снять зависшие захваты: agent_run RUNNING старше таймаута → TIMEOUT, слот свободен.
async function resetStaleClaims(c) {
  // CLOCK-GUARD-001: до проверки таймаутов компенсируем возможный скачок настенных
  // часов БД/Docker-VM, иначе все прогоны «в полёте» разом гасятся ложным TIMEOUT.
  await reconcileClockSkew(c, { log: (m) => console.log(m) });
  await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, r.code AS role_code, t.status::text AS task_status,
              round(extract(epoch from (now() - ar.started_at)) * 1000)::bigint AS hung_ms
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.status = 'RUNNING'
          -- PROGRAMMER-UNIFY-001: у программиста более длинная сессия и свой
          -- (обычно больший) таймаут CLAUDE_ASSIGN_TIMEOUT_MS — его осиротевшие
          -- прогоны закрывает releaseStaleClaudeClaims, чтобы общий ROLE_TIMEOUT_MS
          -- не убивал реально идущую долгую сессию программиста раньше времени.
          AND COALESCE(r.code, '') <> 'PROGRAMMER'
          -- HOST-ORPHAN-TIMEOUT-001: host-роли (docker-сборка/коммит) реапятся по
          -- своему БОЛЬШЕМУ таймауту, иначе живой прогон срежется посреди build;
          -- остальные роли — по общему ROLE_TIMEOUT_MS.
          AND ar.started_at < now() - ((CASE WHEN COALESCE(r.code, '') = ANY($3::text[])
                                        THEN $2 ELSE $1 END)::bigint * interval '1 millisecond')
     ), done AS (
       UPDATE agent_runs
          SET status = 'TIMEOUT',
              finished_at = now(),
              error_text = 'role execution timed out before producing a structured result',
              output_json = jsonb_build_object('status', 'TIMEOUT', 'reason', 'role_timeout')
        WHERE id IN (SELECT id FROM stale)
        RETURNING task_id
     ), freed AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT s.task_id, 'STATUS_CHANGED', s.task_status::task_status, s.task_status::task_status, s.role_id,
            -- HOST-ORPHAN-TIMEOUT-001: для host-ролей — диагностируемое событие
            -- (кто=roleCode, почему=host_orphan_timeout, сколько висела=hungMs).
            CASE WHEN COALESCE(s.role_code, '') = ANY($3::text[])
                 THEN jsonb_build_object('runner', true, 'reason', 'host_orphan_timeout',
                        'runStatus', 'TIMEOUT', 'roleCode', s.role_code, 'hungMs', s.hung_ms)
                 ELSE jsonb_build_object('runner', true, 'reason', 'role_timeout', 'runStatus', 'TIMEOUT')
            END
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
    [ROLE_TIMEOUT_MS, HOST_TIMEOUT_MS, HOST_ROLE_CODES],
  );
  await releaseStaleClaudeClaims(c);
}

// Освободить осиротевшие задачи Claude/PROGRAMMER: статус CODING под ролью
// PROGRAMMER с назначенным агентом, у которых последнее AGENT_ASSIGNED старше
// timeoutMs. У такого назначения нет agent_run RUNNING, поэтому resetStaleClaims
// его не ловит. Снимаем assigned_agent_id (фидер переподаст задачу в свободный
// слот) и пишем диагностическое событие. Re-feed безопасен: фидер пишет только
// в пустой слот, а acceptScannerCompletion идемпотентен.
// BOOT-RECONCILE-GRACE-001: стартовая реконсиляция передаёт штатный
// CLAUDE_ASSIGN_TIMEOUT_MS (а не 0), т.к. Claude-агент переживает рестарт и
// досдаёт результат — освобождаем только назначения старше таймаута роли, иначе
// каждый деплой-рестарт убивал бы живую сессию Разработчика.
async function releaseStaleClaudeClaims(c, timeoutMs = CLAUDE_ASSIGN_TIMEOUT_MS, reason = 'claude_assignment_timeout') {
  const r = await c.query(
    `WITH stale AS (
       SELECT t.id, t.current_role_id, t.status
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
        WHERE r.code = 'PROGRAMMER'
          AND t.status = 'CODING'
          AND t.assigned_agent_id IS NOT NULL
          AND COALESCE(
                (SELECT max(te.created_at) FROM task_events te
                  WHERE te.task_id = t.id AND te.event_type = 'AGENT_ASSIGNED'),
                t.updated_at
              ) <= now() - ($1::bigint * interval '1 millisecond')
     ), released AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT id FROM stale)
        RETURNING id, current_role_id, status
     ), runs AS (
       -- PROGRAMMER-UNIFY-001: закрыть осиротевший RUNNING-прогон программиста
       -- (захват создал его, исполнитель умер, не сдав/не освободив) → TIMEOUT, иначе
       -- он висел бы вечно и искажал KPI. Data-modifying CTE выполняется всегда,
       -- даже без ссылки из основного запроса.
       UPDATE agent_runs SET status = 'TIMEOUT', finished_at = now(), outcome = $2::text,
              error_text = 'programmer claim orphaned (assignment timeout)'
        WHERE status = 'RUNNING' AND task_id IN (SELECT id FROM released)
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'STATUS_CHANGED', status, status, current_role_id,
            jsonb_build_object('runner', true, 'released', true, 'reason', $2::text)
       FROM released
     RETURNING task_id`,
    [Math.max(0, Number(timeoutMs) || 0), reason],
  );
  return r.rowCount;
}

// RUNNER-STARTUP-REAP-001 / RUNNER-RUNTIME-REAP-001: agent_run в статусе RUNNING,
// исполнитель которого умер, держит слот «N на роль» до таймаута resetStaleClaims.
// Два сценария осиротения:
//   1) Перезапуск процесса (ageCheck=false): горутина-исполнитель прошлого процесса
//      умерла вместе с ним — ЛЮБОЙ RUNNING заведомо осиротел, гасим безусловно.
//      Полный рестарт означает, что активных вызовов «в полёте» нет.
//   2) Рантайм (ageCheck=true): после рестарта БД/обрыва соединения (pgbouncer/
//      Patroni) LLM-вызов/финализацию прогона рвёт, и он повисает в RUNNING уже во
//      время работы процесса. Стартовая зачистка такие свежие сироты не ловит; до
//      этого фикса их освобождал только resetStaleClaims на таймауте (~30 минут в
//      проде), из-за чего очередь роли (max_concurrency_per_role) клинило. Здесь
//      гасим их на КАЖДОМ тике runner'а, но НЕ безусловно: только прогоны старше
//      RUNNER_ROLE_TIMEOUT_MS, иначе убьём реально идущий вызов. Перед проверкой
//      возраста компенсируем скачок настенных часов БД (reconcileClockSkew, как в
//      resetStaleClaims), чтобы прогоны «в полёте» не получили ложный TIMEOUT.
// В обоих случаях: agent_run → TIMEOUT, у нетерминальной задачи снимается
// assigned_agent_id (слот свободен), задача переигрывается штатно.
export async function reapOrphanRunningRuns(c, { ageCheck = false, boot = false, deployRef = null } = {}) {
  const reason = ageCheck ? 'orphan_run_timeout' : 'orchestrator_restart_reconcile';
  const errText = ageCheck
    ? 'RUNNING run exceeded role timeout without finishing (orphaned mid-run, e.g. DB connection drop); reaped as TIMEOUT'
    : 'orchestrator restarted while run was RUNNING; run was reaped as TIMEOUT';
  // В рантайме перед сравнением возраста компенсируем возможный скачок часов БД,
  // иначе все RUNNING разом окажутся «старше таймаута» и будут погашены ложно.
  if (ageCheck) {
    await reconcileClockSkew(c, { log: (m) => console.log(m) });
  }
  const params = [errText, reason];
  let agePredicate = '';
  // Стартовый reconcile (ageCheck=false) гасит ЛЮБОЙ RUNNING безусловно — причина
  // «рестарт», а не «зависание по таймауту», поэтому payload остаётся общим.
  let eventPayload = `jsonb_build_object('runner', true, 'reason', $2::text, 'runStatus', 'TIMEOUT')`;
  if (ageCheck) {
    // PROGRAMMER-UNIFY-001 + HOST-ORPHAN-TIMEOUT-001: ветвим возраст CASE'ом по роли —
    // у программиста легально бОльшая сессия (CLAUDE_ASSIGN_TIMEOUT_MS), у host-ролей
    // свой больший таймаут (HOST_TIMEOUT_MS: docker-сборка/коммит идут дольше общего
    // ROLE_TIMEOUT_MS), остальные роли — по общему. Иначе тикающий жнец гасит живой
    // прогон раньше времени и освобождает захват (инцидент 10-минутного среза).
    params.push(ROLE_TIMEOUT_MS, CLAUDE_ASSIGN_TIMEOUT_MS, HOST_TIMEOUT_MS, HOST_ROLE_CODES);
    // $3 общий (ROLE_TIMEOUT_MS), $4 программист, $5 host, $6 коды host-ролей.
    agePredicate = `AND ar.started_at < now() - ((CASE WHEN COALESCE(r.code, '') = 'PROGRAMMER' THEN $4
                      WHEN COALESCE(r.code, '') = ANY($6::text[]) THEN $5
                      ELSE $3 END)::bigint * interval '1 millisecond')`;
    // Для осиротевшей host-роли — диагностируемое событие host_orphan_timeout
    // (кто=roleCode, почему, сколько висела=hungMs).
    eventPayload = `CASE WHEN COALESCE(s.role_code, '') = ANY($6::text[])
                      THEN jsonb_build_object('runner', true, 'reason', 'host_orphan_timeout',
                             'runStatus', 'TIMEOUT', 'roleCode', s.role_code, 'hungMs', s.hung_ms)
                      ELSE jsonb_build_object('runner', true, 'reason', $2::text, 'runStatus', 'TIMEOUT') END`;
  }
  // BOOT-RECONCILE-GRACE-001 (требование 3): при стартовом (boot) реапе аннотируем
  // событие меткой bootReconcile + деплой-маркером (APP_CODE_VERSION). Рестарты от
  // собственного деплоя pipeline (docker compose up -d) так отличимы в диагностике
  // от рантайм-орфанов: || сливает объекты, добавляя поля к базовому payload.
  if (boot) {
    params.push(deployRef ?? null);
    eventPayload = `(${eventPayload}) || jsonb_build_object('bootReconcile', true, 'deployRef', $${params.length}::text)`;
  }
  const r = await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, r.code AS role_code, t.status::text AS task_status,
              round(extract(epoch from (now() - ar.started_at)) * 1000)::bigint AS hung_ms
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.status = 'RUNNING' ${agePredicate}
     ), done AS (
       UPDATE agent_runs
          SET status = 'TIMEOUT',
              finished_at = now(),
              error_text = $1::text,
              output_json = jsonb_build_object('status', 'TIMEOUT', 'reason', $2::text)
        WHERE id IN (SELECT id FROM stale)
        RETURNING task_id
     ), freed AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT s.task_id, 'STATUS_CHANGED', s.task_status::task_status, s.task_status::task_status, s.role_id,
            ${eventPayload}
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
    params,
  );
  return r.rowCount;
}

// ORPHAN-ROLE-REATTACH-001 — восстановить current_role_id у активных задач, потерявших
// роль (NULL) после массовой ручной операции. Такая задача невидима для claim (INNER
// JOIN roles по current_role_id) и зависает навсегда. Роль восстанавливаем из этапов
// проекта двумя путями: ГРАФ-режим (current_stage_key задан) → роль узла по stage_key;
// ЛИНЕЙНЫЙ режим (stage_key пуст) → роль ВКЛЮЧЁННОГО этапа с минимальной позицией, чей
// task_status = статусу задачи (вход в фазу). Терминальные/BLOCKED/ожидающие статусы не
// трогаем. Пишем диагностическое событие. Идемпотентно: чинит только задачи с NULL-ролью.
async function reattachOrphanStageRoles(c) {
  const r = await c.query(
    `WITH orphan AS (
       SELECT t.id, t.project_id, t.status::text AS status, t.current_stage_key
         FROM tasks t
        WHERE t.current_role_id IS NULL
          AND t.status NOT IN ('DONE','CANCELLED','FAILED','BACKLOG','WAITING_FOR_CHILDREN','BLOCKED')
     ), resolved AS (
       SELECT o.id, o.status,
              COALESCE(
                -- граф-режим: роль узла, на котором стоит задача (по current_stage_key)
                (SELECT psr.role_id FROM project_stages ps JOIN project_stage_roles psr ON psr.stage_id = ps.id
                  WHERE ps.project_id = o.project_id AND ps.enabled = true AND ps.stage_key = o.current_stage_key
                  ORDER BY ps.position LIMIT 1),
                -- линейный режим: роль этапа с минимальной позицией для статуса задачи
                (SELECT psr.role_id FROM project_stages ps JOIN project_stage_roles psr ON psr.stage_id = ps.id
                  WHERE ps.project_id = o.project_id AND ps.enabled = true AND ps.task_status::text = o.status
                  ORDER BY ps.position LIMIT 1)
              ) AS role_id
         FROM orphan o
     ), fixed AS (
       UPDATE tasks t SET current_role_id = r.role_id
         FROM resolved r
        WHERE t.id = r.id AND r.role_id IS NOT NULL
        RETURNING t.id, t.status::text AS status, t.current_role_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', status::task_status, status::task_status, current_role_id,
            jsonb_build_object('runner', true, 'reason', 'orphan_role_reattached')
       FROM fixed`,
  );
  return r.rowCount;
}

// ORPHAN-BLOCKED-OWNER-001 — старые BLOCKED-задачи могли потерять current_role_id
// при host/release ветках. BLOCKED не нужно авто-продвигать, но владелец роли нужен
// для UI, фильтров и ручного разбора. Берём последнюю достоверную роль из событий,
// иначе из agent_runs. Статус не меняем.
export async function reattachBlockedOwnerRoles(c) {
  const r = await c.query(
    `WITH orphan AS (
       SELECT t.id, t.status::text AS status
         FROM tasks t
        WHERE t.current_role_id IS NULL
          AND t.status = 'BLOCKED'
     ), resolved AS (
       SELECT o.id, o.status,
              COALESCE(
                (SELECT te.role_id FROM task_events te
                  WHERE te.task_id = o.id AND te.role_id IS NOT NULL
                  ORDER BY te.created_at DESC LIMIT 1),
                (SELECT ar.role_id FROM agent_runs ar
                  WHERE ar.task_id = o.id AND ar.role_id IS NOT NULL
                  ORDER BY ar.started_at DESC LIMIT 1)
              ) AS role_id
         FROM orphan o
     ), fixed AS (
       UPDATE tasks t SET current_role_id = r.role_id
         FROM resolved r
        WHERE t.id = r.id AND r.role_id IS NOT NULL
        RETURNING t.id, t.status::text AS status, t.current_role_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', status::task_status, status::task_status, current_role_id,
            jsonb_build_object('runner', true, 'reason', 'blocked_owner_role_reattached')
       FROM fixed`,
  );
  return r.rowCount;
}

// TASK-DUPLICATE-CLOSE-002 — уборка старых дублей, которые уже успели попасть в
// очередь до дедупа intake/split. Закрываем только безопасный класс: BLOCKED без
// активного назначения, с одинаковым project + service + messageFingerprint.
// WAITING_FOR_CHILDREN/RUNNING не трогаем, чтобы не сиротить дочерние ветки.
export async function closeBlockedDuplicateTasks(c) {
  const r = await c.query(
    `WITH active AS (
       SELECT t.id, t.project_id, t.service_id, t.status::text AS status,
              t.current_role_id, t.data_card, t.created_at,
              t.data_card->>'messageFingerprint' AS fp,
              first_value(t.id) OVER (
                PARTITION BY t.project_id, t.service_id, t.data_card->>'messageFingerprint'
                ORDER BY t.created_at, t.id
              ) AS original_id,
              count(*) OVER (
                PARTITION BY t.project_id, t.service_id, t.data_card->>'messageFingerprint'
              ) AS dup_count
         FROM tasks t
        WHERE t.status NOT IN ('DONE','CANCELLED','FAILED')
          AND COALESCE(t.data_card->>'messageFingerprint', '') <> ''
     ), victims AS (
       SELECT id, status, current_role_id, original_id
         FROM active
        WHERE dup_count > 1
          AND id <> original_id
          AND status = 'BLOCKED'
          AND NOT EXISTS (
            SELECT 1 FROM tasks tx WHERE tx.id = active.id AND tx.assigned_agent_id IS NOT NULL
          )
     ), fixed AS (
       UPDATE tasks t
          SET status = 'CANCELLED',
              assigned_agent_id = NULL,
              current_role_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb)
                || jsonb_build_object(
                     'duplicateOf', v.original_id,
                     'duplicateNote',
                     'Дубль живой задачи ' || v.original_id || ' (совпал fingerprint): закрыт автоматически'
                   )
         FROM victims v
        WHERE t.id = v.id
        RETURNING t.id, v.status AS from_status, v.current_role_id, v.original_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_CANCELLED', from_status::task_status, 'CANCELLED'::task_status, current_role_id,
            jsonb_build_object(
              'runner', true,
              'reason', 'duplicate_closed',
              'maintenance', 'blocked_duplicate_cleanup',
              'duplicateOf', original_id
            )
       FROM fixed`,
  );
  return r.rowCount;
}

// PROGRAMMER-RELEASE-BACKOFF-001 — предохранитель от вечной петли захвата одной
// задачи программистом. После K = maxFails ПОДРЯД неуспешных PROGRAMMER-прогонов
// (FAILED/TIMEOUT) ПОСЛЕ последнего SUCCESS уводим CODING-задачу из активного пула,
// чтобы она не молотила часами (cooldown лишь тормозит захват, но при бесконечных
// падениях сам по себе петлю не разрывает). Целевой статус — BLOCKED (на человека),
// а НЕ FAILURE_ANALYSIS: инцидентные падения инфраструктурные (агент падает за ~5с,
// кода нет — анализировать нечего), а FAILURE_ANALYST на задаче без реального провала
// пайплайна мгновенно проматывается обратно в CODING (maybeSkipFailureAnalyst,
// last_pipeline != 'FAILED') → тот же тик снова эскалировали бы → тесная петля через
// FAILURE_ANALYSIS. BLOCKED терминально выводит задачу из CODING (её не клеймит ни
// claim, ни свиперы), человек разбирается с корневой причиной. Требование допускает
// оба варианта ("FAILURE_ANALYSIS или BLOCKED с причиной programmer_release_loop"),
// архитектор оставил выбор реализации — выбран BLOCKED как надёжно разрывающий петлю.
// Успешная сдача обнуляет N сама (SUCCESS сдвигает окно счёта) → до K задача не
// доходит на здоровом пути. Один свипер, тикает в преамбуле advanceAutomatedTasks
// рядом с blockExhaustedFailureAnalysis — независимо от фидера.
export async function escalateProgrammerReleaseLoop(c, maxFails = PROGRAMMER_RELEASE_LOOP_MAX) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, cd.n_fail
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_fail
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('FAILED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status = 'CODING'
          AND t.assigned_agent_id IS NULL
          AND r.code = 'PROGRAMMER'
          AND cd.n_fail >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status = 'CODING'
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.n_fail
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'STATUS_CHANGED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'programmer_release_loop', 'failedRuns', b.n_fail)
       FROM blocked b`,
    [Math.max(1, Number(maxFails) || 1)],
  );
  return r.rowCount;
}

// ARCHITECT-BUDGET-LOOP-001 — диагностика мега-эпика, который Архитектор НЕ успевает
// продумать за один прогон. Мега-эпик (раскатка на N сервисов/фронтов с пофайловыми
// инструкциями) упирается в reasoning-таймаут раннера БЕЗ вердикта: прогон отменяется
// (CANCELLED через release-reasoning-task) либо гасится жнецом (TIMEOUT), задача
// переигрывается — и так по кругу, а без диагноза уходит в молчаливый BLOCKED. Здесь:
// после K = maxCancels ПОДРЯД отменённых/просроченных прогонов Архитектора (после
// последнего SUCCESS) уводим ARCHITECTURE-задачу в BLOCKED, но С ВНЯТНОЙ ПРИЧИНОЙ —
// кладём её и в data_card задачи (видно в карточке), и в TASK_BLOCKED-событие. Причина
// подсказывает действие: разбить эпик на пакеты 4–5 сервисов или увеличить бюджет.
// Успешный прогон обнуляет счётчик (окно считается после последнего SUCCESS), поэтому
// на здоровом пути порог не достигается. Один свипер в преамбуле advanceAutomatedTasks
// рядом с escalateProgrammerReleaseLoop — независимо от раннера/движка.
export async function escalateArchitectBudgetLoop(c, maxCancels = ARCHITECT_BUDGET_LOOP_MAX, reason = ARCHITECT_BUDGET_BLOCK_REASON) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, cd.n_cancel
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_cancel
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('CANCELLED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status = 'ARCHITECTURE'
          AND t.assigned_agent_id IS NULL
          AND r.code = 'ARCHITECT'
          AND cd.n_cancel >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb) || jsonb_build_object(
                'architect_budget_block',
                jsonb_build_object('reason', $2::text, 'cancelledRuns', lt.n_cancel))
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status = 'ARCHITECTURE'
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.n_cancel
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'TASK_BLOCKED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'architect_budget_exhausted',
              'cancelledRuns', b.n_cancel, 'detail', $2::text)
       FROM blocked b`,
    [Math.max(1, Number(maxCancels) || 1), reason],
  );
  return r.rowCount;
}

// TASK-RUN-LOOP-CAP-001 — общий предохранитель от бесконечных перезапусков ЛЮБОГО
// этапа. Прогон, оборванный без вердикта (CANCELLED через release, TIMEOUT от
// жнеца), возвращает задачу в очередь — и без порога она перезапускается по кругу,
// жжёт токены, а в UI этап выглядит как «не оставил структурированного результата».
// После K = maxCancels ПОДРЯД безрезультатных прогонов текущей роли (окно — после
// последнего SUCCESS этой роли) задача уводится в BLOCKED с внятной причиной в
// data_card (auto_run_limit — видно в карточке) и TASK_BLOCKED-событии: дальше —
// пуск руками (разобраться и переместить задачу на этап через move). Узкие жнецы
// (Архитектор — ARCHITECT_BUDGET_LOOP_MAX=3, аналитик, программист) срабатывают
// раньше со своими порогами/диагнозами; этот — страховка для всех остальных ролей.
export async function escalateRunawayRoleLoops(c, maxCancels = TASK_RUN_LOOP_MAX, reason = TASK_RUN_LOOP_BLOCK_REASON) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, r.code AS role_code, cd.n_cancel
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_cancel
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('CANCELLED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status NOT IN ('DONE','CANCELLED','FAILED','BLOCKED','WAITING_FOR_CHILDREN')
          AND t.assigned_agent_id IS NULL
          AND cd.n_cancel >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb) || jsonb_build_object(
                'auto_run_limit',
                jsonb_build_object('reason', $2::text, 'cancelledRuns', lt.n_cancel, 'role', lt.role_code))
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status NOT IN ('DONE','CANCELLED','FAILED','BLOCKED')
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.role_code, lt.n_cancel
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'TASK_BLOCKED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'run_budget_exhausted',
              'role', b.role_code, 'cancelledRuns', b.n_cancel, 'detail', $2::text)
       FROM blocked b`,
    [Math.max(1, Number(maxCancels) || 1), reason],
  );
  return r.rowCount;
}

// TESTS-GREEN-SKIP-FA-001 (fix B) — увести в BLOCKED задачи, застрявшие в анализе
// сбоя на реальном провале тестов после исчерпания попыток. Считаем таймауты/провалы
// прогонов аналитика как rework-попытки: при >= maxAttempts безрезультатных прогонов
// (и при последнем pipeline_run = FAILED) задача блокируется на человека, а не крутится
// в FAILURE_ANALYSIS бесконечно. Зелёные задачи здесь не трогаем — их продвигает
// вперёд maybeSkipFailureAnalyst (поэтому условие явно требует last_pipeline = 'FAILED').
async function blockExhaustedFailureAnalysis(c, maxAttempts = MAX_REWORK) {
  const r = await c.query(
    `WITH fa AS (
       SELECT t.id, t.status::text AS status, t.current_role_id,
              (SELECT pr.status::text FROM pipeline_runs pr WHERE pr.task_id = t.id
                ORDER BY pr.finished_at DESC NULLS LAST, pr.started_at DESC LIMIT 1) AS last_pipeline,
              (SELECT count(*) FROM agent_runs ar
                WHERE ar.task_id = t.id AND ar.role_id = t.current_role_id
                  AND ar.status IN ('TIMEOUT','FAILED')) AS bad_runs
         FROM tasks t JOIN roles r ON r.id = t.current_role_id
        WHERE t.status = 'FAILURE_ANALYSIS' AND t.assigned_agent_id IS NULL AND r.code = 'FAILURE_ANALYST'
     ), exhausted AS (
       SELECT id, status, current_role_id FROM fa
        WHERE last_pipeline = 'FAILED' AND bad_runs >= $1
     ), blocked AS (
       UPDATE tasks SET status = 'BLOCKED'
        WHERE id IN (SELECT id FROM exhausted) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT e.id, 'STATUS_CHANGED', e.status::task_status, 'BLOCKED', e.current_role_id,
            jsonb_build_object('runner', true, 'reason', 'failure_analysis_exhausted')
       FROM exhausted e
      WHERE e.id IN (SELECT id FROM blocked)`,
    [Math.max(1, Number(maxAttempts) || 1)],
  );
  return r.rowCount;
}

// DOC-BRANCH-LIVENESS-001 — живучесть документационной fork-ветви. Документация
// (Documentation Auditor/Keeper) идёт ПАРАЛЛЕЛЬНО коммиту через fork/join и вправе
// выполняться дольше. Но если её этап реально «мёртв» — задача-ветвь ушла в
// BLOCKED/FAILED, либо накопила >= maxAttempts безрезультатных прогонов
// (TIMEOUT/FAILED) под текущей документационной ролью — она НЕ должна вечно держать
// парный join, заклинивая родителя в WAITING_FOR_CHILDREN. Продвигаем такого
// документационного ребёнка на ОДИН узел вперёд по графу ветки: к следующей
// документационной роли (честная попытка), а в конце ветки — на join-узел, откуда
// advanceJoinNodes завершит ветку (DONE) и снимет барьер родителя. A1 (roleEngine)
// закрывает «здоровый» путь (BLOCKED-вердикт → forward сразу); этот подметатель —
// сеть безопасности для таймаутов/сбоев вызова ИИ и осиротевших после ручных операций.
export async function advanceStuckDocumentationBranches(c, maxAttempts = MAX_REWORK, maxAgeMs = DOC_BRANCH_MAX_AGE_MS) {
  const DOC_ROLES = ['DOCUMENTATION_AUDITOR', 'DOCUMENTATION_KEEPER'];
  const stuck = await c.query(
    `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id,
            t.current_stage_key, r.code AS role_code,
            (SELECT count(*) FROM agent_runs ar
              WHERE ar.task_id = t.id AND ar.role_id = t.current_role_id
                AND ar.status IN ('TIMEOUT','FAILED'))::int AS bad_runs,
            (extract(epoch from (now() - t.updated_at)) * 1000)::bigint AS age_ms
       FROM tasks t JOIN roles r ON r.id = t.current_role_id
      WHERE t.assigned_agent_id IS NULL
        AND t.parent_task_id IS NOT NULL
        AND r.code = ANY($1::text[])
        AND t.status NOT IN ('DONE','CANCELLED')`,
    [DOC_ROLES],
  );
  const limit = Math.max(1, Number(maxAttempts) || 1);
  const ageLimit = Math.max(60_000, Number(maxAgeMs) || 0);
  let moved = 0;
  for (const t of stuck.rows) {
    // Ветвь считается «мёртвой» и продвигается к join, если: она в терминальном для
    // ветки состоянии (BLOCKED/FAILED); ИЛИ исчерпала попытки (bad_runs); ИЛИ просто
    // висит дольше ageLimit без продвижения (движок документации не создаёт прогонов —
    // напр. codex-драйвер завис: bad_runs=0, но родитель не должен ждать вечно).
    const exhausted =
      t.status === 'BLOCKED' || t.status === 'FAILED' ||
      Number(t.bad_runs) >= limit || Number(t.age_ms) >= ageLimit;
    if (!exhausted) continue;
    const loaded = await loadProjectGraph(c, t.project_id);
    if (!loaded) continue; // линейный проект — здесь fork-ветвей нет
    // Восстановить узел ветки, если stage_key потерян (осиротел после ручных операций):
    // узел с этой ролью (предпочтительно совпадающий по статусу).
    let stageKey = t.current_stage_key;
    if (!stageKey) {
      const byRoleAndStatus = loaded.nodes.find(
        (n) => n.roleId === t.current_role_id && n.status === t.status,
      );
      stageKey = (byRoleAndStatus ?? loaded.nodes.find((n) => n.roleId === t.current_role_id))?.stageKey ?? null;
    }
    if (!stageKey) continue;
    const claimedLike = {
      id: t.id, project_id: t.project_id, current_stage_key: stageKey,
      role_code: t.role_code, status: t.status,
    };
    const resolved = await resolveGraphTransition(c, claimedLike, {
      outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason: 'documentation_exhausted',
    });
    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);
    await c.query('BEGIN');
    try {
      const upd = await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL
          WHERE id = $1 AND assigned_agent_id IS NULL AND status NOT IN ('DONE','CANCELLED')`,
        [t.id, resolved.toStatus, nextRoleId, resolved.nextStageKey ?? null],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
          [t.id, resolved.done ? 'TASK_DONE' : 'STATUS_CHANGED', t.status, resolved.toStatus, t.current_role_id,
           JSON.stringify({
             runner: true, reason: 'documentation_branch_advanced',
             from: t.role_code, badRuns: t.bad_runs, ageMs: Number(t.age_ms),
             trigger: (t.status === 'BLOCKED' || t.status === 'FAILED') ? t.status
               : (Number(t.bad_runs) >= limit ? 'bad_runs' : 'age'),
             nextRole: resolved.nextRole,
           })],
        );
        moved += 1;
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
  return moved;
}

/**
 * Стартовая реконсиляция (вызывается один раз при запуске оркестратора).
 *
 * BOOT-RECONCILE-GRACE-001. Прежняя реализация исходила из того, что при полном
 * перезапуске активных сессий в полёте нет, и гасила ВСЕ RUNNING безусловно
 * (reapOrphanRunningRuns без ageCheck) + освобождала ВСЕ Programmer-назначения
 * немедленно (timeoutMs=0). Но деплой-стадия pipeline сама пересоздаёт контейнер
 * оркестратора (docker compose up -d), а живые host-runner'ы и Claude-агенты
 * переживают рестарт и досдают результат — значит каждый прогон pipeline убивал
 * чужие живые прогоны (ложный TIMEOUT, искажённый KPI роли).
 *
 * Теперь щадящий boot-reconcile: гасим ТОЛЬКО прогоны старше штатного таймаута
 * своей роли (ageCheck=true → CASE по роли: PROGRAMMER/host свои таймауты). Более
 * молодые RUNNING остаются «осиротевшими кандидатами» — их досдаст переживший
 * рестарт исполнитель, либо добьёт штатный жнец на тике (reapOrphanRunningRuns
 * ageCheck=true) / released-backoff по истечении таймаута (без задвоения — тот же
 * возрастной предикат). boot=true метит событие деплой-маркером (требование 3).
 * Programmer-назначения тоже освобождаем только по штатному таймауту
 * (CLAUDE_ASSIGN_TIMEOUT_MS), а не немедленно.
 *
 * Возвращает число освобождённых Programmer-задач.
 */
export async function reconcileOnStartupTx(c, { deployRef = null } = {}) {
  await reapOrphanRunningRuns(c, { ageCheck: true, boot: true, deployRef });
  return releaseStaleClaudeClaims(c, CLAUDE_ASSIGN_TIMEOUT_MS, 'orchestrator_restart_reconcile');
}

export async function reconcileOnStartup(s, { deployRef = process.env.APP_CODE_VERSION ?? null } = {}) {
  return withClient(clientConfig(s), (c) => reconcileOnStartupTx(c, { deployRef }));
}

// Захватить одну задачу под ИИ-ролью. Возвращает контекст захвата или null.
// PIPELINE-DYNAMIC-ROUTE-001: статус, в котором роль легитимно владеет задачей,
// берём из этапов проекта (project_stages.task_status у включённого этапа с этой
// ролью). Если у проекта нет настроенного маршрута — канонический фолбэк по
// LLM_FLOW_PAIRS (ROLE_FLOW.from). Проекты на паузе (status='paused') пропускаем.
async function claimLlmRoleTask(c, roleCode = null) {
  // Пары канонического фолбэка начинаются с $2 ($1 = массив кодов ИИ-ролей).
  const valuesSql = LLM_FLOW_PAIRS.map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::text)`).join(', ');
  const params = [LLM_ROLE_CODES, ...LLM_FLOW_PAIRS.flatMap((p) => [p.code, p.status])];
  // RUNNER-CONCURRENCY-001: при параллельной обработке claim сужают до одной роли,
  // чтобы соблюсти лимит «N горутин на роль» — каждый воркер берёт задачу своей роли.
  let roleFilter = '';
  if (roleCode) {
    params.push(roleCode);
    roleFilter = `AND r.code = $${params.length}`;
  }
  await c.query('BEGIN');
  try {
    const picked = await c.query(
      `SELECT t.id, t.title, t.description, t.status::text AS status, t.project_id,
              t.data_card, t.current_stage_key, t.parent_task_id, r.code AS role_code, r.id AS role_id
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assigned_agent_id IS NULL
          AND r.hidden = false
          AND (p.id IS NULL OR p.status <> 'paused')
          AND r.code = ANY($1::text[])
          ${roleFilter}
          AND (
            (t.project_id IS NOT NULL AND (
              EXISTS (
                SELECT 1 FROM project_stages ps
                  JOIN project_stage_roles psr ON psr.stage_id = ps.id
                 WHERE ps.project_id = t.project_id AND ps.enabled = true
                   AND psr.role_id = r.id AND ps.task_status::text = t.status::text
                   AND (t.current_stage_key IS NULL OR ps.stage_key = t.current_stage_key)
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM project_stages ps2
                   WHERE ps2.project_id = t.project_id AND ps2.enabled = true AND ps2.task_status IS NOT NULL
                )
                AND (r.code, t.status::text) IN (VALUES ${valuesSql})
              )
              -- TASK-RESTART-001: перезапущенные задачи Приёмщик забирает БЕЗУСЛОВНО,
              -- даже если у проекта нет этапа с маппингом на этот статус (иначе после
              -- ручного перезапуска они бы снова зависли, как BACKLOG при входе READY).
              OR (r.code = 'TASK_INTAKE_OFFICER' AND t.status::text = 'RESTART')
            ))
            -- INTAKE-INTEGRATIONS-001: беспроектное обращение из канала «интеграции в
            -- приложения» — Приёмщик забирает его СРАЗУ в BACKLOG. Без этой ветки
            -- INNER JOIN projects скрывал бы задачу без проекта, и обращение зависло бы.
            OR (t.project_id IS NULL AND r.code = 'TASK_INTAKE_OFFICER' AND t.status::text = 'BACKLOG')
          )
        ORDER BY t.priority ASC, t.created_at ASC
        FOR UPDATE OF t SKIP LOCKED
        LIMIT 1`,
      params,
    );
    if (!picked.rowCount) {
      await c.query('COMMIT');
      return null;
    }
    const task = picked.rows[0];
    const agent = await c.query('SELECT id FROM agents WHERE role_id = $1 ORDER BY created_at LIMIT 1', [task.role_id]);
    const agentId = agent.rows[0]?.id ?? null;
    if (!agentId) {
      // Без агента нельзя записать agent_run — не зацикливаемся на этой задаче.
      await c.query('ROLLBACK');
      return null;
    }
    await c.query('UPDATE tasks SET assigned_agent_id = $2 WHERE id = $1', [task.id, agentId]);
    // ROLE-ENGINE-ROUTING-002: снимок фактического движка роли (connector/provider/
    // model/driver) на момент захвата — источник истины для дневной агрегации по
    // моделям, устойчивый к последующему переименованию/удалению коннектора.
    const snap = await resolveConnectorSnapshot(c, task.role_code);
    const run = await c.query(
      `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json,
         snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
       VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8) RETURNING id`,
      [task.id, agentId, task.role_id, JSON.stringify({ roleCode: task.role_code, status: task.status }),
        snap.connectorId, snap.provider, snap.model, snap.driverType],
    );
    // VERSION-KPI-TRACKING-001: штампуем версию промта роли в момент захвата (а не
    // сдачи) — именно эта версия исполняется, даже если промт поправят в полёте.
    const { getActivePromptVersion } = await import('./roles.js');
    const promptVersion = await getActivePromptVersion(c, task.role_code);
    if (promptVersion != null) {
      await c.query('UPDATE agent_runs SET prompt_version = $2 WHERE id = $1', [run.rows[0].id, promptVersion]);
    }
    const rc = await c.query(
      `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND from_status = 'FAILURE_ANALYSIS'`,
      [task.id],
    );
    await c.query('COMMIT');
    return { ...task, agentId, agentRunId: run.rows[0].id, reworkCount: rc.rows[0].n };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Прошлые успешные выводы ролей по задаче (для проброса по цепочке) + последнее
// ревью. Позволяет DECOMPOSER видеть решение ARCHITECT, FAILURE_ANALYST — ревью,
// Programmer — проект и разбивку. Общий источник для роли и для Claude-моста.
export async function fetchPriorOutputs(c, taskId) {
  // PIPELINE-PRIOR-DEDUP-001: при Dynamic Workflow (REWORK/BRANCH к Failure
  // Analyst/RESTART/доработка через moveTask) задача проходит роли многократно,
  // и каждый SUCCESS-прогон копится в agent_runs. Следующей роли по маршруту
  // нужен только ПОСЛЕДНИЙ вывод каждой предшественницы, а не вся портянка её
  // попыток (замер по живой БД: до 182 SUCCESS-прогонов одной роли → ~106K
  // символов, ~25-30K токенов в каждом вызове модели). DISTINCT ON (r.code) с
  // ORDER BY r.code, started_at DESC оставляет последний прогон каждой роли;
  // внешний ORDER BY по started_at восстанавливает хронологию ролей (читаемость
  // промпта). Ср. programmer-runner/src/promptBuilder.js ("Keep the latest output
  // per role"). История agent_runs/prompt_exchanges НЕ трогается — это только
  // выборка контекста; форма строк и контракт summarizePriorRuns(runs.rows) те же.
  const runs = await c.query(
    `SELECT latest.role_code, latest.status, latest.output_json
       FROM (
         SELECT DISTINCT ON (r.code)
                r.code AS role_code, ar.status::text AS status, ar.output_json, ar.started_at
           FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
          WHERE ar.task_id = $1 AND ar.status = 'SUCCESS' AND ar.output_json IS NOT NULL
          ORDER BY r.code, ar.started_at DESC
       ) latest
      ORDER BY latest.started_at`,
    [taskId],
  );
  const review = await c.query(
    `SELECT status::text AS status, review_text FROM reviews WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  return {
    priorRoleOutputs: summarizePriorRuns(runs.rows),
    lastReview: review.rows[0] ? { status: review.rows[0].status, text: review.rows[0].review_text } : null,
  };
}

// FA-MISSING-ARTIFACT-001 — сжать output_json ПРОВАЛЬНОГО прогона host-роли
// (PIPELINE_SERVICE/GIT_INTEGRATOR) в компактный артефакт для контекста Аналитика
// сбоя. Без этого артефакта FA «не видит» причину падения (нет упавшей команды,
// кода возврата, строк лога) и раунд за раундом просит «реальный лог», хотя причина
// уже лежит в БД (инцидент 1c3967ab/1ff73c5a: pipeline_compose_not_found).
// Чистая функция (форма output известна из pipeline-runner/host-runner). Толерантна
// к форме `error`: объект {code,message,logTail} ЛИБО строка (GIT_INTEGRATOR:
// output.error='commit failed: …'); и к месту `error`: верхний уровень (инцидент)
// ЛИБО summary.error (pipeline-runner). Ошибка ДО запуска команд (compose-not-found)
// → error.message несёт причину, logTail/failedCommand пустые (это норма, не потеря).
export function summarizeFailureArtifact(roleCode, output) {
  const clip = (v, max) => {
    if (v == null) return null;
    const s = String(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const o = output && typeof output === 'object' && !Array.isArray(output) ? output : {};
  const summary = o.summary && typeof o.summary === 'object' && !Array.isArray(o.summary) ? o.summary : {};
  const rawErr = o.error ?? summary.error ?? null;
  let errorCode = null;
  let errorMessage = null;
  let logTail = '';
  if (rawErr && typeof rawErr === 'object' && !Array.isArray(rawErr)) {
    errorCode = clip(rawErr.code, 200);
    errorMessage = clip(rawErr.message, 2000);
    if (typeof rawErr.logTail === 'string') logTail = rawErr.logTail;
  } else if (typeof rawErr === 'string') {
    errorMessage = clip(rawErr, 2000);
  }
  const failedStage = o.failedStage ?? summary.failedStage ?? null;
  // Упавшая команда с exit code — из summary.actions (если команды вообще стартовали).
  const actions = Array.isArray(summary.actions) ? summary.actions : [];
  const failedAction = actions.find((a) => a && typeof a === 'object'
    && a.status && a.status !== 'success' && a.status !== 'SKIPPED') ?? null;
  const failedCommand = failedAction && failedAction.command
    ? { command: clip(failedAction.command, 500), exitCode: failedAction.exitCode ?? null }
    : null;
  // Хвост лога: из error.logTail (уже усечён pipeline-runner), иначе — из logFragment
  // упавшей команды. При ошибке ДО команд остаётся пустым (причина — в errorMessage).
  if (!logTail && failedAction && typeof failedAction.logFragment === 'string') {
    logTail = failedAction.logFragment;
  }
  const note = typeof o.note === 'string' ? o.note
    : (typeof summary.note === 'string' ? summary.note : null);
  return {
    role: roleCode,
    status: 'FAILED',
    failedStage: failedStage ?? null,
    errorCode,
    errorMessage,
    failedCommand,
    logTail: clip(logTail, 4000) ?? '',
    logPath: o.logPath ?? summary.logPath ?? null,
    runId: summary.runId ?? o.runId ?? null,
    // GIT_INTEGRATOR и пр.: пометка исхода (no_changed_files/nothing_to_stage).
    note: note != null ? clip(note, 500) : null,
  };
}

// HOST-FAILURE-TEXT-001 — предел длины error_text host-роли. 500 символов хватает
// на код причины + сообщение; кап защищает agent_runs от раздувания длинным
// error.message (тот же принцип, что RELEASE_TEXT_MAX для release-reason).
const HOST_FAILURE_TEXT_MAX = 500;

// HOST-FAILURE-TEXT-001 — роль-агностичный текст причины падения host-роли для
// agent_runs.error_text. Переиспользует summarizeFailureArtifact (единый разбор
// output → errorCode/failedStage/errorMessage/note), чтобы формат кода причины был
// ОБЩИМ с веткой GIT_INTEGRATOR (ORCH-GI-BLOCKED-OWNER-001 переиспользует этот же
// helper). Формат строки:
//   <errorCode|failedStage|<role>_failed>: <errorMessage|note|'no structured detail'>
// Гарантированно НЕПУСТАЯ строка (монитор показывает причину, а не пустоту),
// усечённая до предела error_text.
export function deriveHostFailureText(roleCode, output) {
  const role = String(roleCode ?? '').trim() || 'host_role';
  const artifact = summarizeFailureArtifact(role, output);
  const nonEmpty = (v) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s : null;
  };
  const code = nonEmpty(artifact.errorCode)
    ?? nonEmpty(artifact.failedStage)
    ?? `${role.toLowerCase()}_failed`;
  const detail = nonEmpty(artifact.errorMessage)
    ?? nonEmpty(artifact.note)
    ?? 'no structured detail';
  const text = `${code}: ${detail}`;
  return text.length > HOST_FAILURE_TEXT_MAX ? text.slice(0, HOST_FAILURE_TEXT_MAX) : text;
}

// FA-MISSING-ARTIFACT-001 — артефакт ПОСЛЕДНЕГО провального прогона host-роли задачи
// для контекста Аналитика сбоя. Источник — agent_runs.output_json упавшего прогона
// (status='FAILED'), который completeHostTaskTx уже пишет целиком; тот же output
// лежит и в payload события STATUS_CHANGED→FAILURE_ANALYSIS — берём из agent_runs как
// единственной строки на прогон. Возвращает null, если провальных прогонов нет.
export async function fetchFailureArtifact(c, taskId) {
  const r = await c.query(
    `SELECT r.code AS role_code, ar.output_json
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND ar.status = 'FAILED'
        AND r.code IN ('PIPELINE_SERVICE', 'GIT_INTEGRATOR')
        AND ar.output_json IS NOT NULL
      ORDER BY ar.started_at DESC LIMIT 1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return summarizeFailureArtifact(row.role_code, row.output_json);
}

// FA-MISSING-ARTIFACT-001 — жаловался ли ПРЕДЫДУЩИЙ прогон Аналитика сбоя на
// отсутствие артефакта провала? Читаем output_json последнего завершённого прогона
// FAILURE_ANALYST (кроме текущего, ещё RUNNING) и прогоняем через
// isMissingArtifactComplaint. Нужен анти-петле decideOutcome: две жалобы подряд по
// одному провалу → BLOCKED сразу (missing_artifact), а не ещё круг вхолостую.
async function priorFailureAnalystMissedArtifact(c, taskId, excludeRunId) {
  const r = await c.query(
    `SELECT ar.output_json
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND r.code = 'FAILURE_ANALYST'
        AND ar.output_json IS NOT NULL AND ($2::uuid IS NULL OR ar.id <> $2)
      ORDER BY ar.started_at DESC LIMIT 1`,
    [taskId, excludeRunId ?? null],
  );
  const o = r.rows[0]?.output_json;
  if (!o || typeof o !== 'object') return false;
  return isMissingArtifactComplaint({ summary: o.summary, findings: o.findings });
}

// MISSING-OUTPUTS-CAP-001 — сколько ПОДРЯД последних завершённых прогонов этой роли
// по задаче кончились недобором обязательных выходных полей (reason missing_outputs:*).
// Нужен капу в applyReasoningVerdict: REWORK от missing_outputs назначается ПОСЛЕ
// decideOutcome, мимо его защиты max_rework_exceeded, и никаким счётчиком не покрыт:
// кап провалов считает FAILED-прогоны (а эти SUCCESS), reworkCount — только возвраты
// с FAILURE_ANALYSIS. Для ПЕРВОЙ роли маршрута REWORK ведёт в неё же саму
// (reworkTarget → firstStep) — без капа это вечная петля. Инцидент: Приёмщик с
// легитимно пустым required-списком (см. миграцию 0050) крутился BACKLOG→BACKLOG
// прогоном LLM каждые ~40 секунд.
async function priorMissingOutputsStreak(c, taskId, roleCode, excludeRunId, limit) {
  if (limit <= 0) return 0;
  const r = await c.query(
    `SELECT ar.output_json->>'reason' AS reason
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND r.code = $2 AND ar.finished_at IS NOT NULL
        AND ($3::uuid IS NULL OR ar.id <> $3)
      ORDER BY ar.started_at DESC LIMIT $4`,
    [taskId, roleCode, excludeRunId ?? null, limit],
  );
  let n = 0;
  for (const row of r.rows) {
    if (String(row.reason ?? '').startsWith('missing_outputs')) n += 1;
    else break;
  }
  return n;
}

// INTAKE-INTEGRATIONS-001 / INTAKE-CATEGORY-VALIDATION-001 — собрать компактный блок
// обращения (intakeReport) для контекста роли. Чистая функция (без БД). Блок
// формируется ТОЛЬКО для задач-обращений (isIntakeTask, т.е. intake_integration_id
// IS NOT NULL) и ТОЛЬКО под ролью Приёмщика (TASK_INTAKE_OFFICER) — иначе null.
// Размер капим, чтобы не раздувать вход роли: jsErrors — первые 10 строк, каждая
// с капом длины; url/userAgent/screenshotUrl тоже обрезаем по длине.
export function buildIntakeReportContext(dataCard, { roleCode, isIntakeTask } = {}) {
  if (!isIntakeTask || roleCode !== 'TASK_INTAKE_OFFICER') return null;
  const card = dataCard && typeof dataCard === 'object' && !Array.isArray(dataCard) ? dataCard : {};
  const clip = (v, max) => {
    const s = v == null ? null : String(v);
    if (s == null) return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const ac = card.autocontext && typeof card.autocontext === 'object' && !Array.isArray(card.autocontext)
    ? card.autocontext : {};
  const jsErrors = Array.isArray(ac.jsErrors)
    ? ac.jsErrors.slice(0, 10).map((e) => clip(e, 300)).filter((e) => e != null)
    : [];
  return {
    reportNumber: card.reportNumber ?? null,
    // Номер тикета в подсистеме-источнике — пользователь ссылается на него.
    sourceTicketNo: card.sourceTicketNo ?? null,
    integration: card.integration ?? null,
    reporterUser: card.reporterUser ?? null,
    reporterService: card.reporterService ?? null,
    reporterForm: card.reporterForm ?? null,
    // Категория из виджета — подсказка пользователя (user_category), не истина.
    category: card.category ?? null,
    autocontext: {
      url: clip(ac.url, 500),
      buildVersion: clip(ac.buildVersion, 100),
      userAgent: clip(ac.userAgent, 300),
      timestamp: clip(ac.timestamp, 60),
      jsErrors,
      lastFailedApiRequestId: clip(ac.lastFailedApiRequestId, 200),
    },
    screenshotUrl: clip(card.screenshotUrl, 500),
  };
}

// Собрать компактный контекст задачи для промта роли.
async function buildRoleContext(c, claimed, { engine = null } = {}) {
  const ev = await c.query(
    `SELECT event_type, from_status::text AS from_status, to_status::text AS to_status, payload_json
       FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [claimed.id],
  );
  const scan = ev.rows.find((r) => r.payload_json && (r.payload_json.changedFiles || r.payload_json.result));
  // INTAKE-INTEGRATIONS-001: LEFT JOIN — беспроектное обращение из интеграций
  // (project_id IS NULL) не должно давать пустую строку (INNER JOIN скрыл бы её).
  const meta = await c.query(
    `SELECT p.id AS project_id, p.code AS project, p.root_path, p.docs_path, s.service_code AS service,
            t.intake_integration_id, t.data_card
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
    [claimed.id],
  );
  // Реальные сервисы проекта (DATA-DISCIPLINE-001): роль классифицирует задачу по
  // фактическому списку сервисов проекта, а не выдумывает названия.
  const projectId = meta.rows[0]?.project_id ?? null;
  const svc = projectId
    ? await c.query('SELECT service_code FROM services WHERE project_id = $1 ORDER BY service_code', [projectId])
    : { rows: [] };
  const prior = await fetchPriorOutputs(c, claimed.id);

  // FA-MISSING-ARTIFACT-001: Аналитику сбоя подаём артефакт последнего провального
  // прогона host-роли (PIPELINE_SERVICE/GIT_INTEGRATOR) — error.code/message,
  // failedStage, упавшая команда с exit code и хвост лога. Без него FA не видит
  // причину (fetchPriorOutputs берёт только SUCCESS-прогоны) и просит «реальный лог»
  // раунд за раундом. Только для FA — прочим ролям артефакт провала не нужен (null).
  const failureArtifact = claimed.role_code === 'FAILURE_ANALYST'
    ? await fetchFailureArtifact(c, claimed.id)
    : null;

  // REVIEW-DELTA-VISIBILITY-001: ролям-ревьюерам/гейтам подаём ветку+коммит доставки
  // Программиста (тот же источник, что видит Git Integrator — resolveHostTaskContext по
  // цепочке предков), чтобы ревьюер смотрел РЕАЛЬНУЮ дельту в изолированной ветке, а не
  // «пустое» рабочее дерево (main). Без него ревьюер отбивал корректные сдачи как
  // NEEDS_FIX «реализация отсутствует». Нет ветки/коммита → null (прежнее поведение).
  let reviewDelta = null;
  if (REVIEW_DELTA_ROLES.has(claimed.role_code)) {
    const host = await resolveHostTaskContext(c, claimed.id).catch(() => null);
    const branch = host?.scan?.payload_json?.worktreeBranch ?? null;
    const commit = host?.scan?.payload_json?.deliveredCommit ?? null;
    if (branch || commit) reviewDelta = { branch, commit };
  }

  // DECOMP-CONTRACT-001: если это задача-на-сервис (kind='service' с подзадачами),
  // её реальные результаты лежат на детях-подзадачах. Соберём их, чтобы Task
  // Reviewer видел весь сервис целиком, а не пустой programmerResult.
  const kids = await c.query(
    `SELECT t.id, t.title, t.status::text AS status,
            (SELECT e.payload_json FROM task_events e
              WHERE e.task_id = t.id
                AND (e.payload_json ? 'result' OR e.payload_json ? 'changedFiles')
              ORDER BY e.created_at DESC LIMIT 1) AS done_payload
       FROM tasks t
      WHERE t.parent_task_id = $1 AND t.task_kind = 'subtask'
      ORDER BY t.created_at`,
    [claimed.id],
  );
  const subtaskResults = kids.rows.map((k) => ({
    taskId: k.id,
    title: k.title,
    status: k.status,
    result: k.done_payload?.result ?? '',
    changedFiles: Array.isArray(k.done_payload?.changedFiles) ? k.done_payload.changedFiles : [],
  }));
  const aggregatedChanged = subtaskResults.flatMap((r) => r.changedFiles);
  const hasChildren = subtaskResults.length > 0;

  // RESEARCH-BUDGET-001: исследующим ролям (Архитектор/Декомпозитор и пр.) подаём
  // карту проекта и карту микросервиса инлайн — чтобы они не переоткрывали
  // структуру широкими Grep-свипами. Карты кэшируются на час (projectMap.js).
  // DECOMPOSER-REMOVE-001: карту подаём по MAP_ROLES (исследующие роли + Приёмщик).
  const { MAP_ROLES } = await import('./roles.js');
  let projectMaps = null;
  if (MAP_ROLES.has(claimed.role_code)) {
    const { loadProjectMaps } = await import('./projectMap.js');
    // PROMPT-CACHE-001: codex (нет prompt-кэша, карта шлётся каждый вызов) получает
    // СОКРАЩЁННУЮ карту; claude_code/deepseek — полную (у claude она кэшируется).
    const variant = String(engine || '').toLowerCase() === 'codex' ? 'short' : 'full';
    projectMaps = await loadProjectMaps(meta.rows[0]?.root_path ?? '', {
      service: meta.rows[0]?.service ?? '',
      docsPath: meta.rows[0]?.docs_path ?? '',
      variant,
    }).catch(() => null);
  }

  // INTAKE-INTEGRATIONS-001: беспроектное обращение из интеграций — подаём Приёмщику
  // каталог ВСЕХ зарегистрированных проектов (код/имя/папки/сервисы), чтобы он
  // определил проект по подсказкам обращения (микросервис-источник и форма). Для
  // задач с проектом — null (проект уже известен).
  let projectCatalog = null;
  if (!projectId && claimed.role_code === 'TASK_INTAKE_OFFICER') {
    const cat = await c.query(
      `SELECT p.code, p.name, p.root_path, p.docs_path,
              COALESCE(
                array_agg(s.service_code ORDER BY s.service_code)
                  FILTER (WHERE s.service_code IS NOT NULL), '{}'
              ) AS services
         FROM projects p
         LEFT JOIN services s ON s.project_id = p.id
        WHERE p.status <> 'paused'
        GROUP BY p.id, p.code, p.name, p.root_path, p.docs_path
        ORDER BY p.code`,
    );
    projectCatalog = cat.rows.map((r) => ({
      code: r.code, name: r.name, rootPath: r.root_path, docsPath: r.docs_path,
      services: Array.isArray(r.services) ? r.services : [],
    }));
  }

  // INTAKE-INTEGRATIONS-001 / INTAKE-CATEGORY-VALIDATION-001: поля обращения из
  // канала интеграций (reporterService/reporterForm/autocontext/screenshotUrl/
  // category) в контекст Приёмщика. Только для задач-обращений и только Приёмщику.
  const intakeReport = buildIntakeReportContext(meta.rows[0]?.data_card, {
    roleCode: claimed.role_code,
    isIntakeTask: Boolean(meta.rows[0]?.intake_integration_id),
  });

  return {
    taskId: claimed.id,
    title: claimed.title,
    description: claimed.description ?? '',
    status: claimed.status,
    role: claimed.role_code,
    project: meta.rows[0]?.project ?? '',
    service: meta.rows[0]?.service ?? '',
    // Реальные координаты проекта — источник истины для ролей (не выдумывать пути).
    projectPath: meta.rows[0]?.root_path ?? '',
    docsPath: meta.rows[0]?.docs_path ?? '',
    // Карта проекта/сервиса инлайн (только для исследующих ролей; иначе null).
    projectMaps,
    // Каталог всех проектов для беспроектного обращения из интеграций (иначе null).
    projectCatalog,
    // Поля обращения из канала интеграций (только у задач-обращений под Приёмщиком).
    intakeReport,
    projectServices: svc.rows.map((r) => r.service_code),
    // Для задачи-на-сервис берём агрегат результатов подзадач; иначе — как раньше.
    programmerResult: hasChildren
      ? subtaskResults.map((r) => `• ${r.title}: ${r.result}`).join('\n')
      : (scan?.payload_json?.result ?? ''),
    changedFiles: hasChildren ? aggregatedChanged : (scan?.payload_json?.changedFiles ?? []),
    subtaskResults,
    priorRoleOutputs: prior.priorRoleOutputs,
    lastReview: prior.lastReview,
    // FA-MISSING-ARTIFACT-001: артефакт последнего провала host-роли (только для FA).
    failureArtifact,
    // REVIEW-DELTA-VISIBILITY-001: ветка/коммит доставки для ролей-ревьюеров (иначе null).
    // buildUserPayload вынет его в markdown-блок renderReviewDelta (в JSON не кладём).
    reviewDelta,
    recentEvents: ev.rows.slice(0, 8).map((r) => ({ type: r.event_type, from: r.from_status, to: r.to_status })),
  };
}

// Прогон одной захваченной роли: вызов ИИ (вне транзакции) → финализация.
// PIPELINE-DYNAMIC-ROUTE-001 + ROLE-FIELD-CONTRACT-001:
//   * маршрут и статус следующей роли берём из этапов проекта;
//   * входной гейт: нет обязательного входящего поля в карточке → BLOCKED (роль
//     не запускаем, токены не тратим);
//   * выходной гейт: роль не заполнила обязательное исходящее поле → REWORK;
//   * заполненные исходящие поля пишем в кумулятивную карточку задачи.
// TESTS-GREEN-SKIP-FA-001 — у задачи есть АКТУАЛЬНЫЙ провал тестов? Аналитик сбоя
// (FAILURE_ANALYST) существует, чтобы диагностировать ПАДЕНИЕ пайплайна. Если
// последний прогон тестов успешен (или тестов не было) — анализировать нечего.
// Чистая функция (статус последнего pipeline_run → bool) — покрыта юнит-тестом.
export function failureAnalysisHasRealFailure(lastPipelineStatus) {
  return String(lastPipelineStatus ?? '').trim().toUpperCase() === 'FAILED';
}

// Статус последнего прогона тестов задачи (или null, если прогонов не было).
async function latestPipelineStatus(c, taskId) {
  const r = await c.query(
    `SELECT status::text AS status FROM pipeline_runs
      WHERE task_id = $1 ORDER BY finished_at DESC NULLS LAST, started_at DESC LIMIT 1`,
    [taskId],
  );
  return r.rows[0]?.status ?? null;
}

// TESTS-GREEN-SKIP-FA-001 — пропустить этап «Анализ сбоя» для задачи с зелёными
// тестами: продвигаем её ВПЕРЁД по маршруту (мимо аналитика) со статусом успеха,
// НЕ запуская модель. Это и реализует правило «тесты пройдены → этап пропускаем»,
// и разгребает завал задач, осевших в FAILURE_ANALYSIS при зелёном пайплайне
// (напр. после реджекта ревьюера или таймаутов аналитика). Возвращает результат
// finalizeRole, либо null — если у задачи РЕАЛЬНЫЙ провал тестов и аналитик нужен.
async function maybeSkipFailureAnalyst(c, claimed, route) {
  const last = await latestPipelineStatus(c, claimed.id);
  if (failureAnalysisHasRealFailure(last)) return null;
  const verdict = {
    ok: true, status: 'SKIPPED', findings: [], fields: {},
    summary: 'Тесты пройдены — анализ сбоя не требуется, этап пропущен.',
  };
  const decision = { outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason: 'tests_passed_skip' };
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    });
  return finalizeRole(c, claimed, {
    verdict, response: '', exchangeId: null, durationMs: 0, decision, resolved, cardValues: {}, kpi: null,
  });
}

// DB-FINALIZE-RETRY-001 — устойчивость финализации прогона к транзиентным обрывам БД.
//
// Проблема: финализация прогона рассуждающей роли (запись вердикта/перехода/agent_run
// ПОСЛЕ LLM-вызова) выполняется отдельной транзакцией BEGIN..COMMIT на claim-соединении.
// Если соединение рвётся в этот момент (короткий шторм «Connection terminated» при
// рестарте/failover pgbouncer/Patroni), финализация падает, ошибка глохла в
// advanceAutomatedTasks (.catch(()=>null)), а прогон оставался в RUNNING и держал слот
// роли до таймаута — так копились сотни FAILED/TIMEOUT.
//
// Решение: ограниченный ретрай ТОЛЬКО пост-LLM записи результата. LLM НЕ повторяем —
// повторяем лишь финализирующую транзакцию, причём на СВЕЖЕМ соединении из пула (claim
// уже закоммичен отдельной транзакцией claimLlmRoleTask, поэтому финализацию безопасно
// повторить на другом соединении — с claim-локом не конфликтует). Идемпотентность
// повторной записи обеспечивается на уровне транзакции (isRunAlreadyFinalized): если
// первая попытка уже закоммитила результат, но ack COMMIT потерялся из-за обрыва, ретрай
// увидит agent_run уже не в RUNNING и выйдет без повторной вставки событий/переходов.
const FINALIZE_RETRY_BACKOFF_MS = [100, 200, 400];

function sleepMs(ms) {
  return new Promise((res) => { setTimeout(res, ms); });
}

// Идемпотентный гейт финализации: блокируем строку agent_run (FOR UPDATE) и смотрим её
// статус. Прогон уже не RUNNING → он финализирован (в т.ч. предыдущей попыткой, чей ack
// COMMIT потерялся) → true: вызывающий обязан ROLLBACK и выйти без повторной записи.
// Нет строки прогона → false (не мешаем прежнему поведению; напр. фейковый клиент в
// тестах, где строки agent_runs нет). Вызывать ВНУТРИ транзакции финализации.
async function isRunAlreadyFinalized(c, agentRunId) {
  if (!agentRunId) return false;
  const r = await c.query(
    `SELECT status::text AS status FROM agent_runs WHERE id = $1 FOR UPDATE`,
    [agentRunId],
  );
  if (!r.rowCount) return false;
  return r.rows[0].status !== 'RUNNING';
}

// Выполнить пост-LLM запись результата прогона с ограниченным ретраем при ТРАНЗИЕНТНОМ
// обрыве соединения. Первая попытка — на исходном claim-соединении `client`; повторы —
// на СВЕЖЕМ соединении (withClient(cfg, ...)), с экспоненциальной задержкой backoff.
// Небизнес-ошибки (не обрыв соединения — isDbConnectionError) пробрасываются сразу, без
// ретраев. Если открывать свежее соединение некуда (cfg не передан и нет deps.withFresh)
// — прежнее поведение: ошибка всплывает наверх. deps — инъекции для тестов.
async function finalizeWithConnRetry(finalize, client, cfg, deps = {}) {
  const withFresh = deps.withFresh ?? (cfg ? (fn) => withClient(cfg, fn) : null);
  const sleep = deps.sleep ?? sleepMs;
  const backoff = deps.backoff ?? FINALIZE_RETRY_BACKOFF_MS;
  try {
    return await finalize(client);
  } catch (error) {
    if (!withFresh || !isDbConnectionError(error)) throw error;
    let lastError = error;
    for (const delayMs of backoff) {
      await sleep(delayMs);
      try {
        return await withFresh(finalize);
      } catch (retryError) {
        lastError = retryError;
        if (!isDbConnectionError(retryError)) throw retryError;
      }
    }
    throw lastError; // ретраи исчерпаны — ошибка всплывает наверх (не глушим молча)
  }
}

// DB-FINALIZE-RETRY-001 (тестовый экспорт): доступ к чистым частям механизма ретрая/
// идемпотентности без сетевого withClient (см. finalizeRetry.test.js).
export const __finalizeRetryInternals = {
  FINALIZE_RETRY_BACKOFF_MS, isRunAlreadyFinalized, finalizeWithConnRetry,
};

async function processClaimedRole(c, claimed, cfg) {
  const route = await loadProjectRoute(c, claimed.project_id);
  // TESTS-GREEN-SKIP-FA-001: аналитик сбоя на задаче с зелёными тестами — пропуск
  // вперёд без вызова модели (см. maybeSkipFailureAnalyst). Делаем это ДО гейта
  // входных полей и тяжёлого tool-loop: пропускаемой задаче они не нужны.
  if (claimed.role_code === 'FAILURE_ANALYST') {
    const skipped = await maybeSkipFailureAnalyst(c, claimed, route);
    if (skipped) return skipped;
  }
  const contract = await loadRoleContract(c, claimed.role_code);
  const card = parseDataCard(claimed);

  const missingIn = missingRequiredInputs(card, contract.inputs);
  if (missingIn.length) {
    return blockClaimedForFields(c, claimed, missingIn);
  }

  const context = await buildRoleContext(c, claimed);

  // Инструменты роли (TOOLS-REGISTRY-001): builtin по разрешённым уровням доступа.
  // Исполняются микросервисом tools-service в корне реального проекта задачи —
  // чтобы роль РЕАЛЬНО читала/меняла проект, а не выдумывала.
  const { getToolsForRole, BUILTIN_TOOL_SCHEMAS } = await import('./tools.js');
  const { executeTool } = await import('./toolsClient.js');
  const roleTools = await getToolsForRole(c, claimed.role_code);
  const projectRoot = String(context.projectPath || context.docsPath || '').trim();
  const toolSchemas = projectRoot
    ? roleTools.builtin.map((name) => BUILTIN_TOOL_SCHEMAS[name]).filter(Boolean)
    : [];
  const runTool = (name, args) => executeTool(name, args, { root: projectRoot });

  let result;
  try {
    result = await runReasoningRole(c, {
      roleCode: claimed.role_code,
      context,
      outputFields: contract.outputs,
      toolSchemas,
      executeTool: runTool,
    });
  } catch (error) {
    // DB-FINALIZE-RETRY-001: LLM-вызов НЕ повторяем — но запись FAILED-исхода тоже
    // должна пережить транзиентный обрыв соединения (иначе прогон завис бы в RUNNING).
    return finalizeWithConnRetry((fc) => failRoleRun(fc, claimed, error), c, cfg);
  }

  // SILENT-FAIL-GUARD-001 (B): модель ответила, но без распознаваемого JSON-вердикта
  // (напр. DeepSeek прислал tool-call разметку вместо финального JSON, либо упёрся в
  // инструменты). НЕ считаем это успехом и НЕ продвигаем задачу вперёд — помечаем
  // «не выполнен» (FAILED) с логированием причины, чтобы быстро находить поломку.
  // DB-FINALIZE-RETRY-001: запись исхода — под ретрай (LLM уже отработал, не повторяем).
  if (result.parsed === null) {
    return finalizeWithConnRetry((fc) => failRoleUnparsed(fc, claimed, result), c, cfg);
  }

  // DB-FINALIZE-RETRY-001: запись вердикта/перехода/agent_run — под ретрай на свежем
  // соединении. LLM-результат (result) уже получен и в ретрае переиспользуется как есть.
  return finalizeWithConnRetry((fc) => applyReasoningVerdict(fc, claimed, {
    route,
    contract,
    verdict: result.verdict,
    response: result.response,
    exchangeId: result.exchangeId,
    durationMs: result.durationMs,
    // OBSERVABILITY-REASONING-001: токены/ходы in-process DeepSeek-пути в KPI.
    kpi: normalizeRunKpi({
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      turns: result.turns, outcome: 'success',
    }),
  }), c, cfg);
}

// Хвост рассуждающей роли: распознанный вердикт → выходной гейт полей → решение
// перехода (абстрактный исход + маршрут проекта) → финализация. Вынесен из
// processClaimedRole, чтобы codex-мост (CODEX-REASONING-001) переиспользовал ту же
// логику переходов, что и внутренний DeepSeek-путь — отличается только источник
// вердикта (внешний `codex exec` против сетевого вызова коннектора).
// OBSERVABILITY-REASONING-001 — нормализовать KPI прогона из тела сдачи раннера
// (reasoning-completed). Числа округляем; нечисловые → null (COALESCE сохранит старое).
export function normalizeRunKpi(input) {
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    tokenInput: int(input?.tokensIn),
    tokenOutput: int(input?.tokensOut),
    // TOKEN-SPLIT-001: разбивка входа (чтение/запись prompt-кэша). null → COALESCE
    // сохранит уже записанное (движки без кэша не затирают детализацию).
    tokenCacheRead: int(input?.tokensCacheRead),
    tokenCacheCreation: int(input?.tokensCacheCreation),
    cost: num(input?.costUsd),
    coldStartMs: int(input?.coldStartMs),
    turns: int(input?.turns),
    outcome: typeof input?.outcome === 'string' ? input.outcome : null,
    // VERSION-KPI-TRACKING-001: метки версии кода раннера и модели из тела сдачи.
    codeVersion: str(input?.codeVersion, 80),
    model: str(input?.model, 120),
  };
}

// Фрагмент SET для дописывания KPI прогона к UPDATE agent_runs после фиксированных
// $1..$base параметров. Токены/стоимость/code_version/model через COALESCE (не
// затираем уже записанное значением NULL при повторной/частичной сдаче).
function runKpiSet(kpi, base) {
  if (!kpi) return { sql: '', params: [] };
  return {
    sql: `, token_input = COALESCE($${base + 1}, token_input), token_output = COALESCE($${base + 2}, token_output)`
       + `, cost = COALESCE($${base + 3}, cost), cold_start_ms = $${base + 4}, turns = $${base + 5}, outcome = $${base + 6}`
       + `, code_version = COALESCE($${base + 7}, code_version), model = COALESCE($${base + 8}, model)`
       // TOKEN-SPLIT-001: детализация входа (COALESCE — null не затирает записанное).
       + `, token_cache_read = COALESCE($${base + 9}, token_cache_read)`
       + `, token_cache_creation = COALESCE($${base + 10}, token_cache_creation)`,
    params: [kpi.tokenInput, kpi.tokenOutput, kpi.cost, kpi.coldStartMs, kpi.turns, kpi.outcome,
      kpi.codeVersion, kpi.model, kpi.tokenCacheRead, kpi.tokenCacheCreation],
  };
}

// Экспортируется для тестов (SERVICE-REPO-PATH-PREFLIGHT-001): проверяем ранний
// preflight repository_path на split-ветке Архитектора без поднятия всей БД.
export async function applyReasoningVerdict(c, claimed, { route, contract, verdict, response, exchangeId, durationMs, kpi = null }) {
  const { values: cardValues, missingRequired: missingOut } = extractOutputs(verdict.fields, contract.outputs);
  // FA-MISSING-ARTIFACT-001 (анти-петля): если Аналитик сбоя СНОВА жалуется на
  // отсутствие артефакта провала — проверяем, была ли та же жалоба в его прошлом
  // прогоне. Две подряд по одному провалу → decideOutcome эскалирует в BLOCKED
  // (missing_artifact), не гоняя Programmer/Reviewer/Pipeline ещё круг вхолостую.
  // Запрос делаем ТОЛЬКО когда текущий вердикт — жалоба (короткое замыкание &&).
  const priorMissingArtifact = claimed.role_code === 'FAILURE_ANALYST'
    && isMissingArtifactComplaint(verdict)
    && await priorFailureAnalystMissedArtifact(c, claimed.id, claimed.agentRunId);
  const reviewerReworkCount = claimed.role_code === 'TASK_REVIEWER'
    ? await countTaskReviewerReworks(c, claimed.id)
    : 0;
  let decision = decideOutcome(claimed.role_code, verdict, {
    reworkCount: claimed.reworkCount,
    maxRework: MAX_REWORK,
    priorMissingArtifact,
    reviewerReworkCount,
  });
  if (missingOut.length && decision.outcome !== 'BLOCK') {
    // MISSING-OUTPUTS-CAP-001: недобор обязательных выходов → REWORK, но КАПЛЕННЫЙ.
    // После MAX_REWORK одинаковых недоборов подряд — BLOCKED на ручной разбор:
    // контракт полей роли расходится с её фактическим выходом, и ещё прогон той же
    // модели по тому же промту нового результата не даст.
    const streak = await priorMissingOutputsStreak(c, claimed.id, claimed.role_code, claimed.agentRunId, MAX_REWORK);
    decision = streak >= MAX_REWORK
      ? { outcome: 'BLOCK', blockStatus: 'BLOCKED', agentRunStatus: 'FAILED', reason: 'missing_outputs_exceeded' }
      : { outcome: 'REWORK', agentRunStatus: 'SUCCESS', reason: `missing_outputs:${missingOut.join(',')}` };
  }
  // INTAKE-INTEGRATIONS-001: беспроектное обращение из канала «интеграции в
  // приложения». Приёмщик определил проект (verdict.fields.project) по каталогу
  // проектов — резолвим его, проставляем project_id (+ service) и входим в Architect.
  // Проект не разрешился → BLOCKED с диагностикой (обращение не теряется).
  if (claimed.role_code === 'TASK_INTAKE_OFFICER' && !claimed.project_id && decision.outcome === 'FORWARD') {
    return routeIntakeToProject(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, kpi });
  }
  // DECOMP-CONTRACT-001: успешный Декомпозитор не просто «forward» — он
  // МАТЕРИАЛИЗУЕТ из карточки задачи-на-сервис (L1) и подзадачи-на-файл (L2),
  // а сам эпик паркует в WAITING_FOR_CHILDREN. Только в линейном маршруте (в
  // граф-режиме fork/join расщепление делают узлы графа, не Декомпозитор).
  if (claimed.role_code === 'DECOMPOSER' && decision.outcome === 'FORWARD' && !claimed.current_stage_key) {
    return materializeDecomposition(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi });
  }

  // DECOMPOSER-REMOVE-001: Архитектор — последняя проектная роль перед Программистом.
  // Декомпозитор больше не материализует подзадачи с service_id, поэтому Архитектор при
  // форварде ГАРАНТИРУЕТ, что у задачи есть service_id (иначе claim_next_claude_task её
  // не выдаст — тихий висяк в CODING). Резолвим главный сервис из вердикта; если у задачи
  // service_id ещё нет и резолв не удался — BLOCKED с диагностикой, а не молчаливый висяк.
  let setServiceId;
  if (claimed.role_code === 'ARCHITECT' && decision.outcome === 'FORWARD') {
    // ARCH-SERVICE-SPLIT-001: если разбивка Архитектора (normalizeWorkItems из
    // data_card + поля вердикта) затрагивает ДВА И БОЛЕЕ разных зарегистрированных
    // сервиса проекта — материализуем НЕЗАВИСИМЫЕ задачи по одной на сервис (каждая
    // идёт по конвейеру отдельно), а эпик паркуем в WAITING_FOR_CHILDREN. Иначе —
    // прежнее поведение: одна задача (ensureArchitectService; 0 сервисов → BLOCKED).
    const split = await resolveArchitectSplit(c, claimed, verdict.fields, cardValues);
    // ARCH-SPLIT-NO-RECURSION-001: расщепляем на независимые per-service задачи ТОЛЬКО
    // задачу верхнего уровня (parent_task_id IS NULL). Split-ребёнок (parent задан, создан
    // прежним расщеплением со своим service_id) при возврате к Архитектору по REWORK снова
    // выглядит «мультисервисным» — его карточка/описание всё ещё упоминают соседние сервисы,
    // — и прежде порождал новый эпик с детьми, те по REWORK расщеплялись опять: бесконечная
    // цепочка эпик→эпик→эпик (WAITING_FOR_CHILDREN, ничего не доходит до листа; инцидент
    // 10.07 — кластер quick_reply_id в PROJECT_2, ~17 вложенных эпиков). Такой ребёнок уже
    // сфокусирован на ОДНОМ сервисе — ведём его дальше одиночным путём (ensureArchitectService
    // резолвит его же service_id и форвардит к Programmer), а не расщепляем повторно.
    if (split.services.length >= 2 && !claimed.parent_task_id) {
      // SERVICE-REPO-PATH-PREFLIGHT-001: ту же проверку repository_path, что и на
      // одиночном пути (ensureArchitectService ниже), прогоняем по КАЖДОМУ сервису
      // split ДО материализации детей. Дочерние service-задачи создаются сразу в
      // статусе/роли следующего этапа (CODING/PROGRAMMER), поэтому без раннего
      // диагноза хотя бы один сервис без валидного пути дошёл бы до Pipeline лишь
      // ради «repository_path не задан/не найден», впустую заняв слоты Programmer.
      // Провал хотя бы одного сервиса → блокируем ЭПИК (детей НЕ создаём) с кодом
      // missing_repository_path и перечнем проблемных сервисов.
      const failed = [];
      for (const svc of split.services) {
        const pf = await preflightServiceRepoPath(c, svc.serviceId);
        if (!pf.ok) failed.push({ code: svc.serviceCode, message: pf.message });
      }
      if (failed.length) {
        return blockClaimedReason(
          c, claimed,
          `missing_repository_path:${failed.map((f) => f.code).join(',')}`,
          {
            verdict, cardValues, kpi, event: 'missing_repository_path',
            detail: failed.map((f) => f.message).join('; '),
          },
        );
      }
      return materializeArchitectSplit(c, claimed, {
        verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi, split,
      });
    }
    const ensured = await ensureArchitectService(c, claimed, verdict.fields, cardValues);
    if (ensured.blocked) {
      return blockClaimedReason(c, claimed, ensured.reason, { verdict, cardValues, kpi, event: 'architect_no_service' });
    }
    // SERVICE-REPO-PATH-PREFLIGHT-001: repository_path эффективного сервиса ОБЯЗАН
    // быть задан и указывать на существующий каталог ДО перехода в CODING. Раньше это
    // ловил только claim PIPELINE_SERVICE — задачу успевали прогнать через Architect и
    // Programmer, и она падала лишь на Pipeline с тем же диагнозом, впустую тратя слоты.
    // Сервис без пути/с несуществующим каталогом → BLOCKED c кодом missing_repository_path.
    const preflight = await preflightServiceRepoPath(c, ensured.resolvedServiceId);
    if (!preflight.ok) {
      return blockClaimedReason(c, claimed, preflight.reason, {
        verdict, cardValues, kpi, event: 'missing_repository_path', detail: preflight.message,
      });
    }
    setServiceId = ensured.serviceId; // uuid, либо undefined если service_id уже задан
  }

  // DECOMPOSER-REMOVE-001: Приёмщик кладёт развёрнутое описание (structured_description)
  // в tasks.description — чтобы Архитектор и карточка задачи видели полный контекст, а не
  // только заголовок, пришедший при создании задачи.
  // TASK-INTAKE-COMMIT-001: он же кладёт человекочитаемое название (short_title →
  // task_title) в tasks.title — чтобы весь конвейер, карточка задачи и коммит
  // Git Integrator использовали название, придуманное Приёмщиком, а не сырой заголовок.
  let setDescription;
  let setTitle;
  // TASK-PRIORITY-SCALE-001: Приёмщик выставляет пользовательский приоритет (fields.priority
  // 1..3). Форс сервера: проект оркестратора → всегда 0 (роль/значение игнорируем); иначе
  // применяем нормализованный fields.priority, а если роль его не задала — не трогаем.
  let setPriority;
  if (claimed.role_code === 'TASK_INTAKE_OFFICER') {
    const dd = verdict.fields?.structured_description ?? cardValues?.structured_description;
    if (typeof dd === 'string' && dd.trim()) setDescription = dd.trim().slice(0, 20000);
    const tt = verdict.fields?.short_title ?? cardValues?.short_title
      ?? verdict.fields?.task_title ?? cardValues?.task_title;
    if (typeof tt === 'string' && tt.trim()) setTitle = tt.trim().slice(0, 300);
    if (claimed.project_id) {
      const projRow = await c.query('SELECT code, root_path FROM projects WHERE id = $1', [claimed.project_id]);
      const proj = projRow.rows[0] ?? null;
      if (isOrchestratorProject(proj)) {
        setPriority = 0;
      } else {
        const reqPr = verdict.fields?.priority ?? cardValues?.priority;
        if (reqPr !== null && reqPr !== undefined && reqPr !== '') setPriority = normalizeClientPriority(reqPr);
      }
    }
  }

  // DOCS-DEBT-001: фиксация документационного долга ради наблюдаемости. При
  // BLOCKED-вердикте DOCUMENTATION_AUDITOR/KEEPER decideOutcome сознательно НЕ
  // блокирует основной поток (docForward, reason='docs_blocked_forwarded' — ветка
  // документации мягко идёт к join, чтобы не держать родителя, см. roleEngine.js).
  // Поток и маршрутизацию НЕ меняем — только помечаем долг в data_card: открываем
  // его при мягком проходе и гасим (resolved) при обычном успешном FORWARD той же
  // роли (документацию довели позже). Флаг мёржится существующим UPDATE tasks
  // (data_card = data_card || $4::jsonb) в finalizeRole.
  if ((claimed.role_code === 'DOCUMENTATION_AUDITOR' || claimed.role_code === 'DOCUMENTATION_KEEPER')
    && decision.outcome === 'FORWARD') {
    cardValues.docs_debt = {
      role: claimed.role_code,
      reason: verdict.summary || decision.reason,
      status: decision.reason === 'docs_blocked_forwarded' ? 'open' : 'resolved',
      at: new Date().toISOString(),
    };
  }

  // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (граф-режим);
  // без него — прежняя позиционная маршрутизация (линейные схемы не затронуты).
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    });
  return finalizeRole(c, claimed, {
    verdict, response, exchangeId, durationMs, decision, resolved, cardValues, kpi, setServiceId, setDescription, setTitle, setPriority,
  });
}

// INTAKE-INTEGRATIONS-001 — маршрутизация беспроектного обращения после Приёмщика.
// Приёмщик определил проект (verdict.fields.project) по каталогу проектов. Резолвим
// его в зарегистрированный проект, проставляем project_id (+ service_id, если сервис
// назван и существует) и входим в Architect (ARCHITECTURE), кладём карточку интейка,
// развёрнутое описание и человекочитаемое название. Проект не разрешился → BLOCKED с
// диагностикой (обращение остаётся под Приёмщиком, видно причину — не теряется).
async function routeIntakeToProject(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, kpi = null }) {
  const pick = (...vals) => {
    for (const v of vals) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t && !/^unknown$/i.test(t)) return t;
    }
    return '';
  };
  const projectRef = pick(verdict.fields?.project, cardValues?.project);
  const project = projectRef ? await findProject(c, projectRef) : null;
  if (!project) {
    return blockClaimedReason(c, claimed, `intake_project_unresolved:${projectRef || 'empty'}`,
      { verdict, cardValues, kpi, event: 'intake_project_unresolved' });
  }

  // Вход в Architect (или безопасный откат к штатному входу, если этапа Architect нет).
  const entry = await computeEntry(c, project.id, 'ARCHITECT');

  // Сервис — опционально: если Приёмщик назвал зарегистрированный сервис проекта.
  let serviceId = null;
  const svcRef = pick(verdict.fields?.service, cardValues?.service);
  if (svcRef) {
    const svc = await c.query(
      'SELECT id FROM services WHERE project_id = $1 AND lower(service_code) = lower($2) LIMIT 1',
      [project.id, svcRef],
    );
    serviceId = svc.rows[0]?.id ?? null;
  }

  // Развёрнутое описание/название от Приёмщика — как в обычном форварде Приёмщика.
  const dd = verdict.fields?.structured_description ?? cardValues?.structured_description;
  const setDescription = typeof dd === 'string' && dd.trim() ? dd.trim().slice(0, 20000) : null;
  const tt = verdict.fields?.short_title ?? cardValues?.short_title
    ?? verdict.fields?.task_title ?? cardValues?.task_title;
  const setTitle = typeof tt === 'string' && tt.trim() ? tt.trim().slice(0, 300) : null;
  // TASK-PRIORITY-SCALE-001: приоритет форсим/нормализуем СЕРВЕРОМ по разрешённому
  // проекту (оркестратор → 0; иначе fields.priority 1..3 или дефолт 2).
  const newPriority = computeTaskPriority(project, verdict.fields?.priority ?? cardValues?.priority);

  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) { await c.query('ROLLBACK'); return null; }
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: cur.rows[0].status, alreadyFinalized: true };
    }

    const mergedCard = { ...(cardValues || {}), project: project.code, projectPath: project.root_path };
    const sets = [
      'project_id = $2', 'status = $3::task_status', 'current_role_id = $4',
      'current_stage_key = $5::uuid', 'assigned_agent_id = NULL', 'data_card = data_card || $6::jsonb',
    ];
    const params = [claimed.id, project.id, entry.status, entry.role.id, entry.entryStageKey ?? null,
      JSON.stringify(mergedCard)];
    params.push(newPriority); sets.push(`priority = $${params.length}::smallint`);
    if (serviceId) { params.push(serviceId); sets.push(`service_id = $${params.length}::uuid`); }
    if (setDescription) { params.push(setDescription); sets.push(`description = $${params.length}`); }
    if (setTitle) { params.push(setTitle); sets.push(`title = $${params.length}`); }
    await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);

    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, outcome: 'FORWARD',
        reason: 'intake_project_resolved', project: project.code, fields: cardValues,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [claimed.id, claimed.status, entry.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, source: 'intake-integration',
        project: project.code, nextRole: entry.role.code, outcome: 'FORWARD', exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: entry.status, nextRole: entry.role.code, project: project.code,
      verdict: verdict.status, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// DECOMPOSER-REMOVE-001 — гарантировать service_id у задачи Архитектора перед CODING.
// service_id уже задан (напр. при создании/форке) → { serviceId: undefined } (форвардим как
// есть). Иначе резолвим ГЛАВНЫЙ сервис из вердикта Архитектора (affected_services/work_items →
// первый зарегистрированный сервис проекта). Не удалось → { blocked, reason }.
async function ensureArchitectService(c, claimed, verdictFields, cardValues) {
  const cur = await c.query('SELECT service_id FROM tasks WHERE id = $1', [claimed.id]);
  // resolvedServiceId — ЭФФЕКТИВНЫЙ сервис задачи (уже заданный ИЛИ вновь резолвнутый),
  // нужен для раннего preflight repository_path (SERVICE-REPO-PATH-PREFLIGHT-001);
  // serviceId остаётся undefined, когда обновлять service_id в finalizeRole не нужно.
  if (cur.rows[0]?.service_id) return { serviceId: undefined, resolvedServiceId: cur.rows[0].service_id };

  const card = {
    ...(parseDataCard(claimed)),
    ...(asObject(verdictFields)),
    ...(cardValues || {}),
  };
  const plan = normalizeWorkItems(card); // [{ serviceCode, ... }] из work_items/affected_files
  const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
  const byCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
  for (const item of plan) {
    const sid = byCode.get(String(item.serviceCode).toLowerCase());
    if (sid) return { serviceId: sid, resolvedServiceId: sid };
  }
  const attempted = plan.map((p) => p.serviceCode).filter(Boolean);
  return { blocked: true, reason: `architect_no_service:${attempted.join(',') || 'empty'}` };
}

// SERVICE-REPO-PATH-PREFLIGHT-001 — ранний диагноз отсутствующего/невалидного
// repository_path сервиса. Та же проверка, что и в claim PIPELINE_SERVICE
// (resolveServiceRepoPath), но выполняется на финализации Архитектора — ДО того как
// задача займёт слоты Programmer и дойдёт до Pipeline лишь ради того же диагноза.
// Инцидент: PIPELINE_SERVICE падал поздно с «repository_path не задан/не найден»
// (CHAT, auth-registration), успев прогнать задачу через Architect и Programmer.
// Читает repository_path/код сервиса и корень проекта, прогоняет через
// resolveServiceRepoPath (логику НЕ дублируем — переиспользуем). Ветка
// CONTAINER-FS-DEGRADE-001 сохранена: безопасный непустой путь доверяем (реальную
// проверку сделает host-runner на хосте), пустой/NULL/небезопасный — провал.
// ВАЖНО: claim на хосте при пустом/невалидном сохранённом пути делает бэкфилл
// каталога по КОДУ сервиса (findServiceDirByCode) и продолжает — resolveServiceRepoPath
// в этом случае возвращает { ok:true, changed:true }. Для РАННЕГО диагноза такой
// бэкфилл — это как раз missing_repository_path: в реестре путь фактически не задан,
// а угадывание по коду каталога маскирует проблему (подтверждённый провал ревью:
// repository_path=NULL + рядом каталог с именем=service_code проходил как ok). Поэтому
// принимаем ТОЛЬКО валидный сохранённый путь (changed:false); бэкфилл (changed:true)
// трактуем как провал. Возвращает { ok: true } либо { ok: false, code, reason, message }.
// Только чтение.
export async function preflightServiceRepoPath(c, serviceId) {
  if (!serviceId) return { ok: true };
  const row = await c.query(
    `SELECT s.service_code, s.repository_path, p.root_path
       FROM services s JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1`,
    [serviceId],
  );
  const svc = row.rows[0];
  if (!svc) return { ok: true }; // сервис не найден — не наша ветка диагноза
  const resolved = resolveServiceRepoPath(svc.root_path, svc.service_code, svc.repository_path);
  if (resolved.ok && !resolved.changed) return { ok: true };
  const code = String(svc.service_code ?? '').trim() || '(без кода)';
  return {
    ok: false,
    code: 'missing_repository_path',
    reason: `missing_repository_path:${code}`,
    message: `сервис ${code}: repository_path не задан или каталог сервиса не найден — `
      + 'укажите корректный repository_path сервиса в реестре сервисов проекта и верните задачу в работу',
  };
}

// ARCH-SERVICE-SPLIT-001 — резолвим разбивку Архитектора в РАЗНЫЕ зарегистрированные
// сервисы проекта (регистронезависимо). Источник карточки — data_card задачи + поля
// вердикта Архитектора + cardValues (как в ensureArchitectService). Возвращает
// { card, services:[{ serviceId, serviceCode, title, files }], unresolved:[serviceCode],
// byCode }. services дедуплицированы по serviceId — несколько work_items одного сервиса
// сливаются (файлы объединяются, заголовок берём первый). Только чтение services.
export async function resolveArchitectSplit(c, claimed, verdictFields, cardValues) {
  const card = {
    ...(parseDataCard(claimed)),
    ...(asObject(verdictFields)),
    ...(cardValues || {}),
  };
  const plan = normalizeWorkItems(card);
  const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
  const byCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
  const byId = new Map();
  const unresolved = [];
  for (const item of plan) {
    const sid = byCode.get(String(item.serviceCode).toLowerCase());
    if (!sid) { unresolved.push(item.serviceCode); continue; }
    if (byId.has(sid)) byId.get(sid).files.push(...item.files);
    else byId.set(sid, { serviceId: sid, serviceCode: item.serviceCode, title: item.title, files: [...item.files] });
  }
  return { card, services: Array.from(byId.values()), unresolved, byCode };
}

// ARCH-SERVICE-SPLIT-001 — карточка дочерней задачи: карточка родителя, но work_items
// и affected_files оставлены ТОЛЬКО для указанного сервиса (код резолвится по byCode
// регистронезависимо к serviceId ребёнка). Прочие поля карточки сохраняются как есть.
function filterCardForService(card, byCode, serviceId) {
  const belongs = (code) => byCode.get(String(code ?? '').trim().toLowerCase()) === serviceId;
  const workItems = jsonArray(card?.work_items).filter((it) => belongs(it?.serviceCode ?? it?.service));
  const affectedFiles = jsonArray(card?.affected_files).filter((f) => belongs(f?.serviceCode ?? f?.service));
  return { ...card, work_items: workItems, affected_files: affectedFiles };
}

// DECOMPOSER-REMOVE-001 — заблокировать задачу с понятной причиной, СОХРАНИВ роль
// (current_role_id не обнуляем — задача остаётся видимой под своей ролью как BLOCKED).
// Прогон роли помечаем SUCCESS (роль отработала; блок — из-за нерезолвимых данных).
async function blockClaimedReason(c, claimed, reason, { verdict, cardValues, kpi = null, event = 'blocked', detail = null } = {}) {
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason, alreadyFinalized: true };
    }
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict?.status, summary: verdict?.summary, reason, outcome: 'BLOCK', fields: cardValues,
        ...(detail ? { detail } : {}),
      }), ...kpiSet.params],
    );
    await c.query(
      `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, reason, event,
        ...(detail ? { detail } : {}),
      })],
    );
    await c.query('COMMIT');
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// DECOMP-CONTRACT-001 — нормализовать разбивку работы из карточки к виду
// [{ serviceCode, title, files: [{ path, what }] }]. Источник: work_items (если
// заполнил Архитектор/Декомпозитор), иначе группировка affected_files по сервису.
// Поля контракта с valueType=json модель по инструкции возвращает JSON-СТРОКОЙ
// (fieldJsonSchema/buildVerdictInstruction: «JSON serialized as a string»), поэтому
// принимаем и готовый массив, и его строковую сериализацию.
function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeWorkItems(card) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const items = jsonArray(card?.work_items);
  const norm = [];
  for (const it of items) {
    const serviceCode = str(it?.serviceCode || it?.service);
    if (!serviceCode) continue;
    const files = jsonArray(it?.files)
      .map((f) => ({ path: str(f?.path), what: str(f?.what || f?.instruction) }))
      .filter((f) => f.path);
    norm.push({ serviceCode, title: str(it?.title) || `Изменения в ${serviceCode}`, files });
  }
  if (norm.length) return norm;
  // Фолбэк: собрать work_items из affected_files (плоский список) по serviceCode.
  const files = jsonArray(card?.affected_files);
  const byService = new Map();
  for (const f of files) {
    const serviceCode = str(f?.serviceCode || f?.service);
    const path = str(f?.path);
    if (!serviceCode || !path) continue;
    if (!byService.has(serviceCode)) byService.set(serviceCode, []);
    byService.get(serviceCode).push({ path, what: str(f?.what || f?.instruction) });
  }
  return Array.from(byService.entries()).map(([serviceCode, fs]) => ({
    serviceCode, title: `Изменения в ${serviceCode}`, files: fs,
  }));
}

// JOIN-PLANNED-COVERAGE-001 — целевой список сервисов эпика (декларированный scope
// Архитектора). Источник — affected_services вердикта Архитектора, ОБЪЕДИНЁННЫЙ с
// serviceCode из work_items. Это устойчиво к усечению work_items капами/таймаутами,
// из-за которого терялись заявленные фронты (B1: Smeta/FastTable). Коды резолвим к
// каноническим service_code зарегистрированных сервисов проекта (регистронезависимо,
// canonicalByCode: lower(code)→service_code), дедуплицируем. Незарегистрированные
// коды отбрасываем — сверять покрытие можно только по реально существующим сервисам.
export function computePlannedServices(card, canonicalByCode) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const codes = [];
  for (const it of jsonArray(card?.affected_services)) {
    const code = typeof it === 'string' ? str(it) : str(it?.serviceCode || it?.service);
    if (code) codes.push(code);
  }
  for (const it of normalizeWorkItems(card)) {
    if (it.serviceCode) codes.push(it.serviceCode);
  }
  const out = [];
  const seen = new Set();
  for (const code of codes) {
    const canonical = canonicalByCode.get(code.toLowerCase());
    if (!canonical) continue;
    const key = String(canonical).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

// DECOMP-CONTRACT-001 — материализация декомпозиции эпика в задачи-на-сервис (L1)
// и подзадачи-на-файл (L2). Один txn. Идемпотентно: если у эпика уже есть дети,
// повторно не создаём. Эпик паркуется в WAITING_FOR_CHILDREN. Если из карточки не
// удалось получить ни одного зарегистрированного сервиса — эпик уходит в BLOCKED с
// диагностикой (не молча зависает).
export async function materializeDecomposition(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi = null }) {
  const card = { ...(parseDataCard(claimed)), ...(cardValues || {}) };
  const plan = normalizeWorkItems(card);

  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении
    // (ack COMMIT предыдущей попытки мог потеряться при обрыве) — прогон уже не RUNNING.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_finalized', durationMs };
    }
    // Идемпотентность: эпик уже расщеплён — финализируем прогон без дублей.
    const hasChildren = await c.query('SELECT 1 FROM tasks WHERE parent_task_id = $1 LIMIT 1', [claimed.id]);
    if (hasChildren.rowCount) {
      const kpiSet0 = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet0.sql} WHERE id = $1`,
        [claimed.agentRunId, JSON.stringify({ status: verdict.status, summary: verdict.summary, reason: 'already_decomposed' }), ...kpiSet0.params],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_decomposed', durationMs };
    }

    // Резолвим коды сервисов проекта (нечувствительно к регистру).
    const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
    const svcByCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
    const resolved = [];
    const unresolved = [];
    for (const item of plan) {
      const sid = svcByCode.get(item.serviceCode.toLowerCase());
      if (sid) resolved.push({ ...item, serviceId: sid });
      else unresolved.push(item.serviceCode);
    }

    // Нет ни одного зарегистрированного сервиса → BLOCKED с диагностикой.
    if (!resolved.length) {
      const kpiSetF = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2${kpiSetF.sql} WHERE id = $1`,
        [claimed.agentRunId, `decomposition_no_services: ${unresolved.join(', ') || 'пустая разбивка'}`, ...kpiSetF.params],
      );
      await c.query(
        `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
        [claimed.id],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
          runner: true, ai: true, role: 'DECOMPOSER', reason: 'decomposition_no_services', unresolved,
        })],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason: 'decomposition_no_services' };
    }

    const programmerRole = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
    const programmerRoleId = programmerRole.rows[0]?.id ?? null;
    const baseCard = JSON.stringify(card);
    let serviceCount = 0;
    let subtaskCount = 0;
    const createdServices = [];

    for (const item of resolved) {
      // L1 — задача-на-сервис: единица приёмки. Пока есть подзадачи — ждёт их.
      const l1 = await c.query(
        `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                            status, current_role_id, created_by, data_card)
         VALUES ($1, $2, $3, 'service', $4, $5, 'WAITING_FOR_CHILDREN', $6, 'decomposer', $7::jsonb)
         RETURNING id`,
        [claimed.project_id, item.serviceId, claimed.id, item.title, claimed.description ?? '',
         programmerRoleId, baseCard],
      );
      const l1Id = l1.rows[0].id;
      serviceCount += 1;
      createdServices.push({ id: l1Id, serviceCode: item.serviceCode });
      await c.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [claimed.id, l1Id],
      );

      // L2 — подзадачи-на-файл (по одной клеймит программист). Без файлов — одна
      // подзадача на весь сервис (чтобы программисту было что взять).
      const files = item.files.length ? item.files : [{ path: '', what: item.title }];
      for (const f of files) {
        const childCard = JSON.stringify({ ...card, service: item.serviceCode, file: f.path, instruction: f.what });
        const subTitle = f.path ? `${item.serviceCode}: ${f.path}` : item.title;
        await c.query(
          `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                              status, current_role_id, created_by, data_card)
           VALUES ($1, $2, $3, 'subtask', $4, $5, 'CODING', $6, 'decomposer', $7::jsonb)`,
          [claimed.project_id, item.serviceId, l1Id, subTitle, f.what || item.title,
           programmerRoleId, childCard],
        );
        subtaskCount += 1;
      }
    }

    // JOIN-PLANNED-COVERAGE-001: фиксируем целевой список сервисов эпика в data_card,
    // чтобы роллап (advanceDecompositionParents) сверял фактических детей с заявленным
    // scope и не закрывал эпик DONE при потерянных фронтах.
    const canonicalByCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.service_code]));
    const plannedServices = computePlannedServices(card, canonicalByCode);
    // Эпик: помечаем видом, паркуем на детях, доливаем карточку Декомпозитора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify({ ...(cardValues || {}), planned_services: plannedServices })],
    );
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: 'decomposed', outcome: decision.outcome, fields: cardValues,
        services: serviceCount, subtasks: subtaskCount, unresolved,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: 'DECOMPOSER', reason: 'decomposed', verdictStatus: verdict.status,
        summary: verdict.summary, services: createdServices, subtasks: subtaskCount, unresolved, exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: 'WAITING_FOR_CHILDREN', nextRole: 'PROGRAMMER', verdict: verdict.status,
      services: serviceCount, subtasks: subtaskCount, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// ARCH-SERVICE-SPLIT-001 — расщепление мультисервисной задачи Архитектора на
// НЕЗАВИСИМЫЕ задачи по сервисам. Вызывается из applyReasoningVerdict (ветка
// ARCHITECT + FORWARD), когда разбивка Архитектора затрагивает ≥2 РАЗНЫХ
// зарегистрированных сервиса. Один txn (по образцу materializeDecomposition). Для
// каждого сервиса создаётся самостоятельная задача-на-сервис (task_kind='service',
// parent = исходная задача, свой service_id, свой раздел описания и отфильтрованная
// карточка), которая входит в маршрут FORWARD-переходом Архитектора и идёт по
// конвейеру ОТДЕЛЬНО (дети друг от друга не зависят). Исходная задача становится
// эпиком (WAITING_FOR_CHILDREN) и закрывается роллапом advanceDecompositionParents
// после завершения всех детей. Идемпотентно: есть дети → финал прогона
// reason='already_decomposed'. Нерезолвленные serviceCode уходят в unresolved
// события — задач по ним не создаём.
export async function materializeArchitectSplit(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi = null, split = null }) {
  const { card, services, unresolved, byCode } = split ?? await resolveArchitectSplit(c, claimed, verdict.fields, cardValues);

  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении
    // (ack COMMIT предыдущей попытки мог потеряться при обрыве) — прогон уже не RUNNING.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_finalized', durationMs };
    }
    // Идемпотентность: задача уже расщеплена (элементы стека работ ИЛИ дети) —
    // финализируем прогон без дублей.
    const already = await c.query(
      `SELECT EXISTS (SELECT 1 FROM work_stack WHERE epic_task_id = $1)
           OR EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = $1) AS dup`,
      [claimed.id],
    );
    if (already.rows[0].dup) {
      const kpiSet0 = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet0.sql} WHERE id = $1`,
        [claimed.agentRunId, JSON.stringify({ status: verdict.status, summary: verdict.summary, reason: 'already_decomposed' }), ...kpiSet0.params],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_decomposed', durationMs };
    }

    // Вход детей в маршрут = FORWARD-переход Архитектора по маршруту проекта. Граф-
    // режим (есть current_stage_key) → целевой узел Programmer (resolveGraphTransition
    // даёт nextStageKey/статус/роль); линейный — resolveTransition (обычно CODING/
    // PROGRAMMER). Дети наследуют этот целевой этап/статус/роль.
    const resolved = claimed.current_stage_key
      ? await resolveGraphTransition(c, claimed, decision)
      : resolveTransition(route, claimed.role_code, decision, {
        currentStatus: claimed.status,
        currentStageKey: claimed.current_stage_key,
      });
    const childRoleId = resolved.nextRole
      ? await roleIdByCode(c, resolved.nextRole)
      : null;
    const childStageKey = resolved.nextStageKey ?? null;

    // WORK-STACK-001: вместо материализации детей прямо в tasks кладём разбивку в
    // очередь work_stack (по одному элементу на сервис, статус PENDING). Дочерние
    // CODING-задачи заводит ленивый промоутер advanceWorkStack по одному на свободный
    // микросервис. Элемент стека — НЕ задача: его нельзя ни задедупить с эпиком, ни
    // вернуть Архитектору на повторное расщепление, поэтому split-time дедуп по
    // fingerprint здесь больше не нужен (он и был источником bogus-дедупа ребёнка).
    let serviceCount = 0;
    const createdServices = [];
    let seq = 0;
    for (const svc of services) {
      // Карточка элемента — карточка эпика (+ поля вердикта Архитектора), отфильтрованная
      // по ЭТОМУ сервису. messageFingerprint НЕ проставляем: будущая дочерняя задача не
      // должна попадать в дедуп по отпечатку (WORK-STACK-001).
      const itemCard = filterCardForService(card, byCode, svc.serviceId);
      delete itemCard.messageFingerprint;
      const filesText = svc.files
        .map((f) => (f.path ? `- ${f.path}${f.what ? ` — ${f.what}` : ''}` : (f.what ? `- ${f.what}` : '')))
        .filter(Boolean)
        .join('\n');
      const itemDescription = `${claimed.description ?? ''}\n\n## Задание для сервиса ${svc.serviceCode}\n${filesText || svc.title}`
        .trim()
        .slice(0, 20000);
      await c.query(
        `INSERT INTO work_stack (epic_task_id, project_id, service_id, service_code, seq,
                                 title, description, data_card, target_status, target_role_id, target_stage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [claimed.id, claimed.project_id, svc.serviceId, svc.serviceCode, seq,
         svc.title, itemDescription, JSON.stringify(itemCard),
         resolved.toStatus, childRoleId, childStageKey],
      );
      seq += 1;
      serviceCount += 1;
      createdServices.push({ serviceCode: svc.serviceCode, service_id: svc.serviceId });
    }

    // JOIN-PLANNED-COVERAGE-001: фиксируем целевой список сервисов эпика в data_card —
    // роллап сверит фактических детей с заявленным Архитектором scope и не закроет
    // эпик DONE, если часть заявленных сервисов не материализовалась в детей.
    const canonicalRows = await c.query('SELECT service_code FROM services WHERE project_id = $1', [claimed.project_id]);
    const canonicalByCode = new Map(canonicalRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.service_code]));
    const plannedServices = computePlannedServices(card, canonicalByCode);
    // Эпик: помечаем видом, паркуем на детях, доливаем поля вердикта Архитектора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify({ ...(cardValues || {}), planned_services: plannedServices })],
    );
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: 'architect_service_split', outcome: decision.outcome, fields: cardValues,
        services: serviceCount, unresolved,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, reason: 'architect_service_split',
        verdictStatus: verdict.status, summary: verdict.summary, services: createdServices, unresolved, exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: 'WAITING_FOR_CHILDREN', nextRole: resolved.nextRole, verdict: verdict.status,
      services: serviceCount, unresolved, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Применить переход роли по вердикту в отдельной транзакции.
// resolved — { nextRole, toStatus, done, blocked } из projectRoute.resolveTransition.
// cardValues — заполненные ролью исходящие поля → мердж в кумулятивную карточку.
async function finalizeRole(c, claimed, { verdict, response, exchangeId, durationMs, decision, resolved, cardValues = {}, kpi = null, setServiceId, setDescription, setTitle, setPriority }) {
  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) {
      await c.query('ROLLBACK');
      return null;
    }
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации. Если предыдущая
    // попытка уже закоммитила результат (а ack COMMIT потерялся из-за обрыва соединения),
    // прогон уже не RUNNING — выходим без повторной вставки события/перехода (иначе
    // задвоили бы task_events и повторно перевели задачу).
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: cur.rows[0].status, alreadyFinalized: true };
    }
    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);

    if (resolved.nextRole && !nextRoleId) {
      const reason = `next_role_missing:${resolved.nextRole}`;
      await c.query(
        `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL,
                data_card = data_card || $2::jsonb
          WHERE id = $1`,
        [claimed.id, JSON.stringify({ orchestration_error: reason })],
      );
      const kpiSet = runKpiSet(kpi, 3);
      await c.query(
        `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2,
                output_json = $3::jsonb${kpiSet.sql}
          WHERE id = $1`,
        [claimed.agentRunId, reason, JSON.stringify({
          status: 'BLOCKED',
          summary: reason,
          reason,
          outcome: 'BLOCK',
          via: resolved.via,
          fields: cardValues,
        }), ...kpiSet.params],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
          runner: true, ai: true, role: claimed.role_code, reason,
          missingRole: resolved.nextRole, outcome: 'BLOCK', via: resolved.via, exchangeId,
        })],
      );
      await c.query('COMMIT');
      return {
        taskId: claimed.id,
        fromRole: claimed.role_code,
        fromStatus: claimed.status,
        toStatus: 'BLOCKED',
        nextRole: null,
        verdict: 'BLOCKED',
        durationMs,
        blocked: true,
        reason,
      };
    }

    // FORK-JOIN-001: в граф-режиме переносим текущий узел; в линейном — остаётся NULL.
    // DECOMPOSER-REMOVE-001: опционально проставляем service_id (Архитектор) и/или
    // description (Приёмщик — structured_description) в том же UPDATE.
    // TASK-INTAKE-COMMIT-001: и/или title (Приёмщик — short_title).
    const sets = [
      'status = $2::task_status', 'current_role_id = $3', 'assigned_agent_id = NULL',
      'data_card = data_card || $4::jsonb', 'current_stage_key = $5::uuid',
    ];
    const params = [claimed.id, resolved.toStatus, nextRoleId, JSON.stringify(cardValues || {}), resolved.nextStageKey ?? null];
    if (setServiceId) {
      params.push(setServiceId);
      sets.push(`service_id = $${params.length}::uuid`);
    }
    if (typeof setDescription === 'string' && setDescription) {
      params.push(setDescription);
      sets.push(`description = $${params.length}`);
    }
    if (typeof setTitle === 'string' && setTitle) {
      params.push(setTitle);
      sets.push(`title = $${params.length}`);
    }
    // TASK-PRIORITY-SCALE-001: серверный приоритет (Приёмщик/форс оркестратора).
    if (Number.isInteger(setPriority)) {
      params.push(setPriority);
      sets.push(`priority = $${params.length}::smallint`);
    }
    await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);
    const kpiSet = runKpiSet(kpi, 3);
    await c.query(
      `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, decision.agentRunStatus, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: decision.reason, outcome: decision.outcome, via: resolved.via, fields: cardValues,
      }), ...kpiSet.params],
    );
    if (claimed.role_code === 'TASK_REVIEWER') {
      const rev = ['APPROVED', 'REJECTED', 'NEEDS_FIX'].includes(verdict.status)
        ? verdict.status
        : (verdict.ok ? 'APPROVED' : 'NEEDS_FIX');
      await c.query(
        `INSERT INTO reviews (task_id, reviewer_agent_id, status, review_text) VALUES ($1, $2, $3::review_status, $4)`,
        [claimed.id, claimed.agentId, rev, verdict.summary || String(response).slice(0, 2000)],
      );
    }
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
      [
        claimed.id,
        resolved.done ? 'TASK_DONE' : 'STATUS_CHANGED',
        claimed.status,
        resolved.toStatus,
        claimed.role_id,
        JSON.stringify({
          runner: true, ai: true, role: claimed.role_code, verdictStatus: verdict.status,
          summary: verdict.summary, nextRole: resolved.nextRole, outcome: decision.outcome,
          via: resolved.via, fields: cardValues, exchangeId,
        }),
      ],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id,
      fromRole: claimed.role_code,
      fromStatus: claimed.status,
      toStatus: resolved.toStatus,
      nextRole: resolved.nextRole,
      verdict: verdict.status,
      durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// ROLE-FIELD-CONTRACT-001: входной гейт. Обязательное входящее поле роли не
// заполнено в карточке задачи → ставим задачу BLOCKED (роль не запускаем), агент-
// прогон помечаем FAILED, пишем диагностическое событие с перечнем полей.
async function blockClaimedForFields(c, claimed, missingFields) {
  await c.query('BEGIN');
  try {
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2 WHERE id = $1`,
      [claimed.agentRunId, `missing_required_inputs: ${missingFields.join(', ')}`],
    );
    await c.query(
      `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, reason: 'missing_required_inputs', role: claimed.role_code, fields: missingFields,
      })],
    );
    await c.query('COMMIT');
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason: 'missing_required_inputs', fields: missingFields };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Ошибка вызова ИИ: освободить слот, пометить прогон FAILED. После MAX_REWORK
// провалов одной роли — пометить задачу BLOCKED, чтобы не жечь токены вечно.
async function failRoleRun(c, claimed, err) {
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return null;
    }
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2 WHERE id = $1`,
      [claimed.agentRunId, err.message],
    );
    const fails = await c.query(
      `SELECT count(*)::int AS n FROM agent_runs WHERE task_id = $1 AND role_id = $2 AND status = 'FAILED'`,
      [claimed.id, claimed.role_id],
    );
    if (fails.rows[0].n >= MAX_REWORK) {
      await c.query(`UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1`, [claimed.id]);
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({ runner: true, error: err.message, reason: 'role_failed_max' })],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', error: err.message };
    }
    await c.query(`UPDATE tasks SET assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`, [claimed.id]);
    await c.query('COMMIT');
    return null;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// VERDICT-RETRY-001: verdict_unparsed НЕ должен сразу ронять задачу в терминальный
// FAILED. Движок claude_code (Claude Agent SDK) не умеет навязать JSON-схему вердикта
// на уровне CLI (в отличие от codex `--output-schema`), поэтому единичный сбой формата
// вердикта — обычный шум, а не тупик: сначала минимум один авто-повтор прогона роли
// (release, по образцу failRoleRun), и только после исчерпания лимита — прежний
// терминальный FAILED. Лимит настраивается env (0 = прежнее поведение без ретраев).
const MAX_VERDICT_RETRY = resolveInt('RUNNER_MAX_VERDICT_RETRY', 1, { min: 0, max: 10 }).value;

// SILENT-FAIL-GUARD-001 (B): реасонинг-роль вернула ответ, но без распознаваемого
// JSON-вердикта. Раньше такой случай молча уходил вперёд как успех (пустые поля).
// Теперь помечаем прогон «не выполнен» (FAILED) и ПОДРОБНО логируем причину:
// agent_runs.error_text + output_json (reason=verdict_unparsed), а сырой ответ модели
// уже лежит в prompt_exchanges. VERDICT-RETRY-001: пока не исчерпан лимит авто-повторов
// — освобождаем задачу под ретрай (return null, как failRoleRun); только после —
// терминальный FAILED с событием STATUS_CHANGED→FAILED.
async function failRoleUnparsed(c, claimed, result) {
  const head = String(result?.response ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const reason = 'verdict_unparsed';
  const errorText = `verdict_unparsed: роль ${claimed.role_code} не вернула распознаваемый JSON-вердикт `
    + `(ответ модели не распарсился; см. prompt_exchanges ${result?.exchangeId ?? ''})`;
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return null;
    }
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2, output_json = $3::jsonb WHERE id = $1`,
      [claimed.agentRunId, errorText, JSON.stringify({ reason, exchangeId: result?.exchangeId ?? null, responseHead: head })],
    );
    // Сколько раз ЭТА роль уже падала на неразобранном вердикте (вкл. только что
    // помеченный прогон — reason уже записан в output_json выше). Пока лимит не
    // превышен — освобождаем задачу (status/роль сохраняются) под авто-повтор.
    const retries = await c.query(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE task_id = $1 AND role_id = $2 AND status = 'FAILED' AND output_json->>'reason' = 'verdict_unparsed'`,
      [claimed.id, claimed.role_id],
    );
    if (retries.rows[0].n <= MAX_VERDICT_RETRY) {
      await c.query(
        `UPDATE tasks SET assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
        [claimed.id],
      );
      await c.query('COMMIT');
      return null; // освобождено под авто-ретрай (тот же движок заберёт задачу снова)
    }
    // Лимит авто-повторов исчерпан — прежнее поведение: терминальный FAILED.
    await c.query(
      `UPDATE tasks SET status = 'FAILED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'FAILED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, reason, role: claimed.role_code,
        exchangeId: result?.exchangeId ?? null, responseHead: head,
      })],
    );
    await c.query('COMMIT');
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'FAILED', reason };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

export function normalizeScannerCompletion(input) {
  const required = (key) => {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw scannerError(422, `${key}_required`);
    return value;
  };
  const taskId = required('taskId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw scannerError(422, 'taskId_must_be_uuid');
  }
  return {
    taskId,
    completionKey: required('completionKey'),
    project: required('project'),
    service: required('service'),
    title: required('title'),
    status: 'completed',
    // COMPLETION-SUMMARY-TEXT-001: раннер программиста шлёт result ОБЪЕКТОМ
    // ({ summary, ... }); извлекаем текстовый summary вместо String(object) —
    // иначе «[object Object]» в task_events, output_json прогона и приорах.
    result: resultSummaryText(input?.result),
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map(String) : [],
    // WORKTREE-BRANCH-CONTEXT-001: ветка/коммит worktree программиста (programmer-runner
    // сдаёт код коммитом в programmer/<project>/<service> в отдельном worktree). Нужны
    // Git Integrator, чтобы влить ветку в main, а не искать незакоммиченные файлы в
    // основном дереве. Отсутствуют (старый раннер) → null, поведение прежнее.
    worktreeBranch: typeof input?.worktreeBranch === 'string' && input.worktreeBranch.trim()
      ? input.worktreeBranch.trim().slice(0, 255) : null,
    deliveredCommit: typeof input?.deliveredCommit === 'string' && input.deliveredCommit.trim()
      ? input.deliveredCommit.trim().slice(0, 80) : null,
    // usage/cost/cold start сдачи программиста (контракт с programmer-runner). В
    // теле идут как есть; finalizeProgrammerRunOnCompletion читает их через
    // normalizeRunKpi/runKpiSet. Числа/строки; отсутствуют (старый раннер) → null.
    tokensIn: input?.tokensIn ?? null,
    tokensOut: input?.tokensOut ?? null,
    tokensCacheRead: input?.tokensCacheRead ?? null,
    tokensCacheCreation: input?.tokensCacheCreation ?? null,
    costUsd: input?.costUsd ?? null,
    coldStartMs: input?.coldStartMs ?? null,
    // Число проходов (ходов агента) до завершения — скалярная метрика для Монитора.
    numTurns: Number.isFinite(Number(input?.numTurns)) ? Math.trunc(Number(input.numTurns)) : null,
    // VERSION-KPI-TRACKING-001: версия кода раннера и модель — у программиста промт
    // в коде, поэтому code_version версионирует и логику, и промт. Метки идут в
    // payload события сдачи (KPI программиста живут в task_events, не в agent_runs).
    codeVersion: typeof input?.codeVersion === 'string' && input.codeVersion.trim()
      ? input.codeVersion.trim().slice(0, 80) : null,
    model: typeof input?.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 120) : null,
    completedAt: input?.completedAt ?? null,
    sourceDocument: required('sourceDocument'),
    nextRole: 'TASK_REVIEWER',
    // ROLE-FIELD-CONTRACT-001: значения полей карточки от Programmer (если есть).
    fields: input?.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
      ? input.fields : null,
  };
}

function scannerError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
