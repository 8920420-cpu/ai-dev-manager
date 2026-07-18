// Проекты orchestrator_db: привязка локального проекта к БД по папке (root_path).
// Frontend задаёт папку проекта — она и есть ключ связи: задачи проекта в БД
// видны в мониторе именно через эту привязку. Создание идемпотентно по root_path.
//
// LEGACY-BUSINESS-STORAGE-API-001: модуль расширен rich-CRUD проекта (status,
// database_ref, этапы, глобальные роли, optimistic concurrency по updated_at).
// Основной вход — createOrUpsertProject / listProjectsRich (их зовёт server.js);
// минимальные upsertProjectByPath/listProjects/mapProject удалены как неиспользуемые.
import { withClient, clientConfig } from './db.js';
import { resolveProjectId, readStages } from './stages.js';
import { applySchemeToProject } from './developmentScheme.js';
import { withTransaction } from './transaction.js';

import { httpError } from './httpError.js';

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
    pauseReason: row.pause_reason ?? null,
    // Папка документов проекта («карта» проекта: описание).
    docsPath: row.docs_path ?? null,
    // Папка задач проекта — за ней следит Scanner (приём задач).
    tasksPath: row.tasks_path ?? null,
    // Включён ли автоматический приём задач Scanner из папки документов.
    scannerEnabled: row.scanner_enabled === true,
    stages,
    roles,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// --- DB-слой ----------------------------------------------------------------

const PROJECT_COLUMNS =
  'id, code, name, root_path, status, pause_reason, docs_path, tasks_path, scanner_enabled, created_at, updated_at';

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
  // Папка документов проекта: нормализуем путь; пустое → null.
  if (input?.docsPath !== undefined) {
    out.docs_path = normalizeRootPath(input.docsPath);
  }
  // Папка задач проекта (за ней следит Scanner): нормализуем путь; пустое → null.
  if (input?.tasksPath !== undefined) {
    out.tasks_path = normalizeRootPath(input.tasksPath);
  }
  // Переключатель приёма задач Scanner.
  if (input?.scannerEnabled !== undefined) {
    out.scanner_enabled = input.scannerEnabled === true;
  }
  return out;
}

/**
 * POST /api/projects — создать ИЛИ идемпотентно привязать по root_path.
 * Если проект с таким path уже есть — обновить переданные поля; иначе создать
 * (авто-code). Этапы пайплайна больше НЕ принимаются от клиента: единая «Схема
 * разработки» материализуется в project_stages этого проекта (Scanner-этапу
 * подставляется docs_path). Возврат: RichProject. Обратная совместимость: вход
 * {name,path} монитора задач получает объект с id+rootPath.
 */
export async function createOrUpsertProject(s, input) {
  const rootPath = normalizeRootPath(input?.path ?? input?.rootPath);
  if (!rootPath) throw httpError(422, 'project_path_required', { code: 'project_path_required' });

  const status = input?.status !== undefined ? String(input.status) : undefined;
  if (status !== undefined && !validateStatus(status)) {
    throw httpError(422, 'project_invalid_status', { code: 'project_invalid_status' });
  }

  return withClient(clientConfig(s), async (c) => {
    try {
      return await withTransaction(c, async () => {
      const existing = await c.query(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE root_path = $1`, [rootPath],
      );
      let row;
      let isNew = false;
      if (existing.rowCount) {
        // Обновить только переданные поля.
        const fields = pickProjectFields(input, { partial: true });
        // root_path не трогаем здесь (он и есть ключ привязки).
        delete fields.root_path;
        row = await applyProjectUpdate(c, existing.rows[0].id, fields);
      } else {
        const name = String(input?.name ?? '').trim() || basename(rootPath) || rootPath;
        const code = await uniqueCode(c, name);
        const docsPath = normalizeRootPath(input?.docsPath);
        const tasksPath = normalizeRootPath(input?.tasksPath);
        const ins = await c.query(
          `INSERT INTO projects (code, name, root_path, status, docs_path, tasks_path)
           VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, $6)
           RETURNING ${PROJECT_COLUMNS}`,
          [code, name, rootPath, status ?? null, docsPath, tasksPath],
        );
        row = ins.rows[0];
        isNew = true;
      }

      // Материализуем единую схему: для нового проекта всегда; для существующего —
      // если изменилась папка задач/документов (Scanner следит за папкой задач,
      // с откатом на папку документов, если задачи не заданы).
      if (isNew || input?.tasksPath !== undefined || input?.docsPath !== undefined) {
        await applySchemeToProject(c, row.id, row.tasks_path ?? row.docs_path);
      }

      const rich = await buildRich(c, await reloadRow(c, row.id));
      return rich;
      });
    } catch (error) {
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
 * PUT /api/projects/:id — обновить name/path/status/docsPath/tasksPath.
 * Optimistic concurrency: patch.updatedAt (или If-Match, переданный server.js
 * как input.updatedAt) при несовпадении с текущим updated_at → 409
 * project_conflict. Валидация статуса → 422 project_invalid_status.
 * Этапы пайплайна задаёт единая «Схема разработки» (не проект): при изменении
 * папки задач (или документов) переприменяем схему, чтобы Scanner следил за
 * новой папкой приёма задач.
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

    try {
      return await withTransaction(c, async () => {
      const fields = pickProjectFields(patch, { partial: true });
      const row = await applyProjectUpdate(c, current.id, fields);
      // Папка задач/документов изменилась → Scanner должен следить за новой папкой
      // (приоритет — папка задач, откат на папку документов).
      if (patch?.tasksPath !== undefined || patch?.docsPath !== undefined) {
        await applySchemeToProject(c, row.id, row.tasks_path ?? row.docs_path);
      }
      const rich = await buildRich(c, await reloadRow(c, row.id));
      return rich;
      });
    } catch (error) {
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
    // Снятие паузы (status != paused) очищает причину паузы.
    const fields = String(status) === 'paused'
      ? { status: 'paused' }
      : { status: String(status), pause_reason: null };
    const row = await applyProjectUpdate(c, current.id, fields);
    return buildRich(c, row);
  });
}

/**
 * PATCH /api/projects/:id/scanner — включить/выключить приём задач Scanner.
 * Лёгкое действие с карточки (без токена optimistic concurrency). Возврат: RichProject.
 */
export async function setProjectScanner(s, idOrRef, enabled) {
  return withClient(clientConfig(s), async (c) => {
    const current = await findProjectRow(c, idOrRef);
    if (!current) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
    const row = await applyProjectUpdate(c, current.id, { scanner_enabled: enabled === true });
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
