// Жизненный цикл задач из UI/эндпоинтов: продвижение (advanceTask), ручное
// перемещение (moveTask), приоритет, массовый рестарт, доска приёмки и приём задач,
// а также поток «вопрос исполнителя к человеку» (TASK-NEEDS-INPUT-001).
import { publicTx, roleIdByCode } from './dbCore.js';
import { withTransaction } from './transaction.js';
import { scannerError } from './scannerCompat.js';
import { TERMINAL_STATUSES, resolveTransition } from './projectRoute.js';
import { TERMINAL_TASK_STATUSES, isOrchestratorProject } from './taskPolicy.js';
import { loadProjectRoute, resolveGraphTransition } from './routeLoaders.js';
import { resetStaleClaims } from './janitor.js';

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
export const advanceTask = publicTx(advanceTaskTx);

export async function advanceTaskTx(c, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  return withTransaction(c, async () => {
    const cur = await c.query(
      `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id,
              t.current_stage_key, t.assigned_agent_id, r.code AS role_code
         FROM tasks t LEFT JOIN roles r ON r.id = t.current_role_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    if (!task.project_id) throw scannerError(409, 'task_without_project');
    if (TERMINAL_STATUSES.has(task.status)) throw scannerError(409, 'task_terminal');
    if (task.status === 'BLOCKED') throw scannerError(409, 'task_blocked_use_manual');
    // TASK-NEEDS-INPUT-001: задача стоит на вопросе к человеку. Продвинуть её
    // «Дальше» — значит потерять вопрос и пустить исполнителя работать с той же
    // неоднозначностью, из-за которой он и остановился. Двигают такую задачу
    // ответом (answerTaskQuestionTx), который вернёт её на прежнюю стадию.
    if (task.status === 'NEEDS_INPUT') throw scannerError(409, 'task_needs_input_use_answer');
    // Захваченную исполнителем задачу авто-продвигать нельзя: пока её слот занят
    // (assigned_agent_id != NULL), безусловный перевод дальше потеряет/перетрёт
    // активный прогон. Такие задачи двигаем только ручным moveTask с аудитом.
    if (task.assigned_agent_id) throw scannerError(409, 'task_assigned_use_manual');

    const route = await loadProjectRoute(c, task.project_id);
    const decision = { outcome: 'FORWARD' };
    const resolved = task.current_stage_key
      ? await resolveGraphTransition(c, task, decision)
      : resolveTransition(route, task.role_code, decision, {
        currentStatus: task.status,
        currentStageKey: task.current_stage_key,
      });

    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);

    // Человекочитаемое имя целевого этапа (для аудита, как targetStage в moveTask):
    // в граф-режиме берём имя по nextStageKey, иначе деградируем до кода роли/DONE.
    let targetStage = null;
    if (resolved.nextStageKey) {
      const stRes = await c.query(
        'SELECT name FROM project_stages WHERE stage_key = $1 AND project_id = $2',
        [resolved.nextStageKey, task.project_id],
      );
      targetStage = stRes.rows[0]?.name ?? null;
    }
    if (!targetStage) targetStage = resolved.done ? 'DONE' : (resolved.nextRole ?? null);

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
        fromStatus: task.status, toStatus: resolved.toStatus, targetStage,
        done: resolved.done === true,
      })],
    );
    return {
      advanced: true, taskId: id, fromStatus: task.status,
      toStatus: resolved.toStatus, nextRole: resolved.nextRole ?? null, done: resolved.done === true,
    };
  });
}

/**
 * Ручное перемещение задачи на выбранный этап проекта (manual). Для заблокированных
 * или иначе непродвигаемых задач: пользователь выбирает целевой этап (его id), мы
 * пишем audit-событие source='manual' с прежним/новым статусом и комментарием,
 * снимаем назначение агента. Целевой этап обязан принадлежать проекту задачи и
 * иметь статус (контрольные узлы fork/join отклоняются). Публичная обёртка над Tx.
 */
export const moveTask = publicTx(moveTaskTx);

export async function moveTaskTx(c, taskId, input) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  const toStageId = String(input?.toStageId ?? '').trim();
  if (!toStageId) throw scannerError(422, 'target_stage_required');
  // Ручное перемещение обязано нести причину/комментарий: это audit-событие, по
  // которому видно, кто и зачем сдвинул задачу мимо обычного маршрута. Без неё
  // запись в task_events теряет смысл, поэтому пустой reason отклоняем.
  const reason = String(input?.reason ?? '').trim();
  if (!reason) throw scannerError(422, 'reason_required');
  return withTransaction(c, async () => {
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

    // accepted_at = NULL: задача снова в работе (в т.ч. «доработка» из «Проверки»),
    // не должна числиться принятой/«Выполнено».
    await c.query(
      `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
              current_stage_key = $4::uuid, assigned_agent_id = NULL,
              accepted_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, toStatus, stage.role_id ?? null, stage.stage_key ?? null],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [id, task.status, toStatus, stage.role_id ?? null, JSON.stringify({
        source: 'manual', via: 'manual-move', fromStatus: task.status, toStatus,
        targetStage: stage.name ?? null, reason,
      })],
    );
    return { moved: true, taskId: id, fromStatus: task.status, toStatus, targetStage: stage.name ?? null };
  });
}

/**
 * TASK-PRIORITY-SCALE-001 — смена приоритета задачи из карточки/UI (PATCH .../priority).
 * Та же валидация, что при создании: 0 разрешён ТОЛЬКО проекту оркестратора (форс
 * сервера) — клиент не может задать 0 чужой задаче; оркестраторную нельзя понизить
 * ниже 0 (её приоритет всегда 0). Меняем ТОЛЬКО число приоритета — статус/слот
 * (assigned_agent_id) не трогаем, RUNNING-прогоны не вытесняем. Публичная обёртка над Tx.
 */
export const setTaskPriority = publicTx(setTaskPriorityTx);

export async function setTaskPriorityTx(c, taskId, priority) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  if (priority === null || priority === undefined || priority === '') {
    throw scannerError(422, 'priority_required');
  }
  const n = Math.trunc(Number(priority));
  if (!Number.isFinite(n) || n < 0 || n > 3) throw scannerError(422, 'priority_out_of_range');
  return withTransaction(c, async () => {
    const cur = await c.query(
      `SELECT t.id, t.priority, p.code AS project_code, p.root_path
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const row = cur.rows[0];
    const isOrch = isOrchestratorProject({ code: row.project_code, root_path: row.root_path });
    // 0 — привилегия сервера для проекта оркестратора. Клиент не ставит 0 чужой задаче.
    if (n === 0 && !isOrch) throw scannerError(422, 'priority_zero_orchestrator_only');
    // Оркестраторную не понижать ниже 0: её приоритет всегда 0 (форс сервера).
    if (isOrch && n !== 0) throw scannerError(422, 'priority_orchestrator_forced_zero');
    if (row.priority === n) {
      return { updated: true, taskId: id, priority: n, changed: false };
    }
    await c.query('UPDATE tasks SET priority = $2::smallint, updated_at = now() WHERE id = $1', [id, n]);
    await c.query(
      `INSERT INTO task_events (task_id, event_type, payload_json)
       VALUES ($1, 'TASK_UPDATED', $2::jsonb)`,
      [id, JSON.stringify({ source: 'manual-priority', fromPriority: row.priority, toPriority: n })],
    );
    return { updated: true, taskId: id, priority: n, changed: true };
  });
}

/**
 * TASK-RESTART-001 — массовый перезапуск зависших задач из раздела «Задачи».
 * Зависшие = с проектом, НЕ терминальные (DONE/CANCELLED/FAILED), НЕ ждущие
 * подзадачи (WAITING_FOR_CHILDREN) и «не в работе» (свободный слот
 * assigned_agent_id IS NULL). Подзадачи учитываются наравне с верхним уровнем.
 *
 * RESTART-IN-PLACE: задача перезапускается НА ТЕКУЩЕМ ЭТАПЕ — current_role_id и
 * current_stage_key НЕ меняются, задача НЕ перебрасывается на Приёмщика. Раньше
 * restart-stuck возвращал всё в статус RESTART под TASK_INTAKE_OFFICER, и задачи
 * «улетали» со своих этапов на вход проекта, теряя прогресс. Со свободным слотом
 * задача и так переигрывается своей же ролью (claimLlmRoleTask выбирает по
 * current_role_id + status, не по прошлым прогонам; CODING ждёт programmer-runner),
 * поэтому достаточно отпустить зависшие захваты — переноса на другой этап не нужно.
 *
 * Перед выборкой освобождаем осиротевшие/просроченные захваты (resetStaleClaims):
 * зависшая сессия отпускает слот → её задача переигрывается на текущем этапе, а
 * реально активные задачи сохраняют назначение и не трогаются.
 */
export const restartStuckTasks = publicTx(restartStuckTasksTx);

export async function restartStuckTasksTx(c) {
  await resetStaleClaims(c);
  return withTransaction(c, async () => {
    // Перезапуск на текущем этапе: статус/роль/стадия не меняются. Пишем
    // диагностическое событие (to_status = from_status) и трогаем updated_at,
    // чтобы зафиксировать намерение «переиграть здесь же».
    const upd = await c.query(
      `WITH targets AS (
         SELECT id, status::text AS from_status, current_role_id FROM tasks
          WHERE project_id IS NOT NULL
            AND assigned_agent_id IS NULL
            AND status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT')
       ), upd AS (
         UPDATE tasks t SET updated_at = now()
           FROM targets WHERE t.id = targets.id
         RETURNING t.id
       )
       INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       SELECT targets.id, 'TASK_UPDATED', targets.from_status::task_status, targets.from_status::task_status,
              targets.current_role_id,
              jsonb_build_object('source', 'manual-restart', 'reason', 'restart_in_place')
         FROM targets
       RETURNING task_id`,
    );
    return { restarted: upd.rowCount };
  });
}

/**
 * TASK-ACCEPTANCE-001 — доска приёмки для подразделов «Проверка»/«Выполнено».
 * Плоский список завершённых задач (status IN ('DONE','CANCELLED')) с проектом,
 * сервисом и признаком приёма. Клиент делит его так: «Проверка» — только не принятые
 * DONE (accepted = false); «Выполнено» — принятые DONE и все CANCELLED (у отменённых
 * приёма нет, но их показывают в архиве с причиной отмены). Подзадачи
 * (parent_task_id) учитываются наравне с верхним уровнем. Read-only.
 *
 * Для CANCELLED-задач отдаём причину отмены cancelReason: приоритет — заметка о
 * дубле (data_card->>'duplicateNote'), иначе reason/note последнего события
 * task_events с to_status='CANCELLED' (LEFT JOIN LATERAL ev), иначе ссылка на
 * оригинал (data_card->>'duplicateOf'). Для DONE cancelReason = null. Поле
 * duplicateOf пробрасывается из data_card (иначе null).
 *
 * Возвращает { tasks: [{ id, title, status, priority, projectId, projectName,
 * serviceName, accepted, acceptedAt, updatedAt, cancelReason, duplicateOf }] }.
 */
export const getAcceptanceBoard = publicTx(getAcceptanceBoardTx);

export async function getAcceptanceBoardTx(c) {
  const r = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.priority::text AS priority,
              t.accepted_at, t.updated_at,
              p.id AS project_id, p.name AS project_name,
              sv.service_name,
              t.data_card->>'duplicateNote' AS duplicate_note,
              t.data_card->>'duplicateOf'   AS duplicate_of,
              ev.reason AS ev_reason, ev.note AS ev_note
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN services sv ON sv.id = t.service_id
         LEFT JOIN LATERAL (
           SELECT te.payload_json->>'reason' AS reason,
                  te.payload_json->>'note'   AS note
             FROM task_events te
            WHERE te.task_id = t.id AND te.to_status = 'CANCELLED'
            ORDER BY te.created_at DESC, te.id DESC
            LIMIT 1
         ) ev ON true
        WHERE t.status IN ('DONE','CANCELLED')
        ORDER BY t.priority ASC, t.created_at ASC, t.id DESC
        LIMIT 1000`,
    );
    // Первое непустое строковое значение — аналог COALESCE(NULLIF(x, ''), …).
    const firstNonEmpty = (...vals) => {
      for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v;
      return null;
    };
    const tasks = r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      projectId: row.project_id,
      projectName: row.project_name,
      serviceName: row.service_name ?? null,
      accepted: row.accepted_at != null,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      // Причина отмены только у CANCELLED; у DONE — null.
      cancelReason: row.status === 'CANCELLED'
        ? firstNonEmpty(row.duplicate_note, row.ev_reason, row.ev_note, row.duplicate_of)
        : null,
      duplicateOf: firstNonEmpty(row.duplicate_of),
    }));
  return { tasks };
}

/**
 * TASK-ACCEPTANCE-001 — принять задачу из подраздела «Проверка». Проставляет
 * accepted_at = now() (задача переходит в «Выполнено»). Принять можно только
 * задачу в статусе DONE (прошедшую конвейер); статус не меняем. Идемпотентно:
 * повторный приём просто обновляет метку. Пишет audit-событие source='manual-accept'.
 * Публичная обёртка над Tx.
 */
export const acceptTask = publicTx(acceptTaskTx);

// TASK-AUTO-ACCEPT-001 — «не проверять выполненные задачи»: массово принять все
// задачи, дошедшие до DONE, но ещё не принятые (accepted_at IS NULL). Вызывается
// фоновым тиком, когда включена настройка auto_accept_done — тогда гейт «Проверка»
// пуст, а свежие DONE сразу попадают в «Выполнено». Идемпотентно (WHERE accepted_at
// IS NULL), пишет audit-событие source='auto-accept'. Возвращает число принятых.
export async function autoAcceptDoneTasks(c) {
  const r = await c.query(
    `WITH upd AS (
       UPDATE tasks SET accepted_at = now(), updated_at = now()
        WHERE status = 'DONE' AND accepted_at IS NULL
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', 'DONE'::task_status, 'DONE'::task_status, NULL,
            jsonb_build_object('source', 'auto-accept', 'via', 'acceptance-gate-disabled')
       FROM upd
     RETURNING task_id`,
  );
  return r.rowCount;
}

export async function acceptTaskTx(c, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  return withTransaction(c, async () => {
    const cur = await c.query(
      `SELECT id, status::text AS status, accepted_at FROM tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    // Принимать имеет смысл только задачу, завершившую конвейер (DONE). Иначе
    // приём «через голову» маршрута скрыл бы незаконченную работу из «В работе».
    if (task.status !== 'DONE') throw scannerError(409, 'task_not_done');

    await c.query(
      `UPDATE tasks SET accepted_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_UPDATED', 'DONE'::task_status, 'DONE'::task_status, NULL, $2::jsonb)`,
      [id, JSON.stringify({ source: 'manual-accept', via: 'acceptance-gate' })],
    );
    return { accepted: true, taskId: id };
  });
}

// ─────────────────── TASK-NEEDS-INPUT-001: вопрос исполнителя ───────────────────
//
// Исполнитель, упёршийся в неоднозначность, раньше мог только выдумать ответ или
// вернуть success=false (задача уходила в requeue и через несколько холостых
// кругов — в BLOCKED, без единого понятного человеку вопроса). Теперь он паркует
// задачу в NEEDS_INPUT с конкретным вопросом, человек отвечает, и задача
// возвращается ровно на ту стадию, с которой ушла.

/** Максимум длины описания задачи — тот же потолок, что у доливки артефактов. */
const TASK_DESCRIPTION_MAX = 20000;

/** Ограничители текстов вопроса/ответа: защита от простыни на весь контекст. */
const QUESTION_MAX = 2000;
const ANSWER_MAX = 4000;
const OPTION_MAX = 300;
const MAX_OPTIONS = 10;

function clipText(value, max) {
  const s = String(value ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Нормализовать варианты ответа: только непустые строки, без дублей, с лимитом. */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of options) {
    const v = clipText(raw, OPTION_MAX);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/**
 * Припарковать задачу на вопросе к человеку.
 *
 * Идемпотентно по смыслу: если задача уже стоит на открытом вопросе, повторный
 * вызов не плодит второй (уникальный частичный индекс task_questions_single_open_idx
 * это и запрещает) и возвращает существующий — раннер мог не получить ответ HTTP
 * и повторить запрос.
 *
 * @param {string} taskId
 * @param {{question:string, options?:string[], context?:string, roleCode?:string}} input
 */
export const requestTaskInput = publicTx(requestTaskInputTx);

export async function requestTaskInputTx(c, taskId, input = {}) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  const question = clipText(input.question, QUESTION_MAX);
  if (!question) throw scannerError(422, 'question_required');
  const options = normalizeOptions(input.options);
  const context = clipText(input.context, QUESTION_MAX) || null;
  const roleCode = clipText(input.roleCode, 64) || null;

  return withTransaction(c, async () => {
    const cur = await c.query(
      `SELECT id, status::text AS status, needs_input_from_status::text AS from_status,
              current_role_id
         FROM tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];

    // Терминальную задачу парковать бессмысленно: отвечать на вопрос уже некому
    // и некуда возвращать. Такое означает рассинхрон раннера с оркестратором.
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw scannerError(409, 'task_terminal');

    const open = await c.query(
      `SELECT id FROM task_questions WHERE task_id = $1 AND answered_at IS NULL LIMIT 1`,
      [id],
    );
    if (open.rowCount) {
      return { parked: true, duplicate: true, taskId: id, questionId: open.rows[0].id };
    }

    const ins = await c.query(
      `INSERT INTO task_questions (task_id, role_code, question, options, context)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [id, roleCode, question, JSON.stringify(options), context],
    );
    const questionId = ins.rows[0].id;

    // Запоминаем стадию, с которой ушли: после ответа возвращаемся ровно на неё,
    // а не пересчитываем маршрут заново (пересчёт увёл бы задачу не туда, если
    // маршрут проекта успели поменять).
    await c.query(
      `UPDATE tasks
          SET status = 'NEEDS_INPUT',
              needs_input_from_status = $2::task_status,
              assigned_agent_id = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, task.status],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'NEEDS_INPUT'::task_status, $3, $4::jsonb)`,
      [id, task.status, task.current_role_id ?? null,
        JSON.stringify({ source: 'needs-input', via: 'agent-question', questionId, roleCode, question, options })],
    );
    return { parked: true, duplicate: false, taskId: id, questionId, fromStatus: task.status };
  });
}

/**
 * Доска «Нужна информация»: задачи, стоящие на открытом вопросе.
 * Возвращает { tasks: [{ id, title, projectId, projectName, serviceCode, priority,
 * question: { id, question, options, context, roleCode, askedAt } }] }.
 */
export const getNeedsInputBoard = publicTx(getNeedsInputBoardTx);

export async function getNeedsInputBoardTx(c) {
  const r = await c.query(
    `SELECT t.id, t.title, t.priority::text AS priority,
            p.id AS project_id, p.name AS project_name,
            sv.service_name,
            q.id AS question_id, q.question, q.options, q.context,
            q.role_code, q.asked_at
       FROM tasks t
       JOIN task_questions q ON q.task_id = t.id AND q.answered_at IS NULL
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN services sv ON sv.id = t.service_id
      WHERE t.status = 'NEEDS_INPUT'
      ORDER BY t.priority ASC, q.asked_at ASC
      LIMIT 1000`,
  );
  return {
    tasks: r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      projectId: row.project_id ?? null,
      projectName: row.project_name ?? null,
      serviceCode: row.service_name ?? null,
      // Строкой — как на остальных досках (ср. getAcceptanceBoardTx): справочник
      // src/data/taskPriorities.ts на фронте работает со строковыми кодами '0'..'3'.
      priority: row.priority,
      question: {
        id: row.question_id,
        question: row.question,
        options: Array.isArray(row.options) ? row.options : [],
        context: row.context ?? null,
        roleCode: row.role_code ?? null,
        askedAt: row.asked_at,
      },
    })),
  };
}

/**
 * Ответ человека: закрывает вопрос и возвращает задачу в работу.
 *
 * Ответ дописывается в ОПИСАНИЕ задачи отдельной секцией — это единственный
 * канал, который исполнитель гарантированно видит (промпт строится из
 * task.description, см. programmer-runner/src/promptBuilder.js). Ср. доливку
 * артефактов Архитектора в renderWorkArtifactSections.
 */
export const answerTaskQuestion = publicTx(answerTaskQuestionTx);

export async function answerTaskQuestionTx(c, taskId, input = {}) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  const answer = clipText(input.answer, ANSWER_MAX);
  if (!answer) throw scannerError(422, 'answer_required');
  const questionId = String(input.questionId ?? '').trim();
  const answeredBy = clipText(input.answeredBy, 120) || null;

  return withTransaction(c, async () => {
    const cur = await c.query(
      `SELECT id, status::text AS status, needs_input_from_status::text AS from_status,
              description
         FROM tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rowCount) throw scannerError(404, 'task_not_found');
    const task = cur.rows[0];
    if (task.status !== 'NEEDS_INPUT') throw scannerError(409, 'task_not_awaiting_input');

    // Вопрос берём либо явно указанный, либо единственный открытый: UI знает id,
    // а ручной вызов из консоли — не обязан.
    const qres = questionId
      ? await c.query(
        `SELECT id, question, answered_at FROM task_questions
          WHERE id = $1 AND task_id = $2 FOR UPDATE`,
        [questionId, id],
      )
      : await c.query(
        `SELECT id, question, answered_at FROM task_questions
          WHERE task_id = $1 AND answered_at IS NULL
          ORDER BY asked_at DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
    if (!qres.rowCount) throw scannerError(404, 'question_not_found');
    const q = qres.rows[0];
    if (q.answered_at) throw scannerError(409, 'question_already_answered');

    await c.query(
      `UPDATE task_questions SET answer = $2, answered_at = now(), answered_by = $3
        WHERE id = $1`,
      [q.id, answer, answeredBy],
    );

    // Возврат на прежнюю стадию. Фолбэк на CODING — если задача попала в
    // NEEDS_INPUT в обход requestTaskInput (ручная правка в БД, старые записи):
    // лучше вернуть в разработку, чем оставить висеть в парковке навсегда.
    const resumedStatus = task.from_status || 'CODING';
    const section = `## Уточнение от заказчика\n**Вопрос:** ${q.question}\n**Ответ:** ${answer}`;
    const base = String(task.description ?? '').trim();
    const description = (base ? `${base}\n\n${section}` : section).slice(0, TASK_DESCRIPTION_MAX);

    await c.query(
      `UPDATE tasks
          SET status = $2::task_status,
              needs_input_from_status = NULL,
              assigned_agent_id = NULL,
              description = $3,
              updated_at = now()
        WHERE id = $1`,
      [id, resumedStatus, description],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', 'NEEDS_INPUT'::task_status, $2::task_status, NULL, $3::jsonb)`,
      [id, resumedStatus,
        JSON.stringify({ source: 'needs-input', via: 'user-answer', questionId: q.id, answeredBy })],
    );
    return { answered: true, taskId: id, questionId: q.id, resumedStatus };
  });
}
