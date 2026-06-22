// PIPELINE-STAGE-CONFIG-001 — серверный контракт этапов пайплайна проекта.
// Хранит порядок, активность (enabled) и папку Scanner. Признак Scanner —
// ВСЕГДА код роли SCANNER (не отображаемое имя этапа). Существование папки
// проверяет scanner-service: здесь только синтаксическая проверка абсолютности.
import { withClient, clientConfig } from './db.js';

// Канонический код роли-сканера. Единственный источник признака Scanner.
export const SCANNER_ROLE_CODE = 'SCANNER';

// Стабильные машинные коды ошибок валидации (привязаны к stageId).
export const STAGE_ERROR = {
  NAME_REQUIRED: 'stage_name_required',
  WATCH_DIR_REQUIRED: 'scanner_watch_directory_required',
  WATCH_DIR_ABSOLUTE: 'scanner_watch_directory_must_be_absolute',
  SCANNER_CONFLICT: 'scanner_stage_conflict',
};

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

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

// Этап-сканер определяется наличием кода роли SCANNER среди назначенных ролей.
export function isScannerStage(stage) {
  const codes = Array.isArray(stage?.roleCodes) ? stage.roleCodes : [];
  return codes.includes(SCANNER_ROLE_CODE);
}

/**
 * Чистая валидация набора этапов проекта. Вход — нормализованные этапы
 * { id, name, enabled, roleCodes:[...], watchDirectory|null }.
 * Возвращает массив ошибок [{ stageId, code, message }] (пустой — если ок).
 * Старые данные без enabled читаются вызывающим как enabled:true.
 */
export function validateStages(stages) {
  const list = Array.isArray(stages) ? stages : [];
  const errors = [];
  const enabledScanners = [];

  for (const stage of list) {
    const stageId = stage?.id ?? null;
    const enabled = stage?.enabled !== false; // default true (совместимость со старыми данными)
    const name = String(stage?.name ?? '').trim();
    const watchDirectory = normalizeWatchDirectory(stage?.watchDirectory);

    if (!name) {
      errors.push({ stageId, code: STAGE_ERROR.NAME_REQUIRED, message: 'Укажите название этапа.' });
    }

    if (isScannerStage(stage)) {
      if (enabled) {
        enabledScanners.push(stageId);
        if (!watchDirectory) {
          errors.push({
            stageId,
            code: STAGE_ERROR.WATCH_DIR_REQUIRED,
            message: 'Для включённого этапа Scanner укажите папку для отслеживания.',
          });
        } else if (!isAbsolutePath(watchDirectory)) {
          errors.push({
            stageId,
            code: STAGE_ERROR.WATCH_DIR_ABSOLUTE,
            message: 'Папка Scanner должна быть абсолютным путём.',
          });
        }
      }
      // Отключённый Scanner без папки допустим; папка не очищается (см. save).
    }
  }

  // Один watcher на проект: несколько включённых SCANNER-этапов запрещены.
  if (enabledScanners.length > 1) {
    for (const stageId of enabledScanners) {
      errors.push({
        stageId,
        code: STAGE_ERROR.SCANNER_CONFLICT,
        message: 'Проект поддерживает только один включённый этап Scanner.',
      });
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
  const out = {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    roleIds: roles.map((r) => r.role_id),
    roleCodes: roles.map((r) => r.role_code),
  };
  // scanner-блок показываем только для Scanner-этапа (по коду роли).
  if (out.roleCodes.includes(SCANNER_ROLE_CODE)) {
    out.scanner = { watchDirectory };
  } else if (watchDirectory) {
    // Папка сохранена «про запас» (роль временно не Scanner) — не теряем её.
    out.scanner = { watchDirectory };
  }
  return out;
}

export async function readStages(c, projectDbId) {
  const stages = await c.query(
    `SELECT id, position, name, enabled, watch_directory
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

/** GET — прочитать этапы проекта. Старый этап без enabled читается как true. */
export async function getProjectStages(s, projectId) {
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    return { projectId: projectDbId, stages: await readStages(c, projectDbId) };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Нормализовать сырой массив этапов из запроса в форму записи + провалидировать.
 * Чистая (кроме loadRoleMaps) подготовка: резолвит ссылки на роли, проверяет
 * enabled+SCANNER+watchDirectory. Бросает HTTP 422 при ошибке валидации.
 * Возвращает нормализованные этапы (готовы к saveStagesRows).
 */
export async function normalizeStagesInput(c, rawStages) {
  const list = Array.isArray(rawStages) ? rawStages : [];
  const roleMaps = await loadRoleMaps(c);

  // Нормализация + резолв ролей до валидации.
  const normalized = list.map((stage, index) => {
    const { roleIds, roleCodes } = resolveStageRoles(stage, roleMaps);
    const provided = stage?.id != null ? String(stage.id) : null;
    return {
      id: provided && UUID_RE.test(provided) ? provided : null,
      name: String(stage?.name ?? '').trim(),
      enabled: stage?.enabled !== false,
      position: index,
      // scanner.watchDirectory имеет приоритет; допускаем и плоское поле.
      watchDirectory: normalizeWatchDirectory(stage?.scanner?.watchDirectory ?? stage?.watchDirectory),
      roleIds,
      roleCodes,
    };
  });

  const errors = validateStages(normalized);
  if (errors.length) {
    throw httpError(422, 'stage_validation_failed', { code: 'stage_validation_failed', errors });
  }
  return normalized;
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
      `INSERT INTO project_stages (id, project_id, position, name, enabled, watch_directory)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
       RETURNING id`,
      [stage.id, projectDbId, stage.position, stage.name, stage.enabled, stage.watchDirectory],
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

    await c.query('BEGIN');
    try {
      const saved = await saveStagesRows(c, projectDbId, normalized);
      await c.query('COMMIT');
      return { projectId: projectDbId, stages: saved };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}
