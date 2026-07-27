// PROJECT-REF-RESOLVE-001 — единый резолвер ссылки на проект + хелпер фильтра.
//
// Ссылку на проект (:projectId) допускаем как UUID, code, root_path (папку) или
// name — один и тот же SQL раньше был продублирован в stages.js, taskStats.js и
// performance.js. strict=true бросает те же ошибки, что и прежние strict-версии
// (422 project_id_required для пустой ссылки, 404 project_not_found — если не
// найден); strict=false возвращает null в обоих случаях (как soft-версия в
// performance.js). Папка (root_path) — основной ключ привязки локального проекта
// к БД, code — стабильный машинный ключ; при неоднозначности берём самый ранний.
import { httpError } from './httpError.js';

export async function resolveProjectRef(client, ref, { strict = true } = {}) {
  const value = String(ref ?? '').trim();
  if (!value) {
    if (strict) throw httpError(422, 'project_id_required');
    return null;
  }
  const r = await client.query(
    `SELECT id FROM projects
      WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at LIMIT 1`,
    [value],
  );
  if (!r.rowCount) {
    if (strict) throw httpError(404, 'project_not_found');
    return null;
  }
  return r.rows[0].id;
}

// Хелпер сужения агрегатных запросов до одного проекта. При непустом projectDbId
// добавляет плейсхолдер в params и возвращает { projJoin, projFilter }: JOIN на
// tasks по ar.task_id и фильтр t.project_id = $N. Нумерация $N берётся из текущей
// длины params ПОСЛЕ push, поэтому вызывать нужно ровно в той точке запроса, где
// плейсхолдер должен получить свой номер. При null/пустом — обе строки пустые и
// params не трогаем (поведение «глобально по всем задачам»).
export function applyProjectFilter(params, projectDbId) {
  if (!projectDbId) return { projJoin: '', projFilter: '' };
  params.push(projectDbId);
  return {
    projJoin: 'JOIN tasks t ON t.id = ar.task_id',
    projFilter: `AND t.project_id = $${params.length}`,
  };
}
