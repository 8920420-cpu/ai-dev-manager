// Проекты orchestrator_db: привязка локального проекта к БД по папке (root_path).
// Frontend задаёт папку проекта — она и есть ключ связи: задачи проекта в БД
// видны в мониторе именно через эту привязку. Создание идемпотентно по root_path.
//
// LEGACY-BUSINESS-STORAGE-API-001: модуль расширен rich-CRUD проекта (status,
// database_ref, этапы, глобальные роли, optimistic concurrency по updated_at).
// Существующие экспортируемые функции (upsertProjectByPath/listProjects и helpers)
// СОХРАНЕНЫ — их зовёт server.js и монитор задач.
import { withClient, clientConfig } from './db.js';
import {
  resolveProjectId,
  readStages,
  normalizeStagesInput,
  saveStagesRows,
} from './stages.js';

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

// Допустимые статусы жизненного цикла проекта (как в CHECK-ограничении 0008).
export const PROJECT_STATUSES = ['active', 'paused', 'draft', 'archived'];

// Нормализация пути для хранения/сравнения: трим + срез завершающего слеша.
export function normalizeRootPath(value) {
  let p = String(value ?? '').trim();
  if (!p) return null;
  p = p.replace(/[\\/]+$/, ''); // убрать хвостовой / или \
  return p.length ? p : null;
}

// Базовое имя папки (для авто-кода, если имя не задано). Поддерживает \ и /.
export function basename(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// Стабильный машинный код из имени/папки: A-Z0-9_, без пустот.
export function slugifyCode(base) {
  const slug = String(base ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'PROJECT';
}

// --- ЧИСТЫЕ helpers (тестируются без БД) -----------------------------------

// Валидность статуса проекта. Пустой/undefined считаем «не задан» — невалидно
// здесь возвращаем только для непустых неизвестных значений.
export function validateStatus(status) {
  return PROJECT_STATUSES.includes(status);
}

// ISO-представление метки времени (для токена optimistic concurrency и ответов).
function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * Конфликт optimistic concurrency: клиент прислал updatedAt (If-Match), но он не
 * совпадает с текущим в БД. Если клиент не прислал токен (null/undefined/'') —
 * конфликта нет (проверку пропускаем). Сравнение по момент времени (мс), чтобы
 * '2020-01-01T00:00:00.000Z' == '2020-01-01T00:00:00Z'.
 */
export function isConcurrencyConflict(provided, current) {
  if (provided == null || provided === '') return false;
  const a = new Date(provided).getTime();
  const b = new Date(current).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return String(provided) !== String(current);
  return a !== b;
}

/**
 * Маппинг строки projects (+ подгруженные stages/roles) в rich-контракт.
 * path = root_path; databaseId = database_ref; rootPath — алиас для обратной
 * совместимости со старым dbProjectsApi.
 */
export function mapProjectRow(row, { stages = [], roles = [] } = {}) {
  const path = row.root_path ?? null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    path,
    rootPath: path, // алиас совместимости
    status: row.status ?? 'active',
    databaseId: row.database_ref ?? null,
    stages,
    roles,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// Минимальный контракт (как раньше: id, code, name, rootPath) — для совместимости
// там, где rich-данные не нужны/не подгружены.
function mapProject(row) {
  return { id: row.id, code: row.code, name: row.name, rootPath: row.root_path ?? null };
}

// --- DB-слой ----------------------------------------------------------------

const PROJECT_COLUMNS =
  'id, code, name, root_path, status, database_ref, created_at, updated_at';

// Подобрать свободный code: SLUG, затем SLUG_2, SLUG_3, …
async function uniqueCode(c, base) {
  const root = slugifyCode(base);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? root : `${root}_${i + 1}`;
    const ex = await c.query('SELECT 1 FROM projects WHERE code = $1', [candidate]);
    if (!ex.rowCount) return candidate;
  }
  return `${root}_${Date.now()}`;
}

// Глобальные роли пайплайна (таблица roles) — единый источник истины для UI.
async function loadGlobalRoles(c) {
  const r = await c.query('SELECT id, code, name FROM roles ORDER BY code');
  return r.rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
}

// Прочитать строку проекта по uuid | code | root_path | name. null, если нет.
async function findProjectRow(c, idOrRef) {
  const ref = String(idOrRef ?? '').trim();
  if (!ref) return null;
  const r = await c.query(
    `SELECT ${PROJECT_COLUMNS} FROM projects
      WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at LIMIT 1`,
    [ref],
  );
  return r.rowCount ? r.rows[0] : null;
}

// Собрать rich-контракт по строке проекта (подгружает stages + глобальные роли).
async function buildRich(c, row) {
  const [stages, roles] = await Promise.all([
    readStages(c, row.id),
    loadGlobalRoles(c),
  ]);
  return mapProjectRow(row, { stages, roles });
}

/**
 * Зарегистрировать/получить проект по папке. Если проект с таким root_path уже
 * есть — вернуть его (имя обновляем, если передано). Иначе создать с авто-кодом.
 * СОХРАНЕНА для обратной совместимости (минимальный контракт { id, code, name,
 * rootPath }). Rich-вход/выход обслуживает createOrUpsertProject.
 */
export async function upsertProjectByPath(s, input) {
  const rootPath = normalizeRootPath(input?.path ?? input?.rootPath);
  if (!rootPath) throw httpError(422, 'project_path_required', { code: 'project_path_required' });
  const name = String(input?.name ?? '').trim() || basename(rootPath) || rootPath;
  return withClient(clientConfig(s), async (c) => {
    const existing = await c.query(
      'SELECT id, code, name, root_path FROM projects WHERE root_path = $1', [rootPath],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (input?.name && name !== row.name) {
        const upd = await c.query(
          'UPDATE projects SET name = $2 WHERE id = $1 RETURNING id, code, name, root_path',
          [row.id, name],
        );
        return mapProject(upd.rows[0]);
      }
      return mapProject(row);
    }
    const code = await uniqueCode(c, name);
    try {
      const ins = await c.query(
        `INSERT INTO projects (code, name, root_path) VALUES ($1, $2, $3)
         RETURNING id, code, name, root_path`,
        [code, name, rootPath],
      );
      return mapProject(ins.rows[0]);
    } catch (e) {
      // Гонка: параллельная регистрация той же папки/кода — вернуть существующий.
      if (e.code === '23505') {
        const again = await c.query(
          'SELECT id, code, name, root_path FROM projects WHERE root_path = $1', [rootPath],
        );
        if (again.rowCount) return mapProject(again.rows[0]);
      }
      throw e;
    }
  });
}

// Список проектов БД (минимальный контракт) — оставлен как был (диагностика).
export async function listProjects(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'SELECT id, code, name, root_path FROM projects ORDER BY created_at',
    );
    return { projects: r.rows.map(mapProject) };
  });
}

/** GET /api/projects (rich) — список проектов с path и rootPath-алиасом. */
export async function listProjectsRich(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at`);
    const roles = await loadGlobalRoles(c);
    const projects = [];
    for (const row of r.rows) {
      const stages = await readStages(c, row.id);
      projects.push(mapProjectRow(row, { stages, roles }));
    }
    return { projects };
  });
}

/** GET /api/projects/:id (rich). :id — uuid | code | root_path | name. */
export async function getProject(s, idOrRef) {
  return withClient(clientConfig(s), async (c) => {
    const row = await findProjectRow(c, idOrRef);
    if (!row) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
    return buildRich(c, row);
  });
}

// Поля проекта, разрешённые к записи, из patch (нормализация). partial=true для
// PUT/PATCH (обновляем только переданные ключи).
function pickProjectFields(input, { partial }) {
  const out = {};
  if (!partial || input?.name !== undefined) {
    const name = String(input?.name ?? '').trim();
    if (name) out.name = name;
  }
  if (!partial || input?.path !== undefined || input?.rootPath !== undefined) {
    const path = normalizeRootPath(input?.path ?? input?.rootPath);
    if (path) out.root_path = path;
  }
  if (!partial || input?.status !== undefined) {
    if (input?.status !== undefined) out.status = String(input.status);
  }
  if (input?.databaseId !== undefined) {
    const v = input.databaseId;
    out.database_ref = v === null || v === '' ? null : String(v);
  }
  return out;
}

/**
 * POST /api/projects — создать ИЛИ идемпотентно привязать по root_path.
 * Если проект с таким path уже есть — обновить переданные поля; иначе создать
 * (авто-code). stages (если переданы) сохраняются той же валидацией в общей
 * транзакции. Возврат: RichProject (с id и rootPath). Обратная совместимость:
 * вход {name,path} монитора задач получает объект с id+rootPath.
 */
export async function createOrUpsertProject(s, input) {
  const rootPath = normalizeRootPath(input?.path ?? input?.rootPath);
  if (!rootPath) throw httpError(422, 'project_path_required', { code: 'project_path_required' });

  const status = input?.status !== undefined ? String(input.status) : undefined;
  if (status !== undefined && !validateStatus(status)) {
    throw httpError(422, 'project_invalid_status', { code: 'project_invalid_status' });
  }

  return withClient(clientConfig(s), async (c) => {
    // Нормализуем этапы (с валидацией) ДО транзакции записи, чтобы при ошибке
    // ничего не писать. resolveProjectId здесь не нужен — проект может ещё не быть.
    const hasStages = Array.isArray(input?.stages);
    const normalizedStages = hasStages ? await normalizeStagesInput(c, input.stages) : null;

    await c.query('BEGIN');
    try {
      const existing = await c.query(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE root_path = $1`, [rootPath],
      );
      let row;
      if (existing.rowCount) {
        // Обновить только переданные поля.
        const fields = pickProjectFields(input, { partial: true });
        // root_path не трогаем здесь (он и есть ключ привязки).
        delete fields.root_path;
        row = await applyProjectUpdate(c, existing.rows[0].id, fields);
      } else {
        const name = String(input?.name ?? '').trim() || basename(rootPath) || rootPath;
        const code = await uniqueCode(c, name);
        const ins = await c.query(
          `INSERT INTO projects (code, name, root_path, status, database_ref)
           VALUES ($1, $2, $3, COALESCE($4, 'active'), $5)
           RETURNING ${PROJECT_COLUMNS}`,
          [code, name, rootPath, status ?? null,
           input?.databaseId === undefined ? null : (input.databaseId || null)],
        );
        row = ins.rows[0];
      }

      if (hasStages) {
        await saveStagesRows(c, row.id, normalizedStages);
      }

      const rich = await buildRich(c, await reloadRow(c, row.id));
      await c.query('COMMIT');
      return rich;
    } catch (error) {
      await c.query('ROLLBACK');
      // Гонка по root_path/code при параллельном создании.
      if (error.code === '23505') {
        return getProject(s, rootPath);
      }
      throw error;
    }
  });
}

// Применить UPDATE проекта по карте полей. Пустая карта → строка не меняется
// (но updated_at триггер срабатывает только при реальном UPDATE — поэтому при
// пустой карте просто перечитываем). Возвращает свежую строку.
async function applyProjectUpdate(c, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return reloadRow(c, id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const params = [id, ...keys.map((k) => fields[k])];
  const r = await c.query(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING ${PROJECT_COLUMNS}`,
    params,
  );
  return r.rows[0];
}

async function reloadRow(c, id) {
  const r = await c.query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [id]);
  if (!r.rowCount) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
  return r.rows[0];
}

/**
 * PUT /api/projects/:id — обновить name/path/status/databaseId/stages/roles.
 * Optimistic concurrency: patch.updatedAt (или If-Match, переданный server.js
 * как input.updatedAt) при несовпадении с текущим updated_at → 409
 * project_conflict. Валидация статуса → 422 project_invalid_status.
 * roles в проекте — глобальные (read-only), поэтому patch.roles игнорируется
 * как набор данных проекта (это не отклонение: контракт описывает roles как
 * ГЛОБАЛЬНЫЕ; назначение ролей этапам идёт через stages.roleCodes).
 */
export async function updateProject(s, idOrRef, patch) {
  const status = patch?.status !== undefined ? String(patch.status) : undefined;
  if (status !== undefined && !validateStatus(status)) {
    throw httpError(422, 'project_invalid_status', { code: 'project_invalid_status' });
  }
  const provided = patch?.updatedAt ?? patch?.ifMatch ?? null;

  return withClient(clientConfig(s), async (c) => {
    const current = await findProjectRow(c, idOrRef);
    if (!current) throw httpError(404, 'project_not_found', { code: 'project_not_found' });

    if (isConcurrencyConflict(provided, current.updated_at)) {
      throw httpError(409, 'project_conflict', { code: 'project_conflict' });
    }

    const hasStages = Array.isArray(patch?.stages);
    const normalizedStages = hasStages ? await normalizeStagesInput(c, patch.stages) : null;

    await c.query('BEGIN');
    try {
      const fields = pickProjectFields(patch, { partial: true });
      const row = await applyProjectUpdate(c, current.id, fields);
      if (hasStages) await saveStagesRows(c, row.id, normalizedStages);
      const rich = await buildRich(c, await reloadRow(c, row.id));
      await c.query('COMMIT');
      return rich;
    } catch (error) {
      await c.query('ROLLBACK');
      if (error.code === '23505') {
        throw httpError(409, 'project_conflict', { code: 'project_conflict' });
      }
      throw error;
    }
  });
}

/** PATCH /api/projects/:id/status — сменить только статус. Возврат: RichProject. */
export async function setProjectStatus(s, idOrRef, status) {
  if (!validateStatus(String(status))) {
    throw httpError(422, 'project_invalid_status', { code: 'project_invalid_status' });
  }
  return withClient(clientConfig(s), async (c) => {
    const current = await findProjectRow(c, idOrRef);
    if (!current) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
    const row = await applyProjectUpdate(c, current.id, { status: String(status) });
    return buildRich(c, row);
  });
}

/** DELETE /api/projects/:id — удалить проект (CASCADE удаляет этапы). */
export async function deleteProject(s, idOrRef) {
  return withClient(clientConfig(s), async (c) => {
    const current = await findProjectRow(c, idOrRef);
    if (!current) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
    await c.query('DELETE FROM projects WHERE id = $1', [current.id]);
    return { deleted: true };
  });
}
