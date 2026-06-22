// Проекты orchestrator_db: привязка локального проекта к БД по папке (root_path).
// Frontend задаёт папку проекта — она и есть ключ связи: задачи проекта в БД
// видны в мониторе именно через эту привязку. Создание идемпотентно по root_path.
import { withClient, clientConfig } from './db.js';

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

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

function mapProject(row) {
  return { id: row.id, code: row.code, name: row.name, rootPath: row.root_path ?? null };
}

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

/**
 * Зарегистрировать/получить проект по папке. Если проект с таким root_path уже
 * есть — вернуть его (имя обновляем, если передано). Иначе создать с авто-кодом.
 * Возвращает { id, code, name, rootPath }.
 */
export async function upsertProjectByPath(s, input) {
  const rootPath = normalizeRootPath(input?.path ?? input?.rootPath);
  if (!rootPath) throw httpError(422, 'project_path_required');
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

// Список проектов БД (для диагностики/связывания). Без тяжёлых данных.
export async function listProjects(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'SELECT id, code, name, root_path FROM projects ORDER BY created_at',
    );
    return { projects: r.rows.map(mapProject) };
  });
}
