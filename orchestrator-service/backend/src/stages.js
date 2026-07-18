// PIPELINE-STAGE-CONFIG-001 — серверный контракт этапов пайплайна проекта.
// Хранит порядок, активность (enabled) и папку Scanner. Признак Scanner —
// ВСЕГДА код роли SCANNER (не отображаемое имя этапа). Существование папки
// проверяет scanner-service: здесь только синтаксическая проверка абсолютности.
import { withClient, clientConfig } from './db.js';
import { buildRoute } from './projectRoute.js';
import { validateFieldConsistency } from './fieldsContract.js';
import { roleHasExecutor } from './rolePipeline.js';
import { withTransaction } from './transaction.js';

// Канонический код роли-сканера. Единственный источник признака Scanner.
export const SCANNER_ROLE_CODE = 'SCANNER';

// FORK-JOIN-001: тип узла блок-схемы. 'stage' — обычный этап (роль+статус);
// управляющие узлы fork/join/condition несут логику ветвления, не роль.
export const STAGE_KINDS = new Set(['stage', 'fork', 'join', 'condition']);
export const CONTROL_KINDS = new Set(['fork', 'join', 'condition']);

// Нормализовать тип узла: неизвестное/пустое значение → 'stage'.
export function normalizeKind(value) {
  const k = String(value ?? '').trim().toLowerCase();
  return STAGE_KINDS.has(k) ? k : 'stage';
}

const UUID_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeKey(value) {
  const k = String(value ?? '').trim();
  return UUID_KEY_RE.test(k) ? k : null;
}

// Допустимые значения task_status (зеркало enum task_status в БД). Используются
// и валидацией статуса Scanner-этапа, и фронтендом (через /api контракт).
export const TASK_STATUSES = [
  'BACKLOG', 'READY', 'ARCHITECTURE', 'DECOMPOSITION', 'CODING', 'TESTING',
  'FAILURE_ANALYSIS', 'REVIEW', 'COMMIT', 'DEPLOY', 'DONE', 'BLOCKED',
  'FAILED', 'CANCELLED', 'WAITING_FOR_CHILDREN', 'RESTART',
];
const TASK_STATUS_SET = new Set(TASK_STATUSES);

// Стабильные машинные коды ошибок валидации (привязаны к stageId).
export const STAGE_ERROR = {
  NAME_REQUIRED: 'stage_name_required',
  WATCH_DIR_REQUIRED: 'scanner_watch_directory_required',
  WATCH_DIR_ABSOLUTE: 'scanner_watch_directory_must_be_absolute',
  // Два и более включённых Scanner используют один и тот же статус задач.
  SCANNER_CONFLICT: 'scanner_stage_conflict',
  STATUS_REQUIRED: 'scanner_task_status_required',
  STATUS_INVALID: 'scanner_task_status_invalid',
  ENABLED_REQUIRED: 'stage_enabled_required',
  // PIPELINE-DYNAMIC-ROUTE-001: любой включённый этап с ролями обязан иметь
  // task_status — по нему движок ставит/находит задачу на этом этапе.
  STAGE_STATUS_REQUIRED: 'stage_task_status_required',
  STAGE_STATUS_INVALID: 'stage_task_status_invalid',
  // ROLE-NO-EXECUTOR-001: во включённый этап поставлена роль без исполнителя
  // (нет в ROLE_FLOW/HOST_ROLES/reasoning-ролях) — задачу никто не подхватит.
  ROLE_NO_EXECUTOR: 'stage_role_no_executor',
  CONTROL_ROLE_REQUIRED: 'stage_control_role_required',
};

import { httpError } from './httpError.js';

/**
 * Синтаксическая проверка абсолютного пути (кросс-платформенно): путь может
 * относиться к другой машине или Docker mount, поэтому существование не
 * проверяем. Допускаем Windows-диск (K:\...), UNC (\\host\share) и POSIX (/...).
 */
export function isAbsolutePath(value) {
  const p = String(value ?? '');
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // C:\ или C:/
  if (/^\\\\/.test(p)) return true; // \\server\share (UNC)
  if (/^\/\//.test(p)) return true; // //server/share
  if (/^\//.test(p)) return true; // /home/user (POSIX)
  return false;
}

// Пустая строка/пробелы не считаются значением папки → null.
export function normalizeWatchDirectory(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length ? trimmed : null;
}

// Нормализовать статус задач Scanner-этапа: верхний регистр, пустая строка → null.
// Валидность (членство в enum) проверяет validateStages, а не нормализатор.
export function normalizeTaskStatus(value) {
  const trimmed = String(value ?? '').trim().toUpperCase();
  return trimmed.length ? trimmed : null;
}

// Этап-сканер определяется наличием кода роли SCANNER среди назначенных ролей.
export function isScannerStage(stage) {
  const codes = Array.isArray(stage?.roleCodes) ? stage.roleCodes : [];
  return codes.includes(SCANNER_ROLE_CODE);
}

/**
 * Чистая валидация набора этапов проекта. Вход — нормализованные этапы
 * { id, name, enabled, roleCodes:[...], watchDirectory|null }.
 * Возвращает массив ошибок [{ stageId, code, message }] (пустой — если ок).
 * Контракт enabled строгий: клиент обязан передать boolean true/false.
 */
export function validateStages(stages, { requireScannerWatch = true } = {}) {
  const list = Array.isArray(stages) ? stages : [];
  const errors = [];
  // taskStatus → [stageId,...] среди ВКЛЮЧЁННЫХ Scanner-этапов (для проверки
  // уникальности: один статус не может обслуживаться двумя сканерами сразу).
  const statusUsage = new Map();

  for (const stage of list) {
    const stageId = stage?.id ?? null;
    const hasEnabled = typeof stage?.enabled === 'boolean';
    const enabled = stage?.enabled === true;
    const kind = normalizeKind(stage?.kind);
    const name = String(stage?.name ?? '').trim();
    const watchDirectory = normalizeWatchDirectory(stage?.watchDirectory);
    const taskStatus = normalizeTaskStatus(stage?.taskStatus);

    if (!name) {
      errors.push({ stageId, code: STAGE_ERROR.NAME_REQUIRED, message: 'Укажите название этапа.' });
    }
    if (!hasEnabled) {
      errors.push({ stageId, code: STAGE_ERROR.ENABLED_REQUIRED, message: 'Передайте enabled как true или false.' });
    }

    if (enabled && kind === 'condition' && (!Array.isArray(stage?.roleCodes) || stage.roleCodes.length === 0)) {
      errors.push({
        stageId,
        code: STAGE_ERROR.CONTROL_ROLE_REQUIRED,
        message: 'Condition-этап должен иметь исполнимую роль; иначе задача станет невидимой для runner.',
      });
    }

    if (isScannerStage(stage)) {
      // Формат статуса проверяем всегда (даже у отключённого), чтобы в БД не
      // попало значение вне enum task_status.
      if (taskStatus && !TASK_STATUS_SET.has(taskStatus)) {
        errors.push({
          stageId,
          code: STAGE_ERROR.STATUS_INVALID,
          message: 'Недопустимый статус задач для этапа Scanner.',
        });
      }
      if (enabled) {
        // В единой схеме (requireScannerWatch=false) папку не требуем: она у
        // каждого проекта своя — берётся из projects.docs_path при материализации.
        if (requireScannerWatch && !watchDirectory) {
          errors.push({
            stageId,
            code: STAGE_ERROR.WATCH_DIR_REQUIRED,
            message: 'Для включённого этапа Scanner укажите папку для отслеживания.',
          });
        } else if (watchDirectory && !isAbsolutePath(watchDirectory)) {
          errors.push({
            stageId,
            code: STAGE_ERROR.WATCH_DIR_ABSOLUTE,
            message: 'Папка Scanner должна быть абсолютным путём.',
          });
        }
        if (!taskStatus) {
          errors.push({
            stageId,
            code: STAGE_ERROR.STATUS_REQUIRED,
            message: 'Для включённого этапа Scanner укажите статус задач.',
          });
        } else if (TASK_STATUS_SET.has(taskStatus)) {
          const ids = statusUsage.get(taskStatus) ?? [];
          ids.push(stageId);
          statusUsage.set(taskStatus, ids);
        }
      }
      // Отключённый Scanner без папки/статуса допустим; значения не очищаются.
    } else if (enabled && Array.isArray(stage?.roleCodes) && stage.roleCodes.length) {
      // PIPELINE-DYNAMIC-ROUTE-001: не-Scanner включённый этап с ролями обязан
      // иметь валидный task_status — по нему резолвер маршрута ведёт задачу.
      if (!taskStatus) {
        errors.push({
          stageId,
          code: STAGE_ERROR.STAGE_STATUS_REQUIRED,
          message: 'Для включённого этапа укажите статус задач (task_status).',
        });
      } else if (!TASK_STATUS_SET.has(taskStatus)) {
        errors.push({
          stageId,
          code: STAGE_ERROR.STAGE_STATUS_INVALID,
          message: 'Недопустимый статус задач этапа.',
        });
      }

      // ROLE-NO-EXECUTOR-001: включённый обычный этап (не Scanner, не управляющий
      // узел fork/join/condition) с ролью без исполнителя — задача зависнет, её
      // никто не подхватит. Исполнимость определяет roleHasExecutor (роль ∈
      // ROLE_FLOW). Управляющие узлы несут gate-роли (FORK_GATE/JOIN_GATE),
      // которыми владеют подметатели, а не runner — их не проверяем.
      if (!CONTROL_KINDS.has(kind) || kind === 'condition') {
        for (const roleCode of stage.roleCodes) {
          if (!roleHasExecutor(roleCode)) {
            errors.push({
              stageId,
              code: STAGE_ERROR.ROLE_NO_EXECUTOR,
              message: `Роль «${roleCode}» не имеет исполнителя — задача на этом этапе зависнет. Уберите роль или назначьте ей исполнителя.`,
            });
          }
        }
      }
    }
  }

  // Несколько включённых Scanner на одном статусе → конфликт на каждом из них.
  // (Разные статусы допустимы — это и есть смысл нескольких сканеров.)
  for (const [status, ids] of statusUsage) {
    if (ids.length > 1) {
      for (const stageId of ids) {
        errors.push({
          stageId,
          code: STAGE_ERROR.SCANNER_CONFLICT,
          message: `Несколько включённых этапов Scanner используют один статус задач (${status}).`,
        });
      }
    }
  }

  return errors;
}

// --- DB-слой ---------------------------------------------------------------

// Разрешить :projectId как UUID или как code проекта. 404, если не найден.
export async function resolveProjectId(c, projectId) {
  const ref = String(projectId ?? '').trim();
  if (!ref) throw httpError(422, 'project_id_required');
  const r = await c.query(
    `SELECT id FROM projects
      WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at LIMIT 1`,
    [ref],
  );
  if (!r.rowCount) throw httpError(404, 'project_not_found');
  return r.rows[0].id;
}

// Все роли БД: id↔code (для резолва ссылок и определения SCANNER).
async function loadRoleMaps(c) {
  const r = await c.query('SELECT id, code FROM roles');
  const byId = new Map();
  const byCode = new Map();
  for (const row of r.rows) {
    byId.set(String(row.id), row.code);
    byCode.set(row.code, String(row.id));
  }
  return { byId, byCode };
}

/**
 * Принять ссылки на роли из запроса (roleIds — UUID БД, и/или roleCodes —
 * канонические коды) и вернуть { roleIds:[uuid], roleCodes:[code] },
 * сопоставленные с реальными ролями. Несопоставимые ссылки игнорируются.
 */
function resolveStageRoles(stage, roleMaps) {
  const ids = new Set();
  const codes = new Set();
  for (const ref of Array.isArray(stage?.roleIds) ? stage.roleIds : []) {
    const key = String(ref);
    if (roleMaps.byId.has(key)) {
      ids.add(key);
      codes.add(roleMaps.byId.get(key));
    } else if (roleMaps.byCode.has(key)) {
      ids.add(roleMaps.byCode.get(key));
      codes.add(key);
    }
  }
  for (const code of Array.isArray(stage?.roleCodes) ? stage.roleCodes : []) {
    if (roleMaps.byCode.has(code)) {
      ids.add(roleMaps.byCode.get(code));
      codes.add(code);
    }
  }
  return { roleIds: [...ids], roleCodes: [...codes] };
}

// Контракт ответа одного этапа — ровно те поля, что нужны потребителям.
function stageContract(row, roleRows) {
  const roles = roleRows
    .filter((r) => r.stage_id === row.id)
    .sort((a, b) => a.position - b.position);
  const watchDirectory = normalizeWatchDirectory(row.watch_directory);
  const taskStatus = normalizeTaskStatus(row.task_status);
  const out = {
    id: row.id,
    // FORK-JOIN-001: тип узла + стабильный ключ + пара fork→join.
    kind: row.kind ?? 'stage',
    stageKey: row.stage_key ?? null,
    joinKey: row.join_key ?? null,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    // PIPELINE-DYNAMIC-ROUTE-001: статус этапа доступен у ЛЮБОГО этапа (не только
    // Scanner) — по нему резолвер маршрута ставит статус задачи на этом этапе.
    taskStatus,
    roleIds: roles.map((r) => r.role_id),
    roleCodes: roles.map((r) => r.role_code),
  };
  // scanner-блок показываем только для Scanner-этапа (по коду роли).
  if (out.roleCodes.includes(SCANNER_ROLE_CODE)) {
    out.scanner = { watchDirectory, taskStatus };
  } else if (watchDirectory || taskStatus) {
    // Папка/статус сохранены «про запас» (роль временно не Scanner) — не теряем.
    out.scanner = { watchDirectory, taskStatus };
  }
  return out;
}

export async function readStages(c, projectDbId) {
  const stages = await c.query(
    `SELECT id, position, name, enabled, watch_directory, task_status, kind, stage_key, join_key
       FROM project_stages WHERE project_id = $1 ORDER BY position`,
    [projectDbId],
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT psr.stage_id, psr.role_id, psr.position, r.code AS role_code
       FROM project_stage_roles psr
       JOIN roles r ON r.id = psr.role_id
      WHERE psr.stage_id = ANY($1::uuid[])`,
    [stages.rows.map((s) => s.id)],
  );
  return stages.rows.map((row) => stageContract(row, roles.rows));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Нормализовать сырой массив этапов из запроса в форму записи + провалидировать.
 * Чистая (кроме loadRoleMaps) подготовка: резолвит ссылки на роли, проверяет
 * enabled+SCANNER+watchDirectory. Бросает HTTP 422 при ошибке валидации.
 * Возвращает нормализованные этапы (готовы к saveStagesRows).
 */
export async function normalizeStagesInput(c, rawStages, { requireScannerWatch = true } = {}) {
  const list = Array.isArray(rawStages) ? rawStages : [];
  const roleMaps = await loadRoleMaps(c);

  // Нормализация + резолв ролей до валидации.
  const normalized = list.map((stage, index) => {
    const { roleIds, roleCodes } = resolveStageRoles(stage, roleMaps);
    const provided = stage?.id != null ? String(stage.id) : null;
    return {
      id: provided && UUID_RE.test(provided) ? provided : null,
      // FORK-JOIN-001: тип узла + стабильный ключ + пара fork→join.
      kind: normalizeKind(stage?.kind),
      stageKey: normalizeKey(stage?.stageKey),
      joinKey: normalizeKey(stage?.joinKey),
      name: String(stage?.name ?? '').trim(),
      enabled: stage?.enabled,
      position: index,
      // scanner.watchDirectory имеет приоритет; допускаем и плоское поле.
      watchDirectory: normalizeWatchDirectory(stage?.scanner?.watchDirectory ?? stage?.watchDirectory),
      // Статус задач Scanner-этапа: scanner.taskStatus приоритетнее плоского поля.
      taskStatus: normalizeTaskStatus(stage?.scanner?.taskStatus ?? stage?.taskStatus),
      roleIds,
      roleCodes,
    };
  });

  const errors = validateStages(normalized, { requireScannerWatch });
  if (errors.length) {
    throw httpError(422, 'stage_validation_failed', { code: 'stage_validation_failed', errors });
  }
  // ROLE-FIELD-CONTRACT-001: согласованность полей маршрута. Каждое обязательное
  // входящее поле роли должно производиться более ранней ролью (карточка
  // кумулятивна) или быть seed-полем. Несогласовано → схему сохранить нельзя.
  await assertFieldConsistency(c, normalized);
  return normalized;
}

// Контракты ролей по кодам: Map code → { inputs:[{key,required}], outputs:[...] }.
export async function loadRoleContracts(c, roleCodes) {
  const codes = [...new Set((roleCodes ?? []).filter(Boolean))];
  if (!codes.length) return new Map();
  const r = await c.query(
    `SELECT ro.code, rf.direction, rf.required, rf.position, f.key
       FROM role_fields rf
       JOIN roles ro ON ro.id = rf.role_id
       JOIN fields f ON f.id = rf.field_id
      WHERE ro.code = ANY($1::text[])
      ORDER BY rf.direction, rf.position, f.key`,
    [codes],
  );
  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.code)) map.set(row.code, { inputs: [], outputs: [] });
    const bucket = row.direction === 'in' ? map.get(row.code).inputs : map.get(row.code).outputs;
    bucket.push({ key: row.key, required: row.required !== false });
  }
  return map;
}

// Бросает 422 stage_field_inconsistent с массивом ошибок, если контракты полей
// ролей в порядке этапов несогласованы. role_fields может ещё не существовать
// (миграция не накатана) — тогда проверка молча пропускается (контракт необязателен).
async function assertFieldConsistency(c, normalized) {
  const reg = await c.query("SELECT to_regclass('public.role_fields') AS t");
  if (!reg.rows[0]?.t) return; // таблицы контрактов нет — пропускаем
  const route = buildRoute(normalized).filter((e) => e.stageEnabled);
  if (!route.length) return;
  const contracts = await loadRoleContracts(c, route.map((e) => e.roleCode));
  if (!contracts.size) return; // ни у одной роли нет контракта — сквозной проход
  const errors = validateFieldConsistency(route, contracts);
  if (errors.length) {
    throw httpError(422, 'stage_field_inconsistent', { code: 'stage_field_inconsistent', errors });
  }
}

/**
 * Записать нормализованные этапы в РАМКАХ уже открытой транзакции (без BEGIN/
 * COMMIT). Полная замена набора этапов проекта (project_stages не имеет внешних
 * ссылок из задач — delete+insert безопасен). Возвращает прочитанные этапы.
 * Используется и stages.js (saveProjectStages), и projects.js (общая транзакция).
 */
export async function saveStagesRows(c, projectDbId, normalized) {
  await c.query('DELETE FROM project_stages WHERE project_id = $1', [projectDbId]);
  for (const stage of normalized) {
    const ins = await c.query(
      `INSERT INTO project_stages
         (id, project_id, position, name, enabled, watch_directory, task_status, kind, stage_key, join_key)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::task_status,
               $8, COALESCE($9::uuid, gen_random_uuid()), $10::uuid)
       RETURNING id`,
      [stage.id, projectDbId, stage.position, stage.name, stage.enabled, stage.watchDirectory,
       stage.taskStatus, stage.kind ?? 'stage', stage.stageKey, stage.joinKey ?? null],
    );
    const stageId = ins.rows[0].id;
    let pos = 0;
    for (const roleId of stage.roleIds) {
      await c.query(
        `INSERT INTO project_stage_roles (stage_id, role_id, position) VALUES ($1, $2, $3)
         ON CONFLICT (stage_id, role_id) DO NOTHING`,
        [stageId, roleId, pos++],
      );
    }
  }
  return readStages(c, projectDbId);
}

/**
 * PUT — сохранить (создать/обновить) полный упорядоченный список этапов.
 * Клиент всегда присылает полный список, включая отключённые этапы с их
 * папкой — поэтому отключение/повторное включение не теряет настройки.
 * Валидация enabled+SCANNER+watchDirectory выполняется до записи; при ошибке
 * — HTTP 422 со стабильными кодами, привязанными к stageId, без записи в БД.
 */
export async function saveProjectStages(s, projectId, input) {
  const rawStages = Array.isArray(input?.stages) ? input.stages : [];
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    const normalized = await normalizeStagesInput(c, rawStages);

    return withTransaction(c, async () => {
      const saved = await saveStagesRows(c, projectDbId, normalized);
      return { projectId: projectDbId, stages: saved };
    });
  });
}
