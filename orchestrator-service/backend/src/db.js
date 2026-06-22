// Работа с PostgreSQL: проверка подключения, автосоздание БД, миграции, seed.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW } from './rolePipeline.js';
import { runReasoningRole, decideTransition, summarizePriorRuns, LLM_ROLE_CODES, MAX_REWORK } from './roleEngine.js';

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
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
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
 * Принять завершение от файлового Scanner bridge и передать задачу Task Reviewer.
 * scanner_dispatches и транзакция обеспечивают exactly-once переход на стороне БД.
 */
export async function acceptScannerCompletion(s, input) {
  const payload = normalizeScannerCompletion(input);
  return withClient(clientConfig(s), async (c) => {
    await c.query('BEGIN');
    try {
      // Задачи может не быть в БД (её завели прямо в документе Claude) —
      // тогда Scanner создаёт её (и при необходимости проект/сервис) по
      // координатам completion и продолжает обычный переход к Task Reviewer.
      const { task, created } = await findOrCreateScannerTask(c, payload);
      if (task.project_code !== payload.project) throw scannerError(409, 'project_mismatch');
      if ((task.service_code ?? '') !== payload.service) throw scannerError(409, 'service_mismatch');
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

      await c.query(
        `UPDATE tasks
         SET status = 'REVIEW', current_role_id = $2, assigned_agent_id = NULL
         WHERE id = $1`,
        [payload.taskId, task.reviewer_role_id],
      );
      await c.query(
        `INSERT INTO task_events
           (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'REVIEW', $3, $4::jsonb)`,
        [payload.taskId, task.status, task.reviewer_role_id, JSON.stringify({
          source: 'scanner',
          completionKey: payload.completionKey,
          service: payload.service,
          result: payload.result,
          changedFiles: payload.changedFiles,
        })],
      );
      await c.query('COMMIT');
      return { accepted: true, duplicate: false, autoCreated: created, taskId: payload.taskId, nextRole: 'TASK_REVIEWER' };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

// SELECT задачи в форме, нужной диспетчеру Scanner (FOR UPDATE — блокируем строку).
const SCANNER_TASK_SELECT = `SELECT t.id, t.status::text AS status, p.code AS project_code,
        s.service_code, rr.id AS reviewer_role_id
   FROM tasks t
   JOIN projects p ON p.id = t.project_id
   LEFT JOIN services s ON s.id = t.service_id
   JOIN roles rr ON rr.code = 'TASK_REVIEWER'
  WHERE t.id = $1
  FOR UPDATE OF t`;

/**
 * Найти задачу по id или создать её из completion, если в БД её ещё нет.
 * Новая задача создаётся в статусе CODING под ролью PROGRAMMER (как будто её
 * только что закодил Programmer) с событием TASK_CREATED — дальше обычный
 * переход к Task Reviewer сохраняет связную историю. Проект/сервис создаются
 * при отсутствии. Идемпотентно: ON CONFLICT + повторный SELECT под блокировкой.
 * Возвращает { task, created } (created — была ли задача создана сейчас).
 */
export async function findOrCreateScannerTask(c, payload) {
  const existing = await c.query(SCANNER_TASK_SELECT, [payload.taskId]);
  if (existing.rowCount) return { task: existing.rows[0], created: false };

  const projectId = await ensureProject(c, payload.project);
  const serviceId = await ensureService(c, projectId, payload.service);
  const role = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
  const programmerRoleId = role.rows[0]?.id ?? null;

  const ins = await c.query(
    `INSERT INTO tasks (id, project_id, service_id, title, status, current_role_id, created_by)
     VALUES ($1, $2, $3, $4, 'CODING', $5, 'scanner')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [payload.taskId, projectId, serviceId, payload.title, programmerRoleId],
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

// Найти проект по коду или создать минимальный (code=name). Идемпотентно.
async function ensureProject(c, code) {
  const found = await c.query('SELECT id FROM projects WHERE code = $1', [code]);
  if (found.rowCount) return found.rows[0].id;
  const ins = await c.query(
    `INSERT INTO projects (code, name) VALUES ($1, $1)
     ON CONFLICT (code) DO NOTHING RETURNING id`,
    [code],
  );
  if (ins.rowCount) return ins.rows[0].id;
  const again = await c.query('SELECT id FROM projects WHERE code = $1', [code]);
  return again.rows[0].id;
}

// Найти сервис по (project, service_code) или создать минимальный. Пустой код
// сервиса → null (задача без привязки к сервису). Идемпотентно.
async function ensureService(c, projectId, serviceCode) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const found = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (found.rowCount) return found.rows[0].id;
  const ins = await c.query(
    `INSERT INTO services (project_id, service_code, service_name) VALUES ($1, $2, $2)
     ON CONFLICT (project_id, service_code) DO NOTHING RETURNING id`,
    [projectId, code],
  );
  if (ins.rowCount) return ins.rows[0].id;
  const again = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  return again.rows[0].id;
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
           WHERE r.code = 'PROGRAMMER'
             AND t.status = 'CODING'
             AND t.assigned_agent_id IS NULL
             AND t.service_id IS NOT NULL
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
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'AGENT_ASSIGNED', 'CODING', $2, $3::jsonb)`,
        [row.id, row.current_role_id, JSON.stringify({ target: 'claude-tasks.json', agent: 'claude_programmer' })],
      );
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
          WHERE r.code = $1 AND t.status = $2::task_status AND t.assigned_agent_id IS NULL
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
      const agent = await c.query('SELECT id FROM agents WHERE role_id = $1 ORDER BY created_at LIMIT 1', [t.current_role_id]);
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
        `SELECT p.code AS project, s.service_code AS service, s.repository_path
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
        [t.id],
      );
      const ev = await c.query(
        `SELECT payload_json FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 12`,
        [t.id],
      );
      const scan = ev.rows.find((r) => r.payload_json && (r.payload_json.changedFiles || r.payload_json.result));
      await c.query('COMMIT');
      return {
        task: {
          id: t.id,
          role: roleCode,
          title: t.title,
          description: t.description ?? '',
          project: meta.rows[0]?.project ?? '',
          service: meta.rows[0]?.service ?? '',
          repositoryPath: meta.rows[0]?.repository_path ?? '',
          changedFiles: scan?.payload_json?.changedFiles ?? [],
          programmerResult: scan?.payload_json?.result ?? '',
          agentRunId: run.rows[0].id,
        },
      };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Принять результат host-роли и сделать переход. Для PIPELINE_SERVICE пишет
 * pipeline_runs; success → COMMIT/DOCUMENTATION_AUDITOR, fail → FAILURE_ANALYSIS.
 * Для GIT_INTEGRATOR success → DONE, fail → BLOCKED.
 */
export async function completeHostTask(s, input) {
  const taskId = String(input?.taskId ?? '').trim();
  const roleCode = String(input?.roleCode ?? input?.role ?? '').trim();
  const success = input?.success === true || input?.success === 'true';
  const output = input?.output ?? {};
  if (!taskId) throw scannerError(422, 'taskId_required');
  if (!HOST_ROLES[roleCode]) throw scannerError(422, 'unsupported_host_role');

  return withClient(clientConfig(s), async (c) => {
    await c.query('BEGIN');
    try {
      const found = await c.query(
        `SELECT t.id, t.status::text AS status, t.current_role_id, t.assigned_agent_id,
                r.code AS role_code
           FROM tasks t JOIN roles r ON r.id = t.current_role_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [taskId],
      );
      if (!found.rowCount) throw scannerError(404, 'task_not_found');
      const t = found.rows[0];
      if (t.role_code !== roleCode) throw scannerError(409, 'role_mismatch');

      // Целевой переход.
      let toStatus;
      let nextRole;
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
        toStatus = success ? ROLE_FLOW.PIPELINE_SERVICE.to : 'FAILURE_ANALYSIS';
        nextRole = success ? ROLE_FLOW.PIPELINE_SERVICE.next : 'FAILURE_ANALYST';
      } else {
        // GIT_INTEGRATOR
        toStatus = success ? 'DONE' : 'BLOCKED';
        nextRole = null;
      }

      const nextRoleId = !nextRole
        ? null
        : (await c.query('SELECT id FROM roles WHERE code = $1', [nextRole])).rows[0]?.id ?? null;

      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL WHERE id = $1`,
        [taskId, toStatus, nextRoleId],
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
      return { accepted: true, taskId, toStatus, nextRole };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
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
export async function advanceAutomatedTasks(s, { max = Number(process.env.RUNNER_MAX_PER_TICK || 3) } = {}) {
  return withClient(clientConfig(s), async (c) => {
    await resetStaleClaims(c);
    const applied = [];
    for (let i = 0; i < max; i += 1) {
      const claimed = await claimLlmRoleTask(c);
      if (!claimed) break;
      const step = await processClaimedRole(c, claimed);
      if (step) applied.push(step);
    }
    return applied;
  });
}

// Снять зависшие захваты: agent_run RUNNING старше таймаута → TIMEOUT, слот свободен.
async function resetStaleClaims(c) {
  await c.query(
    `WITH stale AS (
       SELECT id, task_id FROM agent_runs
        WHERE status = 'RUNNING' AND started_at < now() - ($1::bigint * interval '1 millisecond')
     ), done AS (
       UPDATE agent_runs SET status = 'TIMEOUT', finished_at = now()
        WHERE id IN (SELECT id FROM stale)
     )
     UPDATE tasks SET assigned_agent_id = NULL
       WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')`,
    [ROLE_TIMEOUT_MS],
  );
}

// Захватить одну задачу под ИИ-ролью. Возвращает контекст захвата или null.
async function claimLlmRoleTask(c) {
  const valuesSql = LLM_FLOW_PAIRS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  const params = LLM_FLOW_PAIRS.flatMap((p) => [p.code, p.status]);
  await c.query('BEGIN');
  try {
    const picked = await c.query(
      `SELECT t.id, t.title, t.description, t.status::text AS status, r.code AS role_code, r.id AS role_id
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         JOIN (VALUES ${valuesSql}) AS flow(role_code, status)
           ON flow.role_code = r.code AND flow.status = t.status::text
        WHERE t.assigned_agent_id IS NULL
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
    `SELECT p.code AS project, s.service_code AS service
       FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
    [claimed.id],
  );
  const prior = await fetchPriorOutputs(c, claimed.id);
  return {
    taskId: claimed.id,
    title: claimed.title,
    description: claimed.description ?? '',
    status: claimed.status,
    role: claimed.role_code,
    project: meta.rows[0]?.project ?? '',
    service: meta.rows[0]?.service ?? '',
    programmerResult: scan?.payload_json?.result ?? '',
    changedFiles: scan?.payload_json?.changedFiles ?? [],
    priorRoleOutputs: prior.priorRoleOutputs,
    lastReview: prior.lastReview,
    recentEvents: ev.rows.slice(0, 8).map((r) => ({ type: r.event_type, from: r.from_status, to: r.to_status })),
  };
}

// Прогон одной захваченной роли: вызов ИИ (вне транзакции) → финализация.
async function processClaimedRole(c, claimed) {
  const context = await buildRoleContext(c, claimed);
  let result;
  try {
    result = await runReasoningRole(c, { roleCode: claimed.role_code, context });
  } catch (error) {
    return failRoleRun(c, claimed, error);
  }
  const decision = decideTransition(claimed.role_code, result.verdict, {
    reworkCount: claimed.reworkCount,
    maxRework: MAX_REWORK,
  });
  return finalizeRole(c, claimed, { ...result, decision });
}

// Применить переход роли по вердикту в отдельной транзакции.
async function finalizeRole(c, claimed, { verdict, response, exchangeId, durationMs, decision }) {
  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) {
      await c.query('ROLLBACK');
      return null;
    }
    const nextRoleId = decision.done || !decision.nextRole
      ? null
      : (await c.query('SELECT id FROM roles WHERE code = $1', [decision.nextRole])).rows[0]?.id ?? null;

    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL WHERE id = $1`,
      [claimed.id, decision.toStatus, nextRoleId],
    );
    await c.query(
      `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb WHERE id = $1`,
      [claimed.agentRunId, decision.agentRunStatus, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings, reason: decision.reason,
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
        decision.done ? 'TASK_DONE' : 'STATUS_CHANGED',
        claimed.status,
        decision.toStatus,
        claimed.role_id,
        JSON.stringify({
          runner: true, ai: true, role: claimed.role_code, verdictStatus: verdict.status,
          summary: verdict.summary, nextRole: decision.nextRole, exchangeId,
        }),
      ],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id,
      fromRole: claimed.role_code,
      fromStatus: claimed.status,
      toStatus: decision.toStatus,
      nextRole: decision.nextRole,
      verdict: verdict.status,
      durationMs,
    };
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
  };
}

function scannerError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
