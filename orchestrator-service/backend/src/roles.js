// ROLE-CONFIGURATION-001 (ORCHESTRATOR-P1.5) — серверная карточка роли.
//
// Расширяет модель роли полями description, prompt, skills и hidden и даёт:
//   * CRUD-чтение/обновление карточки роли (GET/PUT /api/roles[/:code]);
//   * список доступных skill-файлов (GET /api/skills) строго внутри
//     настроенного каталога skills (path traversal запрещён);
//   * сборку рабочего system-промта роли = prompt (из БД) + содержимое
//     подключённых skills в зафиксированном порядке.
//
// Идентичность роли — её `code`. hidden — глобальная настройка роли (не удаляет
// роль из этапов). Пропуск скрытых ролей в маршруте реализован в db.js на основе
// чистого fastForwardHiddenRoles из rolePipeline.js.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient, clientConfig } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Каталог доступных skill-файлов. По умолчанию — skills/ в корне репозитория
// (в Docker — /app/skills через ENV). Отсутствие каталога не ошибка: список пуст.
export const SKILLS_DIR =
  process.env.ORCHESTRATOR_SKILLS_DIR || resolve(__dirname, '../../../skills');

// Разрешённые расширения skill-файлов.
const SKILL_EXTENSIONS = new Set(['.md', '.txt']);

// Лимиты полей карточки роли (защита от раздувания и мусора).
export const ROLE_FIELD_LIMITS = {
  description: 2000,
  prompt: 100000,
  skillPath: 512,
  skillsCount: 50,
};

// Предел размера содержимого skill-файла, загружаемого с ПК (символы).
export const SKILL_UPLOAD_LIMIT = 500000;

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  if (extra) Object.assign(error, extra);
  return error;
}

// --- Чистые функции (без БД и сети) — покрыты юнит-тестами -------------------

/**
 * Привести относительный skill-путь к каноническому виду с прямыми слэшами.
 * Возвращает '' для пустого/недопустимого значения.
 */
export function canonicalSkillId(rawPath) {
  const raw = String(rawPath ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  // Срезаем ведущие './' и слэши; '..' недопустим (см. isSkillPathAllowed).
  return raw.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Безопасен ли skill-путь: относительный, без выхода за каталог skills, с
 * разрешённым расширением. Не обращается к ФС (проверка существования — отдельно).
 */
export function isSkillPathAllowed(rawPath) {
  const id = canonicalSkillId(rawPath);
  if (!id) return false;
  if (id.length > ROLE_FIELD_LIMITS.skillPath) return false;
  if (id.includes('\0')) return false;
  // Запрет абсолютных путей и traversal.
  if (/^[a-zA-Z]:/.test(id) || id.startsWith('/')) return false;
  const segments = id.split('/');
  if (segments.some((s) => s === '..' || s === '')) return false;
  if (!SKILL_EXTENSIONS.has(extname(id).toLowerCase())) return false;
  return true;
}

/**
 * Абсолютный путь к skill внутри SKILLS_DIR или null, если путь недопустим/
 * выходит за каталог. dir переопределяется в тестах.
 */
export function resolveSkillPath(rawPath, { dir = SKILLS_DIR } = {}) {
  if (!isSkillPathAllowed(rawPath)) return null;
  const id = canonicalSkillId(rawPath);
  const abs = resolve(dir, id);
  const base = resolve(dir);
  // Должен лежать строго внутри каталога skills.
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/**
 * Зафиксированный порядок объединения промта роли и подключённых skills:
 * сначала базовый промт роли, затем каждый skill в порядке position, каждый —
 * под заголовком-разделителем со своим стабильным идентификатором.
 * skills: [{ path, content }]. Возвращает единый текст system-промта.
 */
export function mergePromptAndSkills(basePrompt, skills = []) {
  const parts = [String(basePrompt ?? '').trim()];
  for (const skill of skills) {
    const id = canonicalSkillId(skill?.path);
    const content = String(skill?.content ?? '').trim();
    if (!content) continue;
    parts.push(`\n\n# Skill: ${id}\n\n${content}`);
  }
  return parts.filter((p) => p && p.trim() !== '').join('').trim();
}

/**
 * ЧИСТАЯ валидация + нормализация PUT-обновления карточки роли.
 * Вход (частичный): { description, prompt, hidden, skills:[path|{path}] }.
 * validSkillPaths — Set допустимых id (из listAvailableSkills) либо null
 * (тогда проверяется только формат пути). Бросает httpError(422,...).
 * Возвращает нормализованный patch только с переданными полями.
 */
export function normalizeRoleUpdate(input, { validSkillPaths = null } = {}) {
  const patch = {};
  if (input == null || typeof input !== 'object') {
    throw httpError(422, 'role_update_invalid_body');
  }

  if ('description' in input) {
    const description = input.description == null ? '' : String(input.description);
    if (description.length > ROLE_FIELD_LIMITS.description) {
      throw httpError(422, 'role_description_too_long');
    }
    patch.description = description;
  }

  if ('prompt' in input) {
    const prompt = input.prompt == null ? '' : String(input.prompt);
    if (prompt.length > ROLE_FIELD_LIMITS.prompt) {
      throw httpError(422, 'role_prompt_too_long');
    }
    // Пустой промт сохраняем как NULL → файловый fallback.
    patch.prompt = prompt.trim() === '' ? null : prompt;
  }

  if ('hidden' in input) {
    if (typeof input.hidden !== 'boolean') throw httpError(422, 'role_hidden_must_be_boolean');
    patch.hidden = input.hidden;
  }

  if ('groupId' in input) {
    // null / '' → открепить от группы («Прочее»). Иначе — uuid группы (наличие
    // проверяется в updateRole перед записью).
    if (input.groupId === null || input.groupId === '') {
      patch.groupId = null;
    } else if (typeof input.groupId === 'string' && input.groupId.trim()) {
      patch.groupId = input.groupId.trim();
    } else {
      throw httpError(422, 'role_group_invalid');
    }
  }

  if ('skills' in input) {
    const list = Array.isArray(input.skills) ? input.skills : null;
    if (!list) throw httpError(422, 'role_skills_must_be_array');
    const seen = new Set();
    const skills = [];
    for (const item of list) {
      const id = canonicalSkillId(typeof item === 'string' ? item : item?.path);
      if (!id) throw httpError(422, 'role_skill_invalid_path');
      if (!isSkillPathAllowed(id)) throw httpError(422, 'role_skill_invalid_path', { skill: id });
      if (validSkillPaths && !validSkillPaths.has(id)) {
        throw httpError(422, 'role_skill_unknown', { skill: id });
      }
      if (seen.has(id)) throw httpError(422, 'role_skill_duplicate', { skill: id });
      seen.add(id);
      skills.push(id);
    }
    if (skills.length > ROLE_FIELD_LIMITS.skillsCount) {
      throw httpError(422, 'role_skills_too_many');
    }
    patch.skills = skills;
  }

  return patch;
}

// --- Доступ к ФС: список skills ---------------------------------------------

/**
 * Рекурсивный список доступных skill-файлов внутри SKILLS_DIR.
 * Возвращает [{ id, name }] со стабильными относительными id (POSIX-слэши).
 * Если каталог не существует — пустой список (не ошибка).
 */
export async function listAvailableSkills({ dir = SKILLS_DIR } = {}) {
  const base = resolve(dir);
  if (!existsSync(base)) return { skills: [] };
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && SKILL_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const id = relative(base, full).split(sep).join('/');
        out.push({ id, name: entry.name });
      }
    }
  }
  await walk(base);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { skills: out };
}

/**
 * ЧИСТАЯ валидация загрузки skill-файла с ПК пользователя.
 * Вход: { name, content }. Имя приводится к одному файлу (без каталогов и
 * traversal), расширение — только из SKILL_EXTENSIONS, содержимое непустое и в
 * пределах SKILL_UPLOAD_LIMIT. Возвращает { name, content }; бросает httpError(422).
 */
export function normalizeSkillUpload(input) {
  if (input == null || typeof input !== 'object') throw httpError(422, 'skill_upload_invalid_body');
  const rawName = String(input.name ?? '').trim().replace(/\\/g, '/');
  // Только базовое имя файла — каталоги и '..' отбрасываем.
  const name = rawName.includes('/') ? rawName.slice(rawName.lastIndexOf('/') + 1) : rawName;
  if (!name || name.startsWith('.')) throw httpError(422, 'skill_name_invalid');
  if (name.length > ROLE_FIELD_LIMITS.skillPath) throw httpError(422, 'skill_name_too_long');
  if (name.includes('\0') || /[<>:"|?*]/.test(name)) throw httpError(422, 'skill_name_invalid');
  if (!SKILL_EXTENSIONS.has(extname(name).toLowerCase())) throw httpError(422, 'skill_extension_invalid');
  const content = input.content == null ? '' : String(input.content);
  if (content.trim() === '') throw httpError(422, 'skill_content_empty');
  if (content.length > SKILL_UPLOAD_LIMIT) throw httpError(422, 'skill_content_too_long');
  return { name, content };
}

/**
 * POST /api/skills — записать загруженный с ПК skill-файл в каталог skills и
 * вернуть его стабильный id (как в listAvailableSkills). Файл с тем же именем
 * перезаписывается (обновление содержимого). Каталог создаётся при отсутствии.
 * Путь строго внутри SKILLS_DIR (без traversal). dir переопределяется в тестах.
 */
export async function uploadSkill(input, { dir = SKILLS_DIR } = {}) {
  const { name, content } = normalizeSkillUpload(input);
  const base = resolve(dir);
  const abs = resolve(base, name);
  if (abs !== base && !abs.startsWith(base + sep)) throw httpError(422, 'skill_name_invalid');
  await mkdir(base, { recursive: true });
  await writeFile(abs, content, 'utf8');
  const id = relative(base, abs).split(sep).join('/');
  return { id, name };
}

// Безопасное чтение содержимого skill по id (для сборки промта). Недопустимый/
// несуществующий путь → null (пропускаем, не валим сборку роли).
async function readSkillContent(id, { dir = SKILLS_DIR } = {}) {
  const abs = resolveSkillPath(id, { dir });
  if (!abs || !existsSync(abs)) return null;
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

// --- DB: карточки ролей ------------------------------------------------------

function mapRoleCard(row, skills) {
  return {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    prompt: row.prompt ?? '',
    hidden: row.hidden === true,
    // Смысловая группа экрана ролей (ROLE-GROUPS-001); null = «Прочее».
    groupId: row.group_id ?? null,
    skills,
  };
}

async function fetchRoleSkillIds(c, roleId) {
  const r = await c.query(
    'SELECT skill_path FROM role_skills WHERE role_id = $1 ORDER BY position, skill_path',
    [roleId],
  );
  return r.rows.map((row) => row.skill_path);
}

export async function listRoles(s) {
  return withClient(clientConfig(s), async (c) => {
    const roles = await c.query(
      'SELECT id, code, name, description, prompt, hidden, group_id FROM roles ORDER BY sort_order, code',
    );
    const skills = await c.query(
      'SELECT role_id, skill_path FROM role_skills ORDER BY position, skill_path',
    );
    const byRole = new Map();
    for (const row of skills.rows) {
      if (!byRole.has(row.role_id)) byRole.set(row.role_id, []);
      byRole.get(row.role_id).push(row.skill_path);
    }
    return { roles: roles.rows.map((row) => mapRoleCard(row, byRole.get(row.id) ?? [])) };
  });
}

export async function getRole(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'SELECT id, code, name, description, prompt, hidden, group_id FROM roles WHERE code = $1',
      [roleCode],
    );
    if (!r.rowCount) throw httpError(404, 'role_not_found');
    const skills = await fetchRoleSkillIds(c, r.rows[0].id);
    return mapRoleCard(r.rows[0], skills);
  });
}

/**
 * PUT /api/roles/:code — обновление карточки роли. Меняет только переданные поля
 * (description/prompt/hidden/skills). skills заменяются целиком (replace-set).
 * Имя/код роли не меняются. Возвращает актуальную карточку.
 */
export async function updateRole(s, code, input) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required');
  const available = await listAvailableSkills();
  const validSkillPaths = new Set(available.skills.map((x) => x.id));
  const patch = normalizeRoleUpdate(input, { validSkillPaths });

  return withClient(clientConfig(s), async (c) => {
    await c.query('BEGIN');
    try {
      const role = await c.query('SELECT id FROM roles WHERE code = $1 FOR UPDATE', [roleCode]);
      if (!role.rowCount) throw httpError(404, 'role_not_found');
      const roleId = role.rows[0].id;

      // Смена группы: проверяем существование до записи (понятная 422 вместо
      // нечитаемой ошибки FK). null = открепить (разрешено всегда).
      if ('groupId' in patch && patch.groupId !== null) {
        const g = await c.query('SELECT 1 FROM role_groups WHERE id = $1', [patch.groupId]);
        if (!g.rowCount) throw httpError(422, 'role_group_not_found', { groupId: patch.groupId });
      }

      const sets = [];
      const params = [roleId];
      for (const field of ['description', 'prompt', 'hidden']) {
        if (field in patch) {
          params.push(patch[field]);
          sets.push(`${field} = $${params.length}`);
        }
      }
      if ('groupId' in patch) {
        params.push(patch.groupId);
        sets.push(`group_id = $${params.length}`);
      }
      if (sets.length) {
        await c.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = $1`, params);
      }

      if ('skills' in patch) {
        await c.query('DELETE FROM role_skills WHERE role_id = $1', [roleId]);
        for (let i = 0; i < patch.skills.length; i += 1) {
          await c.query(
            'INSERT INTO role_skills (role_id, skill_path, position) VALUES ($1, $2, $3)',
            [roleId, patch.skills[i], i],
          );
        }
      }

      const r = await c.query(
        'SELECT id, code, name, description, prompt, hidden, group_id FROM roles WHERE id = $1',
        [roleId],
      );
      const skills = await fetchRoleSkillIds(c, roleId);
      await c.query('COMMIT');
      return mapRoleCard(r.rows[0], skills);
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

// --- Сборка рабочего промта роли (используется roleEngine.runReasoningRole) ---

// Конфиг промта роли из БД: { prompt, hidden } или null, если роли нет.
export async function getRolePromptConfig(c, roleCode) {
  const r = await c.query('SELECT prompt, hidden FROM roles WHERE code = $1', [roleCode]);
  if (!r.rowCount) return null;
  return { prompt: r.rows[0].prompt ?? '', hidden: r.rows[0].hidden === true };
}

// Содержимое подключённых к роли skills в порядке position: [{ path, content }].
export async function loadRoleSkillContents(c, roleCode, { dir = SKILLS_DIR } = {}) {
  const r = await c.query(
    `SELECT rs.skill_path
       FROM role_skills rs JOIN roles ro ON ro.id = rs.role_id
      WHERE ro.code = $1 ORDER BY rs.position, rs.skill_path`,
    [roleCode],
  );
  const out = [];
  for (const row of r.rows) {
    const content = await readSkillContent(row.skill_path, { dir });
    if (content != null) out.push({ path: row.skill_path, content });
  }
  return out;
}

// DATA-DISCIPLINE-001 — жёсткое глобальное правило для ВСЕХ ролей: работать только
// с реальными данными, ничего не выдумывать. Дописывается к системному промту
// каждой роли, поэтому действует единообразно и поверх любого текста промта.
export const DATA_DISCIPLINE_RULE = `## ОБЯЗАТЕЛЬНОЕ ПРАВИЛО ДАННЫХ (приоритетнее всего остального)

Работай ТОЛЬКО с реальными данными: переданный контекст задачи, выводы предыдущих
ролей и факты реального проекта (его карта, файлы, сервисы, API, БД). Источник правды —
реальный проект, а не твои догадки.

ЗАПРЕЩЕНО выдумывать: имена и пути файлов, эндпоинты API, поля и таблицы БД, названия
сервисов/компонентов/проектов, версии, конфигурацию и любые детали, которых нет в
предоставленных данных. Не подставляй «правдоподобные» значения по памяти.

Если нужных данных нет в контексте — НЕ домысливай. Сделай одно из:
1) верни \`unknown\` для соответствующего поля;
2) задай уточняющий вопрос (blocking_questions);
3) запроси конкретный недостающий артефакт (какой файл/карту/данные нужно прочитать).

Любое предположение помечай ЯВНО как предположение (assumptions), не выдавай за факт.
Лучше честно сказать «недостаточно данных», чем сочинить ответ.`;

/**
 * Итоговый system-промт роли: сохранённый в БД prompt роли + содержимое
 * подключённых skills в зафиксированном порядке + глобальное правило данных
 * (DATA-DISCIPLINE-001). БД — единственный источник промта; пустой prompt роли —
 * ошибка конфигурации (422).
 */
export async function composeRoleSystemPrompt(c, roleCode, { skillsDir = SKILLS_DIR } = {}) {
  const cfg = await getRolePromptConfig(c, roleCode);
  const base = cfg?.prompt?.trim() ? cfg.prompt : '';
  if (!base) throw httpError(422, 'role_prompt_missing', { role: roleCode });
  const skills = await loadRoleSkillContents(c, roleCode, { dir: skillsDir });
  return `${mergePromptAndSkills(base, skills)}\n\n${DATA_DISCIPLINE_RULE}`;
}
