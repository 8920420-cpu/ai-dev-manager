// Работа с PostgreSQL: проверка подключения, автосоздание БД, миграции, seed.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW, fastForwardHiddenRoles } from './rolePipeline.js';
import { runReasoningRole, decideTransition, decideOutcome, summarizePriorRuns, LLM_ROLE_CODES, MAX_REWORK, buildUserPayload, buildVerdictJsonSchema, normalizeVerdict, parseVerdict, renderProjectMaps } from './roleEngine.js';
import { buildRoute, resolveTransition, forwardFrom, routeIsUsable, TERMINAL_STATUSES } from './projectRoute.js';
import { buildGraph, nextNodeKey, forkBranchKeys, nodeByKey } from './graphRoute.js';
import { extractOutputs, missingRequiredInputs } from './fieldsContract.js';
import { buildPipelineClaimContract } from './pipelineDispatch.js';
import { reconcileClockSkew } from './clockGuard.js';
import { isDbConnectionError, noteDbConnectionFailure, claimGraceActive } from './bootClaimGuard.js';
import { resolveDuration, resolveInt, logEffectiveConfig, parseDurationMs } from './envConfig.js';
import { isDriverProvider } from './connectors.js';
import { hashToken } from './intakeIntegrations.js';

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

// PROGRAMMER-UNIFY-001 — финализировать RUNNING-прогон программиста при успешной
// сдаче. Захват создал ровно один agent_run RUNNING на эту задачу под ролью
// PROGRAMMER; переводим его в SUCCESS с KPI (turns=passes, model, code_version) —
// так программист считается в «Мониторе» (roleLoad) и версиях единообразно с
// рассуждающими ролями. Толерантно: нет прогона (legacy/прямое создание задачи) —
// 0 строк, сдача не падает. roleId — роль на момент ЗАХВАТА (PROGRAMMER), а не
// после продвижения задачи.
async function finalizeProgrammerRunOnCompletion(c, { taskId, roleId, payload }) {
  if (roleId == null) return;
  const turns = Number.isFinite(Number(payload?.numTurns)) ? Math.trunc(Number(payload.numTurns)) : null;
  const summary = typeof payload?.result === 'string'
    ? payload.result.slice(0, 2000)
    : (payload?.result?.summary ?? payload?.title ?? 'completed');
  await c.query(
    `UPDATE agent_runs
        SET status = 'SUCCESS', finished_at = now(), turns = $2, outcome = 'success',
            model = COALESCE($3, model), code_version = COALESCE($4, code_version),
            output_json = $5::jsonb
      WHERE id = (
        SELECT id FROM agent_runs
         WHERE task_id = $1 AND role_id = $6 AND status = 'RUNNING'
         ORDER BY started_at DESC LIMIT 1
      )`,
    [taskId, turns, payload?.model ?? null, payload?.codeVersion ?? null,
      JSON.stringify({ status: 'DONE', summary, changedFiles: payload?.changedFiles ?? [] }), roleId],
  );
}

/**
 * Принять завершение от файлового Scanner bridge и передать задачу Task Reviewer.
 * scanner_dispatches и транзакция обеспечивают exactly-once переход на стороне БД.
 */
export async function acceptScannerCompletion(s, input) {
  const payload = normalizeScannerCompletion(input);
  return withClient(clientConfig(s), (c) => acceptScannerCompletionTx(c, payload));
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

      // Завершение Programmer → продвижение по маршруту проекта
      // (PIPELINE-DYNAMIC-ROUTE-001). Канонический фолбэк — REVIEW/TASK_REVIEWER.
      const route = await loadProjectRoute(c, task.project_id);
      const fromRole = task.current_role_code || 'PROGRAMMER';
      let toStatus = 'REVIEW';
      let nextRoleId = task.reviewer_role_id;
      let nextRoleCode = 'TASK_REVIEWER';
      if (routeIsUsable(route)) {
        const resolved = resolveTransition(route, fromRole, { outcome: 'FORWARD' });
        toStatus = resolved.toStatus;
        nextRoleCode = resolved.nextRole;
        nextRoleId = resolved.done || !resolved.nextRole
          ? null
          : (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null;
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
            result: payload.result, changedFiles: payload.changedFiles, fields: progCardValues,
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
              `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL
                WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'
                RETURNING status`,
              [task.parent_task_id, toStatus, nextRoleId],
            );
            if (parent.rowCount) {
              parentPromoted = true;
              await c.query(
                `INSERT INTO task_events
                   (task_id, event_type, from_status, to_status, role_id, payload_json)
                 VALUES ($1, 'STATUS_CHANGED', 'WAITING_FOR_CHILDREN', $4::task_status, $2, $3::jsonb)`,
                [task.parent_task_id, nextRoleId, JSON.stringify({
                  source: 'scanner', reason: 'all_subtasks_done', nextRole: nextRoleCode, kind: 'service',
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
             data_card = data_card || $4::jsonb
         WHERE id = $1`,
        [payload.taskId, toStatus, nextRoleId, JSON.stringify(progCardValues || {})],
      );
      await c.query(
        `INSERT INTO task_events
           (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, $5::task_status, $3, $4::jsonb)`,
        [payload.taskId, task.status, nextRoleId, JSON.stringify({
          source: 'scanner',
          completionKey: payload.completionKey,
          service: payload.service,
          result: payload.result,
          changedFiles: payload.changedFiles,
          nextRole: nextRoleCode,
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
 * SCANNER-INTAKE-001 (TASK-INTAKE-OFFICER-001). Приём сырой задачи: Scanner
 * забирает запрос из папки (или задача приходит из модального окна) и создаёт её
 * в БД под ПЕРВОЙ ролью движения — Приёмщиком задач (TASK_INTAKE_OFFICER) в статусе
 * BACKLOG, после чего runner ведёт её по цепочке (BACKLOG → ARCHITECTURE → …). Сервис
 * при импорте АВТО-регистрируется. Идемпотентность — по UNIQUE (project_id,
 * external_id): повторный приём того же файла возвращает duplicate, не создавая дубль.
 */
export async function acceptScannerIntake(s, input) {
  const payload = normalizeScannerIntake(input);
  return withClient(clientConfig(s), async (c) => {
    // Постановщик явно указывает папку проекта (projectPath) или иной идентификатор.
    // Сопоставляем детерминированно. Не нашли → проект НЕ задан, задача станет
    // неразобранной (project_id IS NULL) и попадёт в корзину Приёмщика.
    const project = await findProject(c, payload.project);
    const serviceId = project ? await getOrCreateService(c, project.id, payload.service) : null;
    // Идемпотентный поиск дубля: для назначенной — в рамках проекта, для
    // неразобранной — среди задач без проекта (частичный uniq-индекс).
    const findDup = () => (project
      ? c.query('SELECT id FROM tasks WHERE project_id = $1 AND external_id = $2', [project.id, payload.externalId])
      : c.query('SELECT id FROM tasks WHERE project_id IS NULL AND external_id = $1', [payload.externalId]));

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
            ...(payload.card && typeof payload.card === 'object' ? payload.card : {}),
          }
        : { requestedProject: payload.project || null };

      const ins = await c.query(
        `INSERT INTO tasks
           (project_id, service_id, external_id, title, description, status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8::uuid, 'scanner-intake', $9::jsonb)
         RETURNING id`,
        [project?.id ?? null, serviceId, payload.externalId, payload.title, payload.description,
         status, role.id, entryStageKey, JSON.stringify(dataCard)],
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

/**
 * INTAKE-INTEGRATIONS-001 — нормализация обращения из канала «интеграции в
 * приложения» (POST /api/intake/report). Чистая функция (без БД): проверяет
 * обязательные поля и собирает автоконтекст. token приходит из заголовка запроса
 * (Authorization: Bearer / X-Intake-Token) — сервер кладёт его в input.token.
 */
export function normalizeIntakeReport(input) {
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
      };
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
              t.created_at, t.data_card
         FROM tasks t
        WHERE t.project_id IS NULL
          AND t.status NOT IN ('DONE', 'CANCELLED')
        ORDER BY t.created_at DESC`,
    );
    return {
      tasks: r.rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        title: row.title,
        description: row.description,
        status: row.status,
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
        'SELECT id, external_id, project_id FROM tasks WHERE id = $1 FOR UPDATE', [id],
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
      const upd = await c.query(
        `UPDATE tasks
            SET project_id = $2, status = 'BACKLOG', current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL,
                data_card = COALESCE(data_card, '{}'::jsonb)
                            || jsonb_build_object('project', $5::text, 'projectPath', $6::text),
                updated_at = now()
          WHERE id = $1 AND project_id IS NULL
          RETURNING id`,
        [id, project.id, role.id, entryStageKey, project.code, project.root_path],
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
      : resolveTransition(route, task.role_code, decision);

    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null;

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
 * Плоский список завершённых конвейером задач (status = DONE) с проектом, сервисом
 * и признаком приёма. Клиент делит его на «Проверка» (accepted = false) и
 * «Выполнено» (accepted = true). Подзадачи (parent_task_id) учитываются наравне с
 * верхним уровнем — приём выполняется по любой задаче, дошедшей до DONE. Read-only.
 * Возвращает { tasks: [{ id, title, projectId, projectName, serviceName, status,
 * accepted, acceptedAt, updatedAt, priority }] } в порядке свежести.
 */
export async function getAcceptanceBoard(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.priority::text AS priority,
              t.accepted_at, t.updated_at,
              p.id AS project_id, p.name AS project_name,
              sv.service_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN services sv ON sv.id = t.service_id
        WHERE t.status = 'DONE'
        ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
        LIMIT 1000`,
    );
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
    }));
    return { tasks };
  });
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
async function autoAcceptDoneTasks(c) {
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
async function getOrCreateService(c, projectId, serviceCode, serviceName) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const found = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (found.rowCount) return found.rows[0].id;
  const ins = await c.query(
    `INSERT INTO services (project_id, service_code, service_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, service_code) DO UPDATE SET service_code = EXCLUDED.service_code
     RETURNING id`,
    [projectId, code, String(serviceName ?? '').trim() || code],
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
    // Карточка интейка (поля контракта Приёмщика) → сливается в data_card для Architect.
    card: input?.card && typeof input.card === 'object' && !Array.isArray(input.card)
      ? input.card : null,
  };
}

// SELECT задачи в форме, нужной диспетчеру Scanner (FOR UPDATE — блокируем строку).
const SCANNER_TASK_SELECT = `SELECT t.id, t.status::text AS status, p.id AS project_id,
        p.code AS project_code, s.service_code, rr.id AS reviewer_role_id,
        t.current_role_id, cr.code AS current_role_code,
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
                    AND ar.finished_at > COALESCE((
                          SELECT max(ok.finished_at) FROM agent_runs ok
                           WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                             AND ok.status = 'SUCCESS'), '-infinity'::timestamptz)
               ) cd
               WHERE cd.n_fail > 0
                 AND now() < cd.last_fail
                             + (($1::int[])[LEAST(cd.n_fail::int, array_length($1::int[], 1))])
                               * interval '1 millisecond'
             )
           ORDER BY t.priority DESC, t.created_at
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
        `SELECT p.code AS project_code, s.service_code
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id
          WHERE t.id = $1`,
        [row.id],
      );
      const { project_code, service_code } = meta.rows[0];
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
      // Эффективная модель: коннектор роли > дефолт агента > пусто (раннер сам решит).
      const programmerModel = connModel || agentModel || null;
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
  return withClient(clientConfig(s), (c) => releaseClaudeTaskTx(c, taskId, opts));
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
    return { released, taskId: id };
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
 * предков; берём ПОСЛЕДНЕЕ событие с непустым changedFiles или непустым result —
 * пустые ([]/'') не считаются, иначе TASK_CREATED с changedFiles:[] перекрывает
 * реальную сдачу. rootTask — корень цепочки (карточка Приёмщика для коммита).
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
      ORDER BY created_at DESC LIMIT 1`,
    [chainIds],
  );
  return { chainIds, rootTask, scan: ev.rows[0] ?? null };
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
        `SELECT t.id, t.title, t.description, t.current_role_id, t.project_id, t.service_id
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
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM project_stages ps2
                   WHERE ps2.project_id = t.project_id AND ps2.enabled = true AND ps2.task_status IS NOT NULL
                )
                AND t.status = $2::task_status
              )
            )
          ORDER BY t.priority DESC, t.created_at
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
        try {
          pipeline = buildPipelineClaimContract({
            projectId: m.project_id,
            projectCode: m.project,
            serviceId: m.service_id,
            serviceCode: m.service,
            serviceName: m.service_name,
            projectRoot: m.root_path,
            repositoryPath: m.repository_path,
          });
        } catch (err) {
          throw scannerError(422, err.code || 'pipeline_contract_invalid');
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
 * pipeline_runs; success → COMMIT/DOCUMENTATION_AUDITOR, fail → FAILURE_ANALYSIS.
 * Для GIT_INTEGRATOR success → DONE, fail → BLOCKED.
 */
export async function completeHostTask(s, input) {
  return withClient(clientConfig(s), (c) => completeHostTaskTx(c, input));
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
                t.project_id, r.code AS role_code
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
      const route = await loadProjectRoute(c, t.project_id);
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
        resolved = success
          ? resolveTransition(route, roleCode, { outcome: 'FORWARD' })
          : resolveTransition(route, roleCode, {
              outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework',
            });
      } else {
        // GIT_INTEGRATOR: успех завершает маршрут, провал — стоп.
        resolved = success
          ? resolveTransition(route, roleCode, { outcome: 'FORWARD' })
          : { nextRole: null, toStatus: 'BLOCKED', done: false, blocked: true, via: 'route' };
      }
      const toStatus = resolved.toStatus;
      const nextRole = resolved.nextRole;

      // Значения исходящих полей host-роли → кумулятивная карточка задачи.
      const hostContract = await loadRoleContract(c, roleCode);
      const { values: hostCardValues } = extractOutputs(output?.fields ?? output, hostContract.outputs);

      const nextRoleId = !nextRole
        ? null
        : (await c.query('SELECT id FROM roles WHERE code = $1', [nextRole])).rows[0]?.id ?? null;

      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
                data_card = data_card || $4::jsonb WHERE id = $1`,
        [taskId, toStatus, nextRoleId, JSON.stringify(hostCardValues || {})],
      );
      if (t.assigned_agent_id) {
        await c.query(
          `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb
            WHERE task_id = $1 AND status = 'RUNNING'`,
          [taskId, success ? 'SUCCESS' : 'FAILED', JSON.stringify(output)],
        );
      }
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
    return { released: r.rowCount > 0, taskId: id };
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
    const card = claimed.data_card && typeof claimed.data_card === 'object' ? claimed.data_card : {};
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
    const roleMaxTurns = resolveRoleMaxTurns(claimed.role_code);
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
  return withClient(clientConfig(s), (c) => completeReasoningTaskTx(c, input));
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
    return { released: r.rowCount > 0, taskId: id };
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
logEffectiveConfig('programmer release loop', [programmerLoopMaxCfg]);
console.log(`programmer release backoff schedule (ms)=${JSON.stringify(PROGRAMMER_RELEASE_BACKOFF_MS)}`);

// --- Динамический маршрут проекта (PIPELINE-DYNAMIC-ROUTE-001) ---------------

// Прочитать этапы проекта и собрать плоский маршрут (buildRoute). Пустой массив
// — у проекта нет этапов (применяется канонический фолбэк ROLE_FLOW).
async function loadProjectRoute(c, projectId) {
  if (!projectId) return [];
  const stages = await c.query(
    `SELECT id, position, enabled, task_status::text AS task_status
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
    return { ...resolveTransition(route, claimed.role_code, decision), nextStageKey: null };
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
    // DECOMP-CONTRACT-001: эпик, у которого все задачи-на-сервис стали терминальны,
    // завершается (DONE) или блокируется (BLOCKED, если сервис упал). Линейный
    // аналог снятия join-барьера для декомпозиции по микросервисам.
    await advanceDecompositionParents(c);
    // TASK-AUTO-ACCEPT-001: если включена авто-приёмка («не проверять выполненные»),
    // помечаем свежие DONE принятыми в том же тике — задача сразу в «Выполнено», а не
    // копится в подразделе «Проверка». Делаем ПОСЛЕ шагов, приводящих к DONE (join/
    // rollup), чтобы не ждать следующего тика. Выключение вернёт ручную приёмку.
    if (parseBoolSetting(await readAppSetting(c, 'auto_accept_done', true), true)) {
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
  const results = await Promise.all(
    jobs.map((roleCode) =>
      withClient(clientConfig(s), async (c) => {
        const claimed = await claimLlmRoleTask(c, roleCode);
        if (!claimed) return null;
        return processClaimedRole(c, claimed);
      }).catch((error) => {
        // ORCH-BOOT-CLAIM-GRACE-001 (реактивная часть): обрыв СОЕДИНЕНИЯ именно в
        // claim/process — главный источник осиротевших RUNNING-прогонов (claim
        // создан, но финализация порвалась). Фиксируем шторм, чтобы ближайшие тики
        // придержали новые claim'ы, пока БД не стабилизируется, и не плодили новых
        // сирот. Сама ошибка по-прежнему гасится (тик неуспешен по этому слоту, но
        // остальные слоты и предшаги продолжают работать).
        if (isDbConnectionError(error)) noteDbConnectionFailure(opts.now);
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
async function readAppSetting(c, key, fallback) {
  try {
    const r = await c.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

function parseBoolSetting(value, fallback = true) {
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
      : (await c.query('SELECT id FROM roles WHERE code = $1', [nextRoleCode])).rows[0]?.id ?? null;
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
 * FORK-JOIN-001 (Phase 4) — расщепление в узле fork. Родитель (parent_task_id IS
 * NULL), доехавший до узла kind='fork' (current_stage_key), порождает по подзадаче
 * на каждую исходящую ветку и паркуется на парном join в WAITING_FOR_CHILDREN.
 * Идемпотентно: расщепляем только если детей ещё нет. Один txn на родителя.
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
        AND t.parent_task_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN')
        AND NOT EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id)
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
    const card = p.data_card && typeof p.data_card === 'object' ? p.data_card : {};
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
  // (1) Дети на join → DONE.
  const kids = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.parent_task_id IS NOT NULL
        AND t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED')
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

  // (2) Родители на join со всеми терминальными детьми → снять барьер.
  const parents = await c.query(
    `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id, t.current_stage_key, t.data_card
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.parent_task_id IS NULL
        AND t.status = 'WAITING_FOR_CHILDREN'
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
      let merged = p.data_card && typeof p.data_card === 'object' ? { ...p.data_card } : {};
      for (const ch of childRows.rows) {
        if (ch.data_card && typeof ch.data_card === 'object') merged = { ...merged, ...ch.data_card };
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
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, done ? 'TASK_DONE' : 'STATUS_CHANGED', toStatus, p.current_role_id,
         JSON.stringify({ runner: true, reason: 'join_completed', nextStageKey: nextKey })],
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

/**
 * DECOMP-CONTRACT-001 — роллап эпиков декомпозиции. Эпик (task_kind='epic') стоит в
 * WAITING_FOR_CHILDREN, пока его задачи-на-сервис (kind='service') не станут
 * терминальными. Когда все терминальны: если хоть одна BLOCKED/FAILED → эпик
 * BLOCKED; иначе → DONE. Линейный аналог join-барьера (без графа fork/join).
 * Идемпотентно, по одному txn на эпик, FOR UPDATE SKIP LOCKED.
 */
export async function advanceDecompositionParents(c) {
  const parents = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id
       FROM tasks t
      WHERE t.task_kind = 'epic'
        AND t.status = 'WAITING_FOR_CHILDREN'
        AND t.assigned_agent_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id AND ch.task_kind = 'service')
        AND NOT EXISTS (
              SELECT 1 FROM tasks ch
               WHERE ch.parent_task_id = t.id AND ch.task_kind = 'service'
                 AND ch.status NOT IN ('DONE','CANCELLED','BLOCKED','FAILED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  let advanced = 0;
  for (const p of parents.rows) {
    await c.query('BEGIN');
    try {
      const bad = await c.query(
        `SELECT count(*)::int AS n FROM tasks
          WHERE parent_task_id = $1 AND task_kind = 'service' AND status IN ('BLOCKED','FAILED')`,
        [p.id],
      );
      const toStatus = bad.rows[0].n > 0 ? 'BLOCKED' : 'DONE';
      await c.query(
        `UPDATE tasks SET status = $2::task_status, assigned_agent_id = NULL
          WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'`,
        [p.id, toStatus],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, toStatus === 'DONE' ? 'TASK_DONE' : 'TASK_BLOCKED', toStatus, p.current_role_id,
         JSON.stringify({ runner: true, reason: 'epic_rollup', servicesFailed: bad.rows[0].n })],
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
// timeoutMs=0 (стартовая реконсиляция) освобождает назначение немедленно: при
// перезапуске процесса активной сессии Разработчика в полёте уже нет.
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
export async function reapOrphanRunningRuns(c, { ageCheck = false } = {}) {
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
              AND ar.finished_at > COALESCE((
                    SELECT max(ok.finished_at) FROM agent_runs ok
                     WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                       AND ok.status = 'SUCCESS'), '-infinity'::timestamptz)
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
      : (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null;
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
 * Полный перезапуск программы означает, что активных сессий (ни Разработчика,
 * ни рассуждающих ролей) в полёте нет, поэтому немедленно освобождаем:
 *   1) осиротевшие Programmer-назначения (releaseStaleClaudeClaims, timeoutMs=0);
 *   2) повисшие RUNNING agent_runs рассуждающих ролей (reapOrphanRunningRuns) —
 *      иначе они держат слоты «N на роль» до 15-минутного таймаута и очередь
 *      стоит после каждого рестарта.
 * Возвращает число освобождённых Programmer-задач.
 */
export async function reconcileOnStartup(s) {
  return withClient(clientConfig(s), async (c) => {
    await reapOrphanRunningRuns(c);
    return releaseStaleClaudeClaims(c, 0, 'orchestrator_restart_reconcile');
  });
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
        ORDER BY t.priority DESC, t.created_at
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
    : resolveTransition(route, claimed.role_code, decision);
  return finalizeRole(c, claimed, {
    verdict, response: '', exchangeId: null, durationMs: 0, decision, resolved, cardValues: {}, kpi: null,
  });
}

async function processClaimedRole(c, claimed) {
  const route = await loadProjectRoute(c, claimed.project_id);
  // TESTS-GREEN-SKIP-FA-001: аналитик сбоя на задаче с зелёными тестами — пропуск
  // вперёд без вызова модели (см. maybeSkipFailureAnalyst). Делаем это ДО гейта
  // входных полей и тяжёлого tool-loop: пропускаемой задаче они не нужны.
  if (claimed.role_code === 'FAILURE_ANALYST') {
    const skipped = await maybeSkipFailureAnalyst(c, claimed, route);
    if (skipped) return skipped;
  }
  const contract = await loadRoleContract(c, claimed.role_code);
  const card = claimed.data_card && typeof claimed.data_card === 'object' ? claimed.data_card : {};

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
    return failRoleRun(c, claimed, error);
  }

  // SILENT-FAIL-GUARD-001 (B): модель ответила, но без распознаваемого JSON-вердикта
  // (напр. DeepSeek прислал tool-call разметку вместо финального JSON, либо упёрся в
  // инструменты). НЕ считаем это успехом и НЕ продвигаем задачу вперёд — помечаем
  // «не выполнен» (FAILED) с логированием причины, чтобы быстро находить поломку.
  if (result.parsed === null) {
    return failRoleUnparsed(c, claimed, result);
  }

  return applyReasoningVerdict(c, claimed, {
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
  });
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

async function applyReasoningVerdict(c, claimed, { route, contract, verdict, response, exchangeId, durationMs, kpi = null }) {
  const { values: cardValues, missingRequired: missingOut } = extractOutputs(verdict.fields, contract.outputs);
  let decision = decideOutcome(claimed.role_code, verdict, {
    reworkCount: claimed.reworkCount,
    maxRework: MAX_REWORK,
  });
  if (missingOut.length && decision.outcome !== 'BLOCK') {
    decision = { outcome: 'REWORK', agentRunStatus: 'SUCCESS', reason: `missing_outputs:${missingOut.join(',')}` };
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
    if (split.services.length >= 2) {
      return materializeArchitectSplit(c, claimed, {
        verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi, split,
      });
    }
    const ensured = await ensureArchitectService(c, claimed, verdict.fields, cardValues);
    if (ensured.blocked) {
      return blockClaimedReason(c, claimed, ensured.reason, { verdict, cardValues, kpi, event: 'architect_no_service' });
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
  if (claimed.role_code === 'TASK_INTAKE_OFFICER') {
    const dd = verdict.fields?.structured_description ?? cardValues?.structured_description;
    if (typeof dd === 'string' && dd.trim()) setDescription = dd.trim().slice(0, 20000);
    const tt = verdict.fields?.short_title ?? cardValues?.short_title
      ?? verdict.fields?.task_title ?? cardValues?.task_title;
    if (typeof tt === 'string' && tt.trim()) setTitle = tt.trim().slice(0, 300);
  }

  // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (граф-режим);
  // без него — прежняя позиционная маршрутизация (линейные схемы не затронуты).
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision);
  return finalizeRole(c, claimed, {
    verdict, response, exchangeId, durationMs, decision, resolved, cardValues, kpi, setServiceId, setDescription, setTitle,
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

  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) { await c.query('ROLLBACK'); return null; }

    const mergedCard = { ...(cardValues || {}), project: project.code, projectPath: project.root_path };
    const sets = [
      'project_id = $2', 'status = $3::task_status', 'current_role_id = $4',
      'current_stage_key = $5::uuid', 'assigned_agent_id = NULL', 'data_card = data_card || $6::jsonb',
    ];
    const params = [claimed.id, project.id, entry.status, entry.role.id, entry.entryStageKey ?? null,
      JSON.stringify(mergedCard)];
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
  if (cur.rows[0]?.service_id) return { serviceId: undefined };

  const card = {
    ...(claimed.data_card && typeof claimed.data_card === 'object' ? claimed.data_card : {}),
    ...(verdictFields && typeof verdictFields === 'object' ? verdictFields : {}),
    ...(cardValues || {}),
  };
  const plan = normalizeWorkItems(card); // [{ serviceCode, ... }] из work_items/affected_files
  const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
  const byCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
  for (const item of plan) {
    const sid = byCode.get(String(item.serviceCode).toLowerCase());
    if (sid) return { serviceId: sid };
  }
  const attempted = plan.map((p) => p.serviceCode).filter(Boolean);
  return { blocked: true, reason: `architect_no_service:${attempted.join(',') || 'empty'}` };
}

// ARCH-SERVICE-SPLIT-001 — резолвим разбивку Архитектора в РАЗНЫЕ зарегистрированные
// сервисы проекта (регистронезависимо). Источник карточки — data_card задачи + поля
// вердикта Архитектора + cardValues (как в ensureArchitectService). Возвращает
// { card, services:[{ serviceId, serviceCode, title, files }], unresolved:[serviceCode],
// byCode }. services дедуплицированы по serviceId — несколько work_items одного сервиса
// сливаются (файлы объединяются, заголовок берём первый). Только чтение services.
export async function resolveArchitectSplit(c, claimed, verdictFields, cardValues) {
  const card = {
    ...(claimed.data_card && typeof claimed.data_card === 'object' ? claimed.data_card : {}),
    ...(verdictFields && typeof verdictFields === 'object' ? verdictFields : {}),
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
async function blockClaimedReason(c, claimed, reason, { verdict, cardValues, kpi = null, event = 'blocked' } = {}) {
  await c.query('BEGIN');
  try {
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict?.status, summary: verdict?.summary, reason, outcome: 'BLOCK', fields: cardValues,
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

// DECOMP-CONTRACT-001 — материализация декомпозиции эпика в задачи-на-сервис (L1)
// и подзадачи-на-файл (L2). Один txn. Идемпотентно: если у эпика уже есть дети,
// повторно не создаём. Эпик паркуется в WAITING_FOR_CHILDREN. Если из карточки не
// удалось получить ни одного зарегистрированного сервиса — эпик уходит в BLOCKED с
// диагностикой (не молча зависает).
export async function materializeDecomposition(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi = null }) {
  const card = { ...(claimed.data_card && typeof claimed.data_card === 'object' ? claimed.data_card : {}), ...(cardValues || {}) };
  const plan = normalizeWorkItems(card);

  await c.query('BEGIN');
  try {
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

    // Эпик: помечаем видом, паркуем на детях, доливаем карточку Декомпозитора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify(cardValues || {})],
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
    // Идемпотентность: задача уже расщеплена — финализируем прогон без дублей.
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

    // Вход детей в маршрут = FORWARD-переход Архитектора по маршруту проекта. Граф-
    // режим (есть current_stage_key) → целевой узел Programmer (resolveGraphTransition
    // даёт nextStageKey/статус/роль); линейный — resolveTransition (обычно CODING/
    // PROGRAMMER). Дети наследуют этот целевой этап/статус/роль.
    const resolved = claimed.current_stage_key
      ? await resolveGraphTransition(c, claimed, decision)
      : resolveTransition(route, claimed.role_code, decision);
    const childRoleId = resolved.nextRole
      ? (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null
      : null;
    const childStageKey = resolved.nextStageKey ?? null;

    let serviceCount = 0;
    const createdServices = [];
    for (const svc of services) {
      // Карточка ребёнка — карточка родителя (+ поля вердикта Архитектора) с
      // work_items/affected_files, отфильтрованными по ЭТОМУ сервису.
      const childCard = filterCardForService(card, byCode, svc.serviceId);
      const filesText = svc.files
        .map((f) => (f.path ? `- ${f.path}${f.what ? ` — ${f.what}` : ''}` : (f.what ? `- ${f.what}` : '')))
        .filter(Boolean)
        .join('\n');
      const childDescription = `${claimed.description ?? ''}\n\n## Задание для сервиса ${svc.serviceCode}\n${filesText || svc.title}`
        .trim()
        .slice(0, 20000);
      const child = await c.query(
        `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                            status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, 'service', $4, $5, $6::task_status, $7, $8::uuid, 'architect', $9::jsonb)
         RETURNING id`,
        [claimed.project_id, svc.serviceId, claimed.id, svc.title, childDescription,
         resolved.toStatus, childRoleId, childStageKey, JSON.stringify(childCard)],
      );
      const childId = child.rows[0].id;
      serviceCount += 1;
      createdServices.push({ id: childId, serviceCode: svc.serviceCode });
      // Эпик зависит от ребёнка (единица приёмки) — как в materializeDecomposition.
      // Дети друг от друга НЕ зависят: каждый идёт по конвейеру независимо.
      await c.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [claimed.id, childId],
      );
    }

    // Эпик: помечаем видом, паркуем на детях, доливаем поля вердикта Архитектора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify(cardValues || {})],
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
async function finalizeRole(c, claimed, { verdict, response, exchangeId, durationMs, decision, resolved, cardValues = {}, kpi = null, setServiceId, setDescription, setTitle }) {
  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) {
      await c.query('ROLLBACK');
      return null;
    }
    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null;

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
    result: String(input?.result ?? ''),
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map(String) : [],
    // Число проходов (ходов агента) до завершения — скалярная метрика для Монитора.
    // result сериализуется в строку выше, поэтому проходы храним отдельным числом.
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
