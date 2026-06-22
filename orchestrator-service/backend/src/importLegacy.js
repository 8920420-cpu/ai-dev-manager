// LEGACY-BUSINESS-STORAGE-API-001 — идемпотентный импорт legacy-данных из
// localStorage фронтенда. Перенос проектов, доп. БД и назначений «роль→коннектор».
// Идемпотентность по естественным ключам: проект по нормализованному path, доп.БД
// по name+host+database, назначение по roleCode. Существующее → в conflict, НЕ
// перезаписывается молча. Секреты (пароли) из импорта НЕ принимаются.
import { withClient, clientConfig } from './db.js';
import { normalizeRootPath, basename, slugifyCode } from './projects.js';

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

// Естественные ключи (нормализованные) для дедупа/сопоставления с существующим.
export function projectKey(item) {
  return normalizeRootPath(item?.path ?? item?.rootPath) ?? '';
}
export function additionalDbKey(item) {
  const n = String(item?.name ?? '').trim().toLowerCase();
  const h = String(item?.host ?? '').trim().toLowerCase();
  const d = String(item?.database ?? '').trim().toLowerCase();
  return `${n}|${h}|${d}`;
}
export function roleConnectorKey(item) {
  return String(item?.roleCode ?? '').trim();
}

/**
 * ЧИСТАЯ функция планирования импорта одной коллекции. Тщательно тестируется.
 * Вход:
 *   existing — Set ключей, уже присутствующих в БД (по естественному ключу);
 *   incoming — массив входных элементов;
 *   keyOf    — функция извлечения естественного ключа из элемента.
 * Логика:
 *   - пустой ключ → skip (некорректная запись, нечего импортировать);
 *   - дубликат внутри incoming (ключ уже встречался) → skip (дедуп);
 *   - ключ уже есть в existing → conflict (НЕ перезаписываем существующее);
 *   - иначе → create.
 * Возвращает { create:[item], conflict:[{key,item}], skip:[{key,item,reason}] }.
 * Повторный импорт (когда всё уже создано) → всё в conflict, create пуст.
 */
export function planImport({ existing, incoming, keyOf }) {
  const have = existing instanceof Set ? existing : new Set(existing ?? []);
  const seen = new Set();
  const create = [];
  const conflict = [];
  const skip = [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = keyOf(item);
    if (!key) {
      skip.push({ key, item, reason: 'missing_key' });
      continue;
    }
    if (seen.has(key)) {
      skip.push({ key, item, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(key);
    if (have.has(key)) {
      conflict.push({ key, item });
      continue;
    }
    create.push({ key, item });
  }
  return { create, conflict, skip };
}

/**
 * POST /api/import/legacy — перенос данных из localStorage. dryRun:true → только
 * план, ничего не пишет. Идемпотентно: повторный импорт не дублирует и не
 * перезаписывает (конфликты → conflicts). Секреты НЕ принимаются.
 * Возврат: { migrationKey, dryRun, created:{...counts}, conflicts:[...], skipped:[...] }.
 */
export async function importLegacy(s, body) {
  const migrationKey = String(body?.migrationKey ?? '').trim();
  if (!migrationKey) throw httpError(422, 'migration_key_required', { code: 'migration_key_required' });
  const dryRun = body?.dryRun === true;

  const projects = Array.isArray(body?.projects) ? body.projects : [];
  const additionalDatabases = Array.isArray(body?.additionalDatabases) ? body.additionalDatabases : [];
  const roleConnectors = Array.isArray(body?.roleConnectors) ? body.roleConnectors : [];

  return withClient(clientConfig(s), async (c) => {
    // Существующие ключи в БД.
    const projRows = await c.query('SELECT root_path FROM projects WHERE root_path IS NOT NULL');
    const existingProjects = new Set(
      projRows.rows.map((r) => normalizeRootPath(r.root_path)).filter(Boolean),
    );
    const dbRows = await c.query('SELECT name, host, database FROM additional_databases');
    const existingDbs = new Set(dbRows.rows.map((r) => additionalDbKey(r)));
    const rcRows = await c.query('SELECT role_code FROM role_connectors');
    const existingRc = new Set(rcRows.rows.map((r) => r.role_code));
    const validRoleCodes = new Set((await c.query('SELECT code FROM roles')).rows.map((r) => r.code));
    const validConnectorIds = new Set(
      (await c.query('SELECT id::text AS id FROM connectors')).rows.map((r) => r.id),
    );

    const planProjects = planImport({ existing: existingProjects, incoming: projects, keyOf: projectKey });
    const planDbs = planImport({ existing: existingDbs, incoming: additionalDatabases, keyOf: additionalDbKey });
    const planRc = planImport({ existing: existingRc, incoming: roleConnectors, keyOf: roleConnectorKey });

    const conflicts = [
      ...planProjects.conflict.map((x) => ({ kind: 'project', key: x.key })),
      ...planDbs.conflict.map((x) => ({ kind: 'additionalDatabase', key: x.key })),
      ...planRc.conflict.map((x) => ({ kind: 'roleConnector', key: x.key })),
    ];
    const skipped = [
      ...planProjects.skip.map((x) => ({ kind: 'project', key: x.key, reason: x.reason })),
      ...planDbs.skip.map((x) => ({ kind: 'additionalDatabase', key: x.key, reason: x.reason })),
      ...planRc.skip.map((x) => ({ kind: 'roleConnector', key: x.key, reason: x.reason })),
    ];
    const counts = {
      projects: planProjects.create.length,
      additionalDatabases: planDbs.create.length,
      roleConnectors: planRc.create.length,
    };

    if (dryRun) {
      return { migrationKey, dryRun: true, created: counts, conflicts, skipped };
    }

    await c.query('BEGIN');
    try {
      // Проекты — создаём только новые (по path). Секреты неприменимы.
      for (const { key, item } of planProjects.create) {
        const name = String(item?.name ?? '').trim() || basename(key) || key;
        const code = await uniqueCode(c, name);
        const status = item?.status && ['active', 'paused', 'draft', 'archived'].includes(String(item.status))
          ? String(item.status) : 'active';
        const databaseRef = item?.databaseId == null || item.databaseId === '' ? null : String(item.databaseId);
        await c.query(
          `INSERT INTO projects (code, name, root_path, status, database_ref)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (root_path) DO NOTHING`,
          [code, name, key, status, databaseRef],
        );
      }
      // Доп. БД — создаём без секрета (secret НЕ принимается из импорта).
      for (const { item } of planDbs.create) {
        await c.query(
          `INSERT INTO additional_databases (name, host, port, database, db_user, ssl_mode, secret)
           VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
          [
            String(item?.name ?? '').trim(),
            String(item?.host ?? '').trim(),
            Number(item?.port) || 5432,
            String(item?.database ?? '').trim(),
            String(item?.user ?? '').trim(),
            String(item?.sslMode ?? 'disable').trim() || 'disable',
          ],
        );
      }
      // Назначения роль→коннектор — только валидные и новые.
      for (const { key, item } of planRc.create) {
        if (!validRoleCodes.has(key)) continue; // невалидную роль молча пропускаем
        const rawId = item?.connectorId;
        const connectorId = rawId == null || rawId === '' ? null : String(rawId);
        if (connectorId !== null && !validConnectorIds.has(connectorId)) continue;
        await c.query(
          `INSERT INTO role_connectors (role_code, connector_id, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (role_code) DO NOTHING`,
          [key, connectorId],
        );
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }

    return { migrationKey, dryRun: false, created: counts, conflicts, skipped };
  });
}

// Локальная копия подбора свободного кода (как в projects.js) — чтобы не
// расширять публичный API projects.js. Идемпотентность импорта обеспечивает
// уникальность path, а code лишь должен быть свободен.
async function uniqueCode(c, base) {
  const root = slugifyCode(base);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? root : `${root}_${i + 1}`;
    const ex = await c.query('SELECT 1 FROM projects WHERE code = $1', [candidate]);
    if (!ex.rowCount) return candidate;
  }
  return `${root}_${Date.now()}`;
}
