// Работа с PostgreSQL: проверка подключения, автосоздание БД, миграции, seed.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW, fastForwardHiddenRoles } from './rolePipeline.js';
import { runReasoningRole, decideTransition, decideOutcome, summarizePriorRuns, LLM_ROLE_CODES, MAX_REWORK } from './roleEngine.js';
import { buildRoute, resolveTransition, forwardFrom, routeIsUsable, TERMINAL_STATUSES } from './projectRoute.js';
import { buildGraph, nextNodeKey, forkBranchKeys, nodeByKey } from './graphRoute.js';
import { extractOutputs, missingRequiredInputs } from './fieldsContract.js';
import { buildPipelineClaimContract } from './pipelineDispatch.js';
import { reconcileClockSkew } from './clockGuard.js';

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
        }), toStatus],
      );
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

// Вычислить роль входа и стартовый узел графа для задачи проекта. В граф-схеме
// (есть рёбра) задача стартует на узле с ролью-приёмщиком; в линейной — stageKey
// NULL. Для неразобранной задачи (projectId = null) рёбер нет → stageKey NULL.
async function computeEntry(c, projectId) {
  const role = await entryRole(c);
  if (!projectId) return { role, entryStageKey: null };
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
  return { role, entryStageKey };
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

      const { role, entryStageKey } = await computeEntry(c, project?.id ?? null);
      // Назначенная задача стартует в BACKLOG (runner ведёт её дальше); неразобранная
      // паркуется в BLOCKED и ждёт ручного назначения проекта.
      const status = project ? 'BACKLOG' : 'BLOCKED';
      // Проект кладём в карточку сразу (детерминированно по папке) — Приёмщику не
      // нужно угадывать. Для неразобранной фиксируем, что именно прислал постановщик.
      const dataCard = project
        ? { project: project.code, projectPath: project.root_path }
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
          ...(project ? {} : { reason: 'project_unresolved' }),
        })],
      );
      await c.query('COMMIT');
      return {
        accepted: true, imported: true, duplicate: false, unassigned: !project,
        taskId, externalId: payload.externalId, project: project?.code ?? null,
        service: payload.service, nextRole: role.code,
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
              t.current_stage_key, r.code AS role_code
         FROM tasks t LEFT JOIN roles r ON r.id = t.current_role_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    if (!task.project_id) throw scannerError(409, 'task_without_project');
    if (TERMINAL_STATUSES.has(task.status)) throw scannerError(409, 'task_terminal');
    if (task.status === 'BLOCKED') throw scannerError(409, 'task_blocked_use_manual');

    const route = await loadProjectRoute(c, task.project_id);
    const decision = { outcome: 'FORWARD' };
    const resolved = task.current_stage_key
      ? await resolveGraphTransition(c, task, decision)
      : resolveTransition(route, task.role_code, decision);

    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : (await c.query('SELECT id FROM roles WHERE code = $1', [resolved.nextRole])).rows[0]?.id ?? null;

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
  const reason = String(input?.reason ?? '').trim();
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

    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
              current_stage_key = $4::uuid, assigned_agent_id = NULL, updated_at = now()
        WHERE id = $1`,
      [id, toStatus, stage.role_id ?? null, stage.stage_key ?? null],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [id, task.status, toStatus, stage.role_id ?? null, JSON.stringify({
        source: 'manual', via: 'manual-move', fromStatus: task.status, toStatus,
        targetStage: stage.name ?? null, reason: reason || null,
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
 * подзадачи (WAITING_FOR_CHILDREN), НЕ уже на перезапуске (RESTART) и «не в работе»
 * (свободный слот assigned_agent_id IS NULL). Подзадачи учитываются наравне с
 * верхним уровнем. Каждая такая задача возвращается Приёмщику задач в статусе
 * RESTART (current_role_id = TASK_INTAKE_OFFICER, current_stage_key = вход проекта),
 * под которым claimLlmRoleTask забирает её безусловно. Публичная обёртка над Tx.
 *
 * Перед выборкой освобождаем осиротевшие/просроченные захваты (resetStaleClaims):
 * зависшая сессия отпускает слот, и её задача попадает в перезапуск как «не в работе»,
 * а реально активные задачи сохраняют назначение и не трогаются.
 */
export async function restartStuckTasks(s) {
  return withClient(clientConfig(s), (c) => restartStuckTasksTx(c));
}

export async function restartStuckTasksTx(c) {
  await resetStaleClaims(c);
  await c.query('BEGIN');
  try {
    // Проекты, у которых есть зависшие задачи (вход проекта вычисляем по проекту).
    const projects = await c.query(
      `SELECT DISTINCT project_id FROM tasks
        WHERE project_id IS NOT NULL
          AND assigned_agent_id IS NULL
          AND status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','RESTART')`,
    );
    let restarted = 0;
    for (const row of projects.rows) {
      const { role, entryStageKey } = await computeEntry(c, row.project_id);
      if (!role?.id) continue; // нет роли входа (Приёмщика) — пропускаем проект
      const upd = await c.query(
        `WITH targets AS (
           SELECT id, status::text AS from_status FROM tasks
            WHERE project_id = $1
              AND assigned_agent_id IS NULL
              AND status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','RESTART')
         ), upd AS (
           UPDATE tasks t
              SET status = 'RESTART', current_role_id = $2,
                  current_stage_key = $3::uuid, assigned_agent_id = NULL, updated_at = now()
             FROM targets WHERE t.id = targets.id
           RETURNING t.id
         )
         INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         SELECT targets.id, 'TASK_UPDATED', targets.from_status::task_status, 'RESTART'::task_status, $2,
                jsonb_build_object('source', 'manual-restart', 'reason', 'restart_stuck',
                                   'nextRole', 'TASK_INTAKE_OFFICER')
           FROM targets
         RETURNING task_id`,
        [row.project_id, role.id, entryStageKey],
      );
      restarted += upd.rowCount;
    }
    await c.query('COMMIT');
    return { restarted };
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
  };
}

// SELECT задачи в форме, нужной диспетчеру Scanner (FOR UPDATE — блокируем строку).
const SCANNER_TASK_SELECT = `SELECT t.id, t.status::text AS status, p.id AS project_id,
        p.code AS project_code, s.service_code, rr.id AS reviewer_role_id,
        t.current_role_id, cr.code AS current_role_code
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
export async function claimNextClaudeTask(s) {
  return withClient(clientConfig(s), async (c) => {
    await c.query('BEGIN');
    try {
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
             AND p.status <> 'paused'
           ORDER BY t.priority DESC, t.created_at
           FOR UPDATE OF t SKIP LOCKED
           LIMIT 1
         )
         UPDATE tasks t
            SET assigned_agent_id = (SELECT id FROM agents WHERE code = 'claude_programmer')
           FROM picked
          WHERE t.id = picked.id
          RETURNING t.id, t.title, t.description, t.project_id, t.service_id, t.current_role_id`,
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
  });
}

/**
 * Откат захвата: вернуть задачу в пул, если фидер не смог записать файл.
 * Снимаем назначение агента только с задачи, всё ещё ожидающей кодинга.
 */
export async function releaseClaudeTask(s, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND status = 'CODING'
        RETURNING id`,
      [id],
    );
    return { released: r.rowCount > 0, taskId: id };
  });
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
 * Захватить следующую задачу для host-роли. Аналог claimNextClaudeTask, но для
 * PIPELINE_SERVICE/GIT_INTEGRATOR. Помечает agent_run RUNNING и возвращает
 * контекст для исполнения на хосте (включая changedFiles из события Scanner).
 */
export async function claimNextHostTask(s, roleCode) {
  const role = HOST_ROLES[roleCode];
  if (!role) throw scannerError(422, 'unsupported_host_role');
  return withClient(clientConfig(s), async (c) => {
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
      const run = await c.query(
        `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json)
         VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb) RETURNING id`,
        [t.id, agentId, t.current_role_id, JSON.stringify({ roleCode, host: true })],
      );
      const meta = await c.query(
        `SELECT p.id AS project_id, p.code AS project, p.root_path,
                s.id AS service_id, s.service_code AS service, s.service_name, s.repository_path
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
        [t.id],
      );
      const m = meta.rows[0] ?? {};
      const ev = await c.query(
        `SELECT payload_json FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 12`,
        [t.id],
      );
      const scan = ev.rows.find((r) => r.payload_json && (r.payload_json.changedFiles || r.payload_json.result));

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
      return {
        task: {
          id: t.id,
          role: roleCode,
          title: t.title,
          description: t.description ?? '',
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

// Пары (роль, статус) только для ИИ-ролей: их продвигает runner через вызов
// модели. PIPELINE_SERVICE/GIT_INTEGRATOR исключены — их ведёт host-мост.
const LLM_FLOW_PAIRS = LLM_ROLE_CODES.flatMap((code) =>
  ROLE_FLOW[code].from.map((status) => ({ code, status })),
);

// Захваченная под ролью задача, у которой ИИ-вызов завис, не должна держать
// слот вечно: по таймауту снимаем захват и помечаем прогон TIMEOUT.
const ROLE_TIMEOUT_MS = Number(process.env.RUNNER_ROLE_TIMEOUT_MS || 15 * 60 * 1000);

// Задача, выданная Claude (PROGRAMMER) через файловый мост, помечается
// assigned_agent_id, но НЕ создаёт agent_run RUNNING. Если completion от Claude
// не вернулся (сессия прервалась, Scanner был недоступен, слот очищен без
// доставки), задача навсегда зависает в CODING: фидер её не переподаёт (нужен
// assigned_agent_id IS NULL), а runner роль PROGRAMMER не ведёт. По таймауту
// освобождаем назначение — фидер переподаст её, как только слот освободится.
const CLAUDE_ASSIGN_TIMEOUT_MS = Number(
  process.env.RUNNER_CLAUDE_TIMEOUT_MS || ROLE_TIMEOUT_MS,
);

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
    `SELECT rf.direction, rf.required, f.key
       FROM role_fields rf
       JOIN roles ro ON ro.id = rf.role_id
       JOIN fields f ON f.id = rf.field_id
      WHERE ro.code = $1 ORDER BY rf.position, f.key`,
    [roleCode],
  );
  const out = { inputs: [], outputs: [] };
  for (const row of r.rows) {
    (row.direction === 'in' ? out.inputs : out.outputs).push({ key: row.key, required: row.required !== false });
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
    // Пропускаемые роли (ROLE-GROUPS-001 / per-project) прокручиваются до первой
    // активной роли ДО любого claim — за пропущенные роли не создаётся agent/host run.
    await advanceSkippedStageRoles(c);
    // FORK-JOIN-001: расщепление в fork и снятие барьера в join — до claim, чтобы
    // дети попадали в очередь, а родитель не клеймился на gate-узле.
    await advanceForkNodes(c);
    await advanceJoinNodes(c);
    return computeRoleFreeSlots(c, cap);
  });

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
      }).catch(() => null),
    ),
  );
  return results.filter(Boolean);
}

// RUNNER-CONCURRENCY-001: сколько новых воркеров запускать по каждой ИИ-роли в
// этом тике. free = min(ожидающие задачи, cap − уже в работе). Считаем по всем
// видимым ролям активных проектов одним запросом; роли без ожидающих опускаем.
async function computeRoleFreeSlots(c, cap) {
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
    [LLM_ROLE_CODES],
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

// Лимит параллельных обработок на роль (app_settings.max_concurrency_per_role).
export async function getMaxConcurrencyPerRole(s) {
  return withClient(clientConfig(s), async (c) => {
    const v = await readAppSetting(c, 'max_concurrency_per_role', 3);
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : 3;
  });
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

// Снять зависшие захваты: agent_run RUNNING старше таймаута → TIMEOUT, слот свободен.
async function resetStaleClaims(c) {
  // CLOCK-GUARD-001: до проверки таймаутов компенсируем возможный скачок настенных
  // часов БД/Docker-VM, иначе все прогоны «в полёте» разом гасятся ложным TIMEOUT.
  await reconcileClockSkew(c, { log: (m) => console.log(m) });
  await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, t.status::text AS task_status
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
        WHERE ar.status = 'RUNNING' AND ar.started_at < now() - ($1::bigint * interval '1 millisecond')
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
            jsonb_build_object('runner', true, 'reason', 'role_timeout', 'runStatus', 'TIMEOUT')
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
    [ROLE_TIMEOUT_MS],
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

// RUNNER-STARTUP-REAP-001: при запуске процесса любой agent_run в статусе RUNNING
// заведомо осиротел — горутина-исполнитель прошлого процесса умерла вместе с ним,
// довести вызов до конца некому. Без немедленной зачистки такие прогоны держат
// слоты «N на роль» вплоть до 15-минутного resetStaleClaims, и после каждого
// перезапуска очередь рассуждающих ролей стоит ~15 минут. Гасим их сразу
// (TIMEOUT, слот свободен), задача переигрывается штатно.
async function reapOrphanRunningRuns(c) {
  const r = await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, t.status::text AS task_status
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
        WHERE ar.status = 'RUNNING'
     ), done AS (
       UPDATE agent_runs
          SET status = 'TIMEOUT',
              finished_at = now(),
              error_text = 'orchestrator restarted while run was RUNNING; run was reaped as TIMEOUT',
              output_json = jsonb_build_object('status', 'TIMEOUT', 'reason', 'orchestrator_restart_reconcile')
        WHERE id IN (SELECT id FROM stale)
        RETURNING task_id
     ), freed AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT s.task_id, 'STATUS_CHANGED', s.task_status::task_status, s.task_status::task_status, s.role_id,
            jsonb_build_object('runner', true, 'reason', 'orchestrator_restart_reconcile', 'runStatus', 'TIMEOUT')
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
  );
  return r.rowCount;
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
         JOIN projects p ON p.id = t.project_id
        WHERE t.assigned_agent_id IS NULL
          AND r.hidden = false
          AND p.status <> 'paused'
          AND r.code = ANY($1::text[])
          ${roleFilter}
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
              AND (r.code, t.status::text) IN (VALUES ${valuesSql})
            )
            -- TASK-RESTART-001: перезапущенные задачи Приёмщик забирает БЕЗУСЛОВНО,
            -- даже если у проекта нет этапа с маппингом на этот статус (иначе после
            -- ручного перезапуска они бы снова зависли, как BACKLOG при входе READY).
            OR (r.code = 'TASK_INTAKE_OFFICER' AND t.status::text = 'RESTART')
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
    const run = await c.query(
      `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json)
       VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb) RETURNING id`,
      [task.id, agentId, task.role_id, JSON.stringify({ roleCode: task.role_code, status: task.status })],
    );
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
async function fetchPriorOutputs(c, taskId) {
  const runs = await c.query(
    `SELECT r.code AS role_code, ar.status::text AS status, ar.output_json
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND ar.status = 'SUCCESS' AND ar.output_json IS NOT NULL
      ORDER BY ar.started_at`,
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

// Собрать компактный контекст задачи для промта роли.
async function buildRoleContext(c, claimed) {
  const ev = await c.query(
    `SELECT event_type, from_status::text AS from_status, to_status::text AS to_status, payload_json
       FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [claimed.id],
  );
  const scan = ev.rows.find((r) => r.payload_json && (r.payload_json.changedFiles || r.payload_json.result));
  const meta = await c.query(
    `SELECT p.id AS project_id, p.code AS project, p.root_path, p.docs_path, s.service_code AS service
       FROM tasks t JOIN projects p ON p.id = t.project_id
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
    projectServices: svc.rows.map((r) => r.service_code),
    programmerResult: scan?.payload_json?.result ?? '',
    changedFiles: scan?.payload_json?.changedFiles ?? [],
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
async function processClaimedRole(c, claimed) {
  const route = await loadProjectRoute(c, claimed.project_id);
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

  const { values: cardValues, missingRequired: missingOut } = extractOutputs(result.verdict.fields, contract.outputs);
  let decision = decideOutcome(claimed.role_code, result.verdict, {
    reworkCount: claimed.reworkCount,
    maxRework: MAX_REWORK,
  });
  if (missingOut.length && decision.outcome !== 'BLOCK') {
    decision = { outcome: 'REWORK', agentRunStatus: 'SUCCESS', reason: `missing_outputs:${missingOut.join(',')}` };
  }
  // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (граф-режим);
  // без него — прежняя позиционная маршрутизация (линейные схемы не затронуты).
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision);
  return finalizeRole(c, claimed, { ...result, decision, resolved, cardValues });
}

// Применить переход роли по вердикту в отдельной транзакции.
// resolved — { nextRole, toStatus, done, blocked } из projectRoute.resolveTransition.
// cardValues — заполненные ролью исходящие поля → мердж в кумулятивную карточку.
async function finalizeRole(c, claimed, { verdict, response, exchangeId, durationMs, decision, resolved, cardValues = {} }) {
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

    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
              data_card = data_card || $4::jsonb, current_stage_key = $5::uuid WHERE id = $1`,
      // FORK-JOIN-001: в граф-режиме переносим текущий узел; в линейном — остаётся NULL.
      [claimed.id, resolved.toStatus, nextRoleId, JSON.stringify(cardValues || {}), resolved.nextStageKey ?? null],
    );
    await c.query(
      `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb WHERE id = $1`,
      [claimed.agentRunId, decision.agentRunStatus, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: decision.reason, outcome: decision.outcome, via: resolved.via, fields: cardValues,
      })],
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

// SILENT-FAIL-GUARD-001 (B): реасонинг-роль вернула ответ, но без распознаваемого
// JSON-вердикта. Раньше такой случай молча уходил вперёд как успех (пустые поля).
// Теперь помечаем задачу «не выполнен» (FAILED) и ПОДРОБНО логируем причину в трёх
// местах для быстрой диагностики: agent_runs.error_text + output_json, событие
// STATUS_CHANGED→FAILED с reason, а сырой ответ модели уже лежит в prompt_exchanges.
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
