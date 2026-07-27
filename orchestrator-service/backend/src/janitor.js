// Санитары/реконсиляция оркестратора: реап осиротевших прогонов, освобождение
// протухших захватов Claude/host, реаттач ролей, закрытие дублей, эскалации петель
// (программист/архитектор/runaway/FA), продвижение застрявших doc-веток, GI-ресинк
// и стартовая реконсиляция. Константы конфигурации импортируются из db.js.
import { withClient, clientConfig, roleIdByCode } from './dbCore.js';
import { withTransaction } from './transaction.js';
import { reconcileClockSkew } from './clockGuard.js';
import { MAX_REWORK, DOC_BRANCH_ROLE_CODES } from './roleEngine.js';
import { loadProjectGraph, resolveGraphTransition } from './routeLoaders.js';
import {
  ROLE_TIMEOUT_MS, HOST_TIMEOUT_MS, HOST_ROLE_CODES, CLAUDE_ASSIGN_TIMEOUT_MS,
  PROGRAMMER_RELEASE_LOOP_MAX, ARCHITECT_BUDGET_LOOP_MAX, ARCHITECT_BUDGET_BLOCK_REASON,
  TASK_RUN_LOOP_MAX, TASK_RUN_LOOP_BLOCK_REASON, DOC_BRANCH_MAX_AGE_MS,
  GI_RESYNC_RETRY_ENABLED, GI_RESYNC_NOTES, GI_RESYNC_GRACE_MS,
} from './db.js';

// Снять зависшие захваты: agent_run RUNNING старше таймаута → TIMEOUT, слот свободен.
export async function resetStaleClaims(c) {
  // CLOCK-GUARD-001: до проверки таймаутов компенсируем возможный скачок настенных
  // часов БД/Docker-VM, иначе все прогоны «в полёте» разом гасятся ложным TIMEOUT.
  await reconcileClockSkew(c, { log: (m) => console.log(m) });
  await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, r.code AS role_code, t.status::text AS task_status,
              round(extract(epoch from (now() - ar.started_at)) * 1000)::bigint AS hung_ms
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.status = 'RUNNING'
          -- PROGRAMMER-UNIFY-001: у программиста более длинная сессия и свой
          -- (обычно больший) таймаут CLAUDE_ASSIGN_TIMEOUT_MS — его осиротевшие
          -- прогоны закрывает releaseStaleClaudeClaims, чтобы общий ROLE_TIMEOUT_MS
          -- не убивал реально идущую долгую сессию программиста раньше времени.
          AND COALESCE(r.code, '') <> 'PROGRAMMER'
          -- HOST-ORPHAN-TIMEOUT-001: host-роли (docker-сборка/коммит) реапятся по
          -- своему БОЛЬШЕМУ таймауту, иначе живой прогон срежется посреди build;
          -- остальные роли — по общему ROLE_TIMEOUT_MS.
          AND ar.started_at < now() - ((CASE WHEN COALESCE(r.code, '') = ANY($3::text[])
                                        THEN $2 ELSE $1 END)::bigint * interval '1 millisecond')
     ), done AS (
       UPDATE agent_runs
          SET status = 'TIMEOUT',
              finished_at = now(),
              error_text = 'role execution timed out before producing a structured result',
              output_json = jsonb_build_object('status', 'TIMEOUT', 'reason', 'role_timeout')
        WHERE id IN (SELECT id FROM stale)
        RETURNING task_id
     ), freed AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT s.task_id, 'STATUS_CHANGED', s.task_status::task_status, s.task_status::task_status, s.role_id,
            -- HOST-ORPHAN-TIMEOUT-001: для host-ролей — диагностируемое событие
            -- (кто=roleCode, почему=host_orphan_timeout, сколько висела=hungMs).
            CASE WHEN COALESCE(s.role_code, '') = ANY($3::text[])
                 THEN jsonb_build_object('runner', true, 'reason', 'host_orphan_timeout',
                        'runStatus', 'TIMEOUT', 'roleCode', s.role_code, 'hungMs', s.hung_ms)
                 ELSE jsonb_build_object('runner', true, 'reason', 'role_timeout', 'runStatus', 'TIMEOUT')
            END
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
    [ROLE_TIMEOUT_MS, HOST_TIMEOUT_MS, HOST_ROLE_CODES],
  );
  await releaseStaleClaudeClaims(c);
}

// Освободить осиротевшие задачи Claude/PROGRAMMER: статус CODING под ролью
// PROGRAMMER с назначенным агентом, у которых последнее AGENT_ASSIGNED старше
// timeoutMs. У такого назначения нет agent_run RUNNING, поэтому resetStaleClaims
// его не ловит. Снимаем assigned_agent_id (фидер переподаст задачу в свободный
// слот) и пишем диагностическое событие. Re-feed безопасен: фидер пишет только
// в пустой слот, а acceptScannerCompletion идемпотентен.
// BOOT-RECONCILE-GRACE-001: стартовая реконсиляция передаёт штатный
// CLAUDE_ASSIGN_TIMEOUT_MS (а не 0), т.к. Claude-агент переживает рестарт и
// досдаёт результат — освобождаем только назначения старше таймаута роли, иначе
// каждый деплой-рестарт убивал бы живую сессию Разработчика.
async function releaseStaleClaudeClaims(c, timeoutMs = CLAUDE_ASSIGN_TIMEOUT_MS, reason = 'claude_assignment_timeout') {
  const r = await c.query(
    `WITH stale AS (
       SELECT t.id, t.current_role_id, t.status
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
        WHERE r.code = 'PROGRAMMER'
          AND t.status = 'CODING'
          AND t.assigned_agent_id IS NOT NULL
          AND COALESCE(
                (SELECT max(te.created_at) FROM task_events te
                  WHERE te.task_id = t.id AND te.event_type = 'AGENT_ASSIGNED'),
                t.updated_at
              ) <= now() - ($1::bigint * interval '1 millisecond')
     ), released AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT id FROM stale)
        RETURNING id, current_role_id, status
     ), runs AS (
       -- PROGRAMMER-UNIFY-001: закрыть осиротевший RUNNING-прогон программиста
       -- (захват создал его, исполнитель умер, не сдав/не освободив) → TIMEOUT, иначе
       -- он висел бы вечно и искажал KPI. Data-modifying CTE выполняется всегда,
       -- даже без ссылки из основного запроса.
       UPDATE agent_runs SET status = 'TIMEOUT', finished_at = now(), outcome = $2::text,
              error_text = 'programmer claim orphaned (assignment timeout)'
        WHERE status = 'RUNNING' AND task_id IN (SELECT id FROM released)
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'STATUS_CHANGED', status, status, current_role_id,
            jsonb_build_object('runner', true, 'released', true, 'reason', $2::text)
       FROM released
     RETURNING task_id`,
    [Math.max(0, Number(timeoutMs) || 0), reason],
  );
  return r.rowCount;
}

// RUNNER-STARTUP-REAP-001 / RUNNER-RUNTIME-REAP-001: agent_run в статусе RUNNING,
// исполнитель которого умер, держит слот «N на роль» до таймаута resetStaleClaims.
// Два сценария осиротения:
//   1) Перезапуск процесса (ageCheck=false): горутина-исполнитель прошлого процесса
//      умерла вместе с ним — ЛЮБОЙ RUNNING заведомо осиротел, гасим безусловно.
//      Полный рестарт означает, что активных вызовов «в полёте» нет.
//   2) Рантайм (ageCheck=true): после рестарта БД/обрыва соединения (pgbouncer/
//      Patroni) LLM-вызов/финализацию прогона рвёт, и он повисает в RUNNING уже во
//      время работы процесса. Стартовая зачистка такие свежие сироты не ловит; до
//      этого фикса их освобождал только resetStaleClaims на таймауте (~30 минут в
//      проде), из-за чего очередь роли (max_concurrency_per_role) клинило. Здесь
//      гасим их на КАЖДОМ тике runner'а, но НЕ безусловно: только прогоны старше
//      RUNNER_ROLE_TIMEOUT_MS, иначе убьём реально идущий вызов. Перед проверкой
//      возраста компенсируем скачок настенных часов БД (reconcileClockSkew, как в
//      resetStaleClaims), чтобы прогоны «в полёте» не получили ложный TIMEOUT.
// В обоих случаях: agent_run → TIMEOUT, у нетерминальной задачи снимается
// assigned_agent_id (слот свободен), задача переигрывается штатно.
export async function reapOrphanRunningRuns(c, { ageCheck = false, boot = false, deployRef = null } = {}) {
  const reason = ageCheck ? 'orphan_run_timeout' : 'orchestrator_restart_reconcile';
  const errText = ageCheck
    ? 'RUNNING run exceeded role timeout without finishing (orphaned mid-run, e.g. DB connection drop); reaped as TIMEOUT'
    : 'orchestrator restarted while run was RUNNING; run was reaped as TIMEOUT';
  // В рантайме перед сравнением возраста компенсируем возможный скачок часов БД,
  // иначе все RUNNING разом окажутся «старше таймаута» и будут погашены ложно.
  if (ageCheck) {
    await reconcileClockSkew(c, { log: (m) => console.log(m) });
  }
  const params = [errText, reason];
  let agePredicate = '';
  // Стартовый reconcile (ageCheck=false) гасит ЛЮБОЙ RUNNING безусловно — причина
  // «рестарт», а не «зависание по таймауту», поэтому payload остаётся общим.
  let eventPayload = `jsonb_build_object('runner', true, 'reason', $2::text, 'runStatus', 'TIMEOUT')`;
  if (ageCheck) {
    // PROGRAMMER-UNIFY-001 + HOST-ORPHAN-TIMEOUT-001: ветвим возраст CASE'ом по роли —
    // у программиста легально бОльшая сессия (CLAUDE_ASSIGN_TIMEOUT_MS), у host-ролей
    // свой больший таймаут (HOST_TIMEOUT_MS: docker-сборка/коммит идут дольше общего
    // ROLE_TIMEOUT_MS), остальные роли — по общему. Иначе тикающий жнец гасит живой
    // прогон раньше времени и освобождает захват (инцидент 10-минутного среза).
    params.push(ROLE_TIMEOUT_MS, CLAUDE_ASSIGN_TIMEOUT_MS, HOST_TIMEOUT_MS, HOST_ROLE_CODES);
    // $3 общий (ROLE_TIMEOUT_MS), $4 программист, $5 host, $6 коды host-ролей.
    agePredicate = `AND ar.started_at < now() - ((CASE WHEN COALESCE(r.code, '') = 'PROGRAMMER' THEN $4
                      WHEN COALESCE(r.code, '') = ANY($6::text[]) THEN $5
                      ELSE $3 END)::bigint * interval '1 millisecond')`;
    // Для осиротевшей host-роли — диагностируемое событие host_orphan_timeout
    // (кто=roleCode, почему, сколько висела=hungMs).
    eventPayload = `CASE WHEN COALESCE(s.role_code, '') = ANY($6::text[])
                      THEN jsonb_build_object('runner', true, 'reason', 'host_orphan_timeout',
                             'runStatus', 'TIMEOUT', 'roleCode', s.role_code, 'hungMs', s.hung_ms)
                      ELSE jsonb_build_object('runner', true, 'reason', $2::text, 'runStatus', 'TIMEOUT') END`;
  }
  // BOOT-RECONCILE-GRACE-001 (требование 3): при стартовом (boot) реапе аннотируем
  // событие меткой bootReconcile + деплой-маркером (APP_CODE_VERSION). Рестарты от
  // собственного деплоя pipeline (docker compose up -d) так отличимы в диагностике
  // от рантайм-орфанов: || сливает объекты, добавляя поля к базовому payload.
  if (boot) {
    params.push(deployRef ?? null);
    eventPayload = `(${eventPayload}) || jsonb_build_object('bootReconcile', true, 'deployRef', $${params.length}::text)`;
  }
  const r = await c.query(
    `WITH stale AS (
       SELECT ar.id, ar.task_id, ar.role_id, r.code AS role_code, t.status::text AS task_status,
              round(extract(epoch from (now() - ar.started_at)) * 1000)::bigint AS hung_ms
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.status = 'RUNNING' ${agePredicate}
     ), done AS (
       UPDATE agent_runs
          SET status = 'TIMEOUT',
              finished_at = now(),
              error_text = $1::text,
              output_json = jsonb_build_object('status', 'TIMEOUT', 'reason', $2::text)
        WHERE id IN (SELECT id FROM stale)
        RETURNING task_id
     ), freed AS (
       UPDATE tasks SET assigned_agent_id = NULL
        WHERE id IN (SELECT task_id FROM stale) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT s.task_id, 'STATUS_CHANGED', s.task_status::task_status, s.task_status::task_status, s.role_id,
            ${eventPayload}
       FROM stale s
       JOIN freed f ON f.id = s.task_id`,
    params,
  );
  return r.rowCount;
}

// ORPHAN-ROLE-REATTACH-001 — восстановить current_role_id у активных задач, потерявших
// роль (NULL) после массовой ручной операции. Такая задача невидима для claim (INNER
// JOIN roles по current_role_id) и зависает навсегда. Роль восстанавливаем из этапов
// проекта двумя путями: ГРАФ-режим (current_stage_key задан) → роль узла по stage_key;
// ЛИНЕЙНЫЙ режим (stage_key пуст) → роль ВКЛЮЧЁННОГО этапа с минимальной позицией, чей
// task_status = статусу задачи (вход в фазу). Терминальные/BLOCKED/ожидающие статусы не
// трогаем. Пишем диагностическое событие. Идемпотентно: чинит только задачи с NULL-ролью.
export async function reattachOrphanStageRoles(c) {
  const r = await c.query(
    `WITH orphan AS (
       SELECT t.id, t.project_id, t.status::text AS status, t.current_stage_key
         FROM tasks t
        WHERE t.current_role_id IS NULL
          AND t.status NOT IN ('DONE','CANCELLED','FAILED','BACKLOG','WAITING_FOR_CHILDREN','BLOCKED','NEEDS_INPUT')
     ), resolved AS (
       SELECT o.id, o.status,
              COALESCE(
                -- граф-режим: роль узла, на котором стоит задача (по current_stage_key)
                (SELECT psr.role_id FROM project_stages ps JOIN project_stage_roles psr ON psr.stage_id = ps.id
                  WHERE ps.project_id = o.project_id AND ps.enabled = true AND ps.stage_key = o.current_stage_key
                  ORDER BY ps.position LIMIT 1),
                -- линейный режим: роль этапа с минимальной позицией для статуса задачи
                (SELECT psr.role_id FROM project_stages ps JOIN project_stage_roles psr ON psr.stage_id = ps.id
                  WHERE ps.project_id = o.project_id AND ps.enabled = true AND ps.task_status::text = o.status
                  ORDER BY ps.position LIMIT 1)
              ) AS role_id
         FROM orphan o
     ), fixed AS (
       UPDATE tasks t SET current_role_id = r.role_id
         FROM resolved r
        WHERE t.id = r.id AND r.role_id IS NOT NULL
        RETURNING t.id, t.status::text AS status, t.current_role_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', status::task_status, status::task_status, current_role_id,
            jsonb_build_object('runner', true, 'reason', 'orphan_role_reattached')
       FROM fixed`,
  );
  return r.rowCount;
}

// ORPHAN-BLOCKED-OWNER-001 — старые BLOCKED-задачи могли потерять current_role_id
// при host/release ветках. BLOCKED не нужно авто-продвигать, но владелец роли нужен
// для UI, фильтров и ручного разбора. Берём последнюю достоверную роль из событий,
// иначе из agent_runs. Статус не меняем.
export async function reattachBlockedOwnerRoles(c) {
  const r = await c.query(
    `WITH orphan AS (
       SELECT t.id, t.status::text AS status
         FROM tasks t
        WHERE t.current_role_id IS NULL
          AND t.status = 'BLOCKED'
     ), resolved AS (
       SELECT o.id, o.status,
              COALESCE(
                (SELECT te.role_id FROM task_events te
                  WHERE te.task_id = o.id AND te.role_id IS NOT NULL
                  ORDER BY te.created_at DESC LIMIT 1),
                (SELECT ar.role_id FROM agent_runs ar
                  WHERE ar.task_id = o.id AND ar.role_id IS NOT NULL
                  ORDER BY ar.started_at DESC LIMIT 1)
              ) AS role_id
         FROM orphan o
     ), fixed AS (
       UPDATE tasks t SET current_role_id = r.role_id
         FROM resolved r
        WHERE t.id = r.id AND r.role_id IS NOT NULL
        RETURNING t.id, t.status::text AS status, t.current_role_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_UPDATED', status::task_status, status::task_status, current_role_id,
            jsonb_build_object('runner', true, 'reason', 'blocked_owner_role_reattached')
       FROM fixed`,
  );
  return r.rowCount;
}

// TASK-DUPLICATE-CLOSE-002 — уборка старых дублей, которые уже успели попасть в
// очередь до дедупа intake/split. Закрываем только безопасный класс: BLOCKED без
// активного назначения, с одинаковым project + service + messageFingerprint.
// WAITING_FOR_CHILDREN/RUNNING не трогаем, чтобы не сиротить дочерние ветки.
//
// FORK-JOIN-DEDUP-ANCESTRY-001 — НЕ закрываем как дубликат fork-подзадачу, чьим
// original_id оказался её собственный предок (parent_task_id или выше по цепочке).
// fork-ребёнок наследует messageFingerprint своего join-родителя и создаётся ПОЗЖЕ
// него, поэтому родитель (самый ранний в партиции) попадает в original_id. Отмена
// такого ребёнка как duplicateOf=предок неверна по сути и вредна по последствиям:
// возвратимый (recoverable) сбой ветки схлопывался бы в CANCELLED и делал
// join_child_failed на родителе НЕОБРАТИМЫМ (задача-родитель залипала в BLOCKED
// навсегда). Обход цепочки предков — WITH RECURSIVE по parent_task_id (как в
// resolveHostTaskContext), но БЕЗ лимита глубины: исключаем предка на ЛЮБОМ уровне,
// а от зацикливания на порченом parent_task_id страхует накопленный путь (path).
export async function closeBlockedDuplicateTasks(c) {
  const r = await c.query(
    `WITH RECURSIVE active AS (
       SELECT t.id, t.project_id, t.service_id, t.status::text AS status,
              t.current_role_id, t.data_card, t.created_at,
              t.data_card->>'messageFingerprint' AS fp,
              first_value(t.id) OVER (
                PARTITION BY t.project_id, t.service_id, t.data_card->>'messageFingerprint'
                ORDER BY t.created_at, t.id
              ) AS original_id,
              count(*) OVER (
                PARTITION BY t.project_id, t.service_id, t.data_card->>'messageFingerprint'
              ) AS dup_count
         FROM tasks t
        WHERE t.status NOT IN ('DONE','CANCELLED','FAILED')
          AND COALESCE(t.data_card->>'messageFingerprint', '') <> ''
     ), candidates AS (
       SELECT id, status, current_role_id, original_id
         FROM active
        WHERE dup_count > 1
          AND id <> original_id
          AND status = 'BLOCKED'
          AND NOT EXISTS (
            SELECT 1 FROM tasks tx WHERE tx.id = active.id AND tx.assigned_agent_id IS NOT NULL
          )
     ), ancestors AS (
       -- Полная цепочка предков каждого кандидата (кандидат → parent → ... по
       -- parent_task_id). Обходим ВСЮ цепочку без искусственного лимита глубины:
       -- fork-ребёнок не может дублировать НИ ОДНОГО из своих предков, как бы далеко
       -- тот ни стоял. От зацикливания на порченом parent_task_id страхует накопленный
       -- путь (path) — в уже посещённого предка повторно не заходим.
       SELECT c0.id AS candidate_id, t.parent_task_id AS ancestor_id,
              ARRAY[c0.id, t.parent_task_id] AS path
         FROM candidates c0
         JOIN tasks t ON t.id = c0.id
        WHERE t.parent_task_id IS NOT NULL
       UNION ALL
       SELECT a.candidate_id, p.parent_task_id, a.path || p.parent_task_id
         FROM ancestors a
         JOIN tasks p ON p.id = a.ancestor_id
        WHERE p.parent_task_id IS NOT NULL
          AND NOT (p.parent_task_id = ANY(a.path))
     ), victims AS (
       SELECT id, status, current_role_id, original_id
         FROM candidates c1
        WHERE NOT EXISTS (
            -- fork-ребёнок не может дублировать своего предка: если original_id есть
            -- в цепочке предков кандидата — исключаем его из victims (оставляем
            -- восстановимым: ре-фид ветки / перезапуск роли, а не CANCELLED).
            SELECT 1 FROM ancestors a
             WHERE a.candidate_id = c1.id AND a.ancestor_id = c1.original_id
          )
     ), fixed AS (
       UPDATE tasks t
          SET status = 'CANCELLED',
              assigned_agent_id = NULL,
              current_role_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb)
                || jsonb_build_object(
                     'duplicateOf', v.original_id,
                     'duplicateNote',
                     'Дубль живой задачи ' || v.original_id || ' (совпал fingerprint): закрыт автоматически'
                   )
         FROM victims v
        WHERE t.id = v.id
        RETURNING t.id, v.status AS from_status, v.current_role_id, v.original_id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT id, 'TASK_CANCELLED', from_status::task_status, 'CANCELLED'::task_status, current_role_id,
            jsonb_build_object(
              'runner', true,
              'reason', 'duplicate_closed',
              'maintenance', 'blocked_duplicate_cleanup',
              'duplicateOf', original_id
            )
       FROM fixed`,
  );
  return r.rowCount;
}

// PROGRAMMER-RELEASE-BACKOFF-001 — предохранитель от вечной петли захвата одной
// задачи программистом. После K = maxFails ПОДРЯД неуспешных PROGRAMMER-прогонов
// (FAILED/TIMEOUT) ПОСЛЕ последнего SUCCESS уводим CODING-задачу из активного пула,
// чтобы она не молотила часами (cooldown лишь тормозит захват, но при бесконечных
// падениях сам по себе петлю не разрывает). Целевой статус — BLOCKED (на человека),
// а НЕ FAILURE_ANALYSIS: инцидентные падения инфраструктурные (агент падает за ~5с,
// кода нет — анализировать нечего), а FAILURE_ANALYST на задаче без реального провала
// пайплайна мгновенно проматывается обратно в CODING (maybeSkipFailureAnalyst,
// last_pipeline != 'FAILED') → тот же тик снова эскалировали бы → тесная петля через
// FAILURE_ANALYSIS. BLOCKED терминально выводит задачу из CODING (её не клеймит ни
// claim, ни свиперы), человек разбирается с корневой причиной. Требование допускает
// оба варианта ("FAILURE_ANALYSIS или BLOCKED с причиной programmer_release_loop"),
// архитектор оставил выбор реализации — выбран BLOCKED как надёжно разрывающий петлю.
// Успешная сдача обнуляет N сама (SUCCESS сдвигает окно счёта) → до K задача не
// доходит на здоровом пути. Один свипер, тикает в преамбуле advanceAutomatedTasks
// рядом с blockExhaustedFailureAnalysis — независимо от фидера.
export async function escalateProgrammerReleaseLoop(c, maxFails = PROGRAMMER_RELEASE_LOOP_MAX) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, cd.n_fail
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_fail
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('FAILED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status = 'CODING'
          AND t.assigned_agent_id IS NULL
          AND r.code = 'PROGRAMMER'
          AND cd.n_fail >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status = 'CODING'
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.n_fail
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'STATUS_CHANGED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'programmer_release_loop', 'failedRuns', b.n_fail)
       FROM blocked b`,
    [Math.max(1, Number(maxFails) || 1)],
  );
  return r.rowCount;
}

// ARCHITECT-BUDGET-LOOP-001 — диагностика мега-эпика, который Архитектор НЕ успевает
// продумать за один прогон. Мега-эпик (раскатка на N сервисов/фронтов с пофайловыми
// инструкциями) упирается в reasoning-таймаут раннера БЕЗ вердикта: прогон отменяется
// (CANCELLED через release-reasoning-task) либо гасится жнецом (TIMEOUT), задача
// переигрывается — и так по кругу, а без диагноза уходит в молчаливый BLOCKED. Здесь:
// после K = maxCancels ПОДРЯД отменённых/просроченных прогонов Архитектора (после
// последнего SUCCESS) уводим ARCHITECTURE-задачу в BLOCKED, но С ВНЯТНОЙ ПРИЧИНОЙ —
// кладём её и в data_card задачи (видно в карточке), и в TASK_BLOCKED-событие. Причина
// подсказывает действие: разбить эпик на пакеты 4–5 сервисов или увеличить бюджет.
// Успешный прогон обнуляет счётчик (окно считается после последнего SUCCESS), поэтому
// на здоровом пути порог не достигается. Один свипер в преамбуле advanceAutomatedTasks
// рядом с escalateProgrammerReleaseLoop — независимо от раннера/движка.
export async function escalateArchitectBudgetLoop(c, maxCancels = ARCHITECT_BUDGET_LOOP_MAX, reason = ARCHITECT_BUDGET_BLOCK_REASON) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, cd.n_cancel
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_cancel
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('CANCELLED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status = 'ARCHITECTURE'
          AND t.assigned_agent_id IS NULL
          AND r.code = 'ARCHITECT'
          AND cd.n_cancel >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb) || jsonb_build_object(
                'architect_budget_block',
                jsonb_build_object('reason', $2::text, 'cancelledRuns', lt.n_cancel))
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status = 'ARCHITECTURE'
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.n_cancel
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'TASK_BLOCKED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'architect_budget_exhausted',
              'cancelledRuns', b.n_cancel, 'detail', $2::text)
       FROM blocked b`,
    [Math.max(1, Number(maxCancels) || 1), reason],
  );
  return r.rowCount;
}

// TASK-RUN-LOOP-CAP-001 — общий предохранитель от бесконечных перезапусков ЛЮБОГО
// этапа. Прогон, оборванный без вердикта (CANCELLED через release, TIMEOUT от
// жнеца), возвращает задачу в очередь — и без порога она перезапускается по кругу,
// жжёт токены, а в UI этап выглядит как «не оставил структурированного результата».
// После K = maxCancels ПОДРЯД безрезультатных прогонов текущей роли (окно — после
// последнего SUCCESS этой роли) задача уводится в BLOCKED с внятной причиной в
// data_card (auto_run_limit — видно в карточке) и TASK_BLOCKED-событии: дальше —
// пуск руками (разобраться и переместить задачу на этап через move). Узкие жнецы
// (Архитектор — ARCHITECT_BUDGET_LOOP_MAX=3, аналитик, программист) срабатывают
// раньше со своими порогами/диагнозами; этот — страховка для всех остальных ролей.
export async function escalateRunawayRoleLoops(c, maxCancels = TASK_RUN_LOOP_MAX, reason = TASK_RUN_LOOP_BLOCK_REASON) {
  const r = await c.query(
    `WITH loop_tasks AS (
       SELECT t.id, t.status::text AS status, t.current_role_id, r.code AS role_code, cd.n_cancel
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         CROSS JOIN LATERAL (
           SELECT count(*) AS n_cancel
             FROM agent_runs ar
            WHERE ar.task_id = t.id
              AND ar.role_id = t.current_role_id
              AND ar.status IN ('CANCELLED','TIMEOUT')
              AND ar.finished_at IS NOT NULL
              -- Окно счёта: после последнего SUCCESS роли И после последнего ручного
              -- перемещения (manual-move) — оператор по runbook разобрался и перезапустил
              -- этап, бюджет выдаётся заново (иначе тот же счётчик мгновенно блокирует повторно).
              AND ar.finished_at > GREATEST(
                    COALESCE((
                      SELECT max(ok.finished_at) FROM agent_runs ok
                       WHERE ok.task_id = t.id AND ok.role_id = t.current_role_id
                         AND ok.status = 'SUCCESS'), '-infinity'::timestamptz),
                    COALESCE((
                      SELECT max(mv.created_at) FROM task_events mv
                       WHERE mv.task_id = t.id AND mv.event_type = 'TASK_UPDATED'
                         AND mv.payload_json->>'via' = 'manual-move'), '-infinity'::timestamptz))
         ) cd
        WHERE t.status NOT IN ('DONE','CANCELLED','FAILED','BLOCKED','WAITING_FOR_CHILDREN','NEEDS_INPUT')
          AND t.assigned_agent_id IS NULL
          AND cd.n_cancel >= $1
     ), blocked AS (
       UPDATE tasks t
          SET status = 'BLOCKED', assigned_agent_id = NULL,
              data_card = COALESCE(t.data_card, '{}'::jsonb) || jsonb_build_object(
                'auto_run_limit',
                jsonb_build_object('reason', $2::text, 'cancelledRuns', lt.n_cancel, 'role', lt.role_code))
         FROM loop_tasks lt
        WHERE t.id = lt.id AND t.status NOT IN ('DONE','CANCELLED','FAILED','BLOCKED')
        RETURNING t.id, lt.status AS from_status, lt.current_role_id AS from_role, lt.role_code, lt.n_cancel
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT b.id, 'TASK_BLOCKED', b.from_status::task_status, 'BLOCKED', b.from_role,
            jsonb_build_object('runner', true, 'reason', 'run_budget_exhausted',
              'role', b.role_code, 'cancelledRuns', b.n_cancel, 'detail', $2::text)
       FROM blocked b`,
    [Math.max(1, Number(maxCancels) || 1), reason],
  );
  return r.rowCount;
}

// TESTS-GREEN-SKIP-FA-001 (fix B) — увести в BLOCKED задачи, застрявшие в анализе
// сбоя на реальном провале тестов после исчерпания попыток. Считаем таймауты/провалы
// прогонов аналитика как rework-попытки: при >= maxAttempts безрезультатных прогонов
// (и при последнем pipeline_run = FAILED) задача блокируется на человека, а не крутится
// в FAILURE_ANALYSIS бесконечно. Зелёные задачи здесь не трогаем — их продвигает
// вперёд maybeSkipFailureAnalyst (поэтому условие явно требует last_pipeline = 'FAILED').
export async function blockExhaustedFailureAnalysis(c, maxAttempts = MAX_REWORK) {
  const r = await c.query(
    `WITH fa AS (
       SELECT t.id, t.status::text AS status, t.current_role_id,
              (SELECT pr.status::text FROM pipeline_runs pr WHERE pr.task_id = t.id
                ORDER BY pr.finished_at DESC NULLS LAST, pr.started_at DESC LIMIT 1) AS last_pipeline,
              (SELECT count(*) FROM agent_runs ar
                WHERE ar.task_id = t.id AND ar.role_id = t.current_role_id
                  AND ar.status IN ('TIMEOUT','FAILED')) AS bad_runs
         FROM tasks t JOIN roles r ON r.id = t.current_role_id
        WHERE t.status = 'FAILURE_ANALYSIS' AND t.assigned_agent_id IS NULL AND r.code = 'FAILURE_ANALYST'
     ), exhausted AS (
       SELECT id, status, current_role_id FROM fa
        WHERE last_pipeline = 'FAILED' AND bad_runs >= $1
     ), blocked AS (
       UPDATE tasks SET status = 'BLOCKED'
        WHERE id IN (SELECT id FROM exhausted) AND status NOT IN ('DONE','CANCELLED')
        RETURNING id
     )
     INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     SELECT e.id, 'STATUS_CHANGED', e.status::task_status, 'BLOCKED', e.current_role_id,
            jsonb_build_object('runner', true, 'reason', 'failure_analysis_exhausted')
       FROM exhausted e
      WHERE e.id IN (SELECT id FROM blocked)`,
    [Math.max(1, Number(maxAttempts) || 1)],
  );
  return r.rowCount;
}

// DOC-BRANCH-LIVENESS-001 — живучесть документационной fork-ветви. Документация
// (Documentation Auditor/Keeper) идёт ПАРАЛЛЕЛЬНО коммиту через fork/join и вправе
// выполняться дольше. Но если её этап реально «мёртв» — задача-ветвь ушла в
// BLOCKED/FAILED, либо накопила >= maxAttempts безрезультатных прогонов
// (TIMEOUT/FAILED) под текущей документационной ролью — она НЕ должна вечно держать
// парный join, заклинивая родителя в WAITING_FOR_CHILDREN. Продвигаем такого
// документационного ребёнка на ОДИН узел вперёд по графу ветки: к следующей
// документационной роли (честная попытка), а в конце ветки — на join-узел, откуда
// advanceJoinNodes завершит ветку (DONE) и снимет барьер родителя. A1 (roleEngine)
// закрывает «здоровый» путь (BLOCKED-вердикт → forward сразу); этот подметатель —
// сеть безопасности для таймаутов/сбоев вызова ИИ и осиротевших после ручных операций.
export async function advanceStuckDocumentationBranches(c, maxAttempts = MAX_REWORK, maxAgeMs = DOC_BRANCH_MAX_AGE_MS) {
  // DOCROLES-GI-SERIALIZE-001: единый источник правды по ролям doc-ветви (тот же
  // набор придерживает claim doc-роли в claimLlmRoleTask, пока git-сиблинг стоит на
  // GIT_INTEGRATOR — GI вливает дельту Программиста в чистое дерево раньше doc-правок).
  const DOC_ROLES = DOC_BRANCH_ROLE_CODES;
  const stuck = await c.query(
    `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id,
            t.current_stage_key, r.code AS role_code,
            (SELECT count(*) FROM agent_runs ar
              WHERE ar.task_id = t.id AND ar.role_id = t.current_role_id
                AND ar.status IN ('TIMEOUT','FAILED'))::int AS bad_runs,
            (extract(epoch from (now() - t.updated_at)) * 1000)::bigint AS age_ms
       FROM tasks t JOIN roles r ON r.id = t.current_role_id
      WHERE t.assigned_agent_id IS NULL
        AND t.parent_task_id IS NOT NULL
        AND r.code = ANY($1::text[])
        AND t.status NOT IN ('DONE','CANCELLED')`,
    [DOC_ROLES],
  );
  const limit = Math.max(1, Number(maxAttempts) || 1);
  const ageLimit = Math.max(60_000, Number(maxAgeMs) || 0);
  let moved = 0;
  for (const t of stuck.rows) {
    // Ветвь считается «мёртвой» и продвигается к join, если: она в терминальном для
    // ветки состоянии (BLOCKED/FAILED); ИЛИ исчерпала попытки (bad_runs); ИЛИ просто
    // висит дольше ageLimit без продвижения (движок документации не создаёт прогонов —
    // напр. codex-драйвер завис: bad_runs=0, но родитель не должен ждать вечно).
    const exhausted =
      t.status === 'BLOCKED' || t.status === 'FAILED' ||
      Number(t.bad_runs) >= limit || Number(t.age_ms) >= ageLimit;
    if (!exhausted) continue;
    const loaded = await loadProjectGraph(c, t.project_id);
    if (!loaded) continue; // линейный проект — здесь fork-ветвей нет
    // Восстановить узел ветки, если stage_key потерян (осиротел после ручных операций):
    // узел с этой ролью (предпочтительно совпадающий по статусу).
    let stageKey = t.current_stage_key;
    if (!stageKey) {
      const byRoleAndStatus = loaded.nodes.find(
        (n) => n.roleId === t.current_role_id && n.status === t.status,
      );
      stageKey = (byRoleAndStatus ?? loaded.nodes.find((n) => n.roleId === t.current_role_id))?.stageKey ?? null;
    }
    if (!stageKey) continue;
    const claimedLike = {
      id: t.id, project_id: t.project_id, current_stage_key: stageKey,
      role_code: t.role_code, status: t.status,
    };
    const resolved = await resolveGraphTransition(c, claimedLike, {
      outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason: 'documentation_exhausted',
    });
    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);
    await withTransaction(c, async () => {
      const upd = await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL
          WHERE id = $1 AND assigned_agent_id IS NULL AND status NOT IN ('DONE','CANCELLED')`,
        [t.id, resolved.toStatus, nextRoleId, resolved.nextStageKey ?? null],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
          [t.id, resolved.done ? 'TASK_DONE' : 'STATUS_CHANGED', t.status, resolved.toStatus, t.current_role_id,
           JSON.stringify({
             runner: true, reason: 'documentation_branch_advanced',
             from: t.role_code, badRuns: t.bad_runs, ageMs: Number(t.age_ms),
             trigger: (t.status === 'BLOCKED' || t.status === 'FAILED') ? t.status
               : (Number(t.bad_runs) >= limit ? 'bad_runs' : 'age'),
             nextRole: resolved.nextRole,
           })],
        );
        moved += 1;
      }
    });
  }
  return moved;
}

/**
 * GI-RESYNC-RETRY-001 — ресинк статуса задач с реальным main. Задача, заблокированная
 * Git Integrator'ом git-причиной (GI_RESYNC_NOTES), часто уже РАЗРЕШИМА: ветку
 * пересадили на свежий main (WORKTREE-REBASE-STALE-001), сиблинг/ручная доставка влили
 * контент. ОДНОКРАТНО (маркер data_card.gi_resync_retry) возвращаем такую задачу на
 * COMMIT после grace-периода — host-runner переклеймит её на GIT_INTEGRATOR, а GI сам
 * разрулит (already_integrated_content) либо честно заблокирует снова (реальный конфликт;
 * маркер не даст ретраить второй раз). Контекст (worktreeBranch/deliveredCommit) GI
 * пересоберёт из истории событий (DELIVERED-COMMIT-COUPLE-001), поэтому доп. данных не нужно.
 *
 * Дополнительно переоткрываем CHILD-DRIVEN заблокированных ПРЕДКОВ (fork-родитель /
 * эпик), чьи блоки — следствие роллапа по этому ребёнку (последнее событие блока
 * from_status='WAITING_FOR_CHILDREN'): переводим их обратно в WAITING_FOR_CHILDREN,
 * чтобы join/rollup пересобрали их, когда ребёнок разрешится. Блоки, поставленные
 * человеком/иной причиной (не из WFC), НЕ трогаем. Идемпотентно. Клапан GI_RESYNC_RETRY=0.
 */
export async function retryGiBlockedForResync(c) {
  if (!GI_RESYNC_RETRY_ENABLED) return { retried: 0, reopened: 0 };
  // (1) Ретрай GI-заблокированных задач: BLOCKED → COMMIT, маркер, только git-причины,
  // роль GIT_INTEGRATOR, старше grace, ещё не ретраенные.
  // CTE: сначала кандидаты (LATERAL к последнему событию блока разрешён внутри SELECT,
  // где tasks в FROM), затем UPDATE FROM cand. LATERAL нельзя ссылаться на цель UPDATE.
  const upd = await c.query(
    `WITH cand AS (
        SELECT t.id, t.current_role_id, lb.n AS reason
          FROM tasks t
          JOIN roles r ON r.code = 'GIT_INTEGRATOR' AND r.id = t.current_role_id
          CROSS JOIN LATERAL (
            SELECT coalesce(te.payload_json->'output'->>'note', te.payload_json->>'reason') AS n,
                   te.created_at AS at
              FROM task_events te
             WHERE te.task_id = t.id AND te.to_status = 'BLOCKED'
             ORDER BY te.created_at DESC LIMIT 1
          ) lb
         WHERE t.status = 'BLOCKED'
           AND t.assigned_agent_id IS NULL
           AND NOT (t.data_card ? 'gi_resync_retry')
           AND lb.n = ANY($1::text[])
           AND lb.at < now() - ($2::bigint * interval '1 millisecond')
     )
     UPDATE tasks t
        SET status = 'COMMIT', updated_at = now(),
            data_card = coalesce(t.data_card, '{}'::jsonb)
                        || jsonb_build_object('gi_resync_retry',
                             jsonb_build_object('at', now()::text, 'reason', cand.reason))
       FROM cand
      WHERE t.id = cand.id
      RETURNING t.id, t.current_role_id, cand.reason AS reason`,
    [GI_RESYNC_NOTES, GI_RESYNC_GRACE_MS],
  );
  const retriedIds = upd.rows.map((r) => r.id);
  for (const row of upd.rows) {
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', 'BLOCKED', 'COMMIT', $2, $3::jsonb)`,
      [row.id, row.current_role_id, JSON.stringify({
        runner: true, reason: 'gi_resync_retry', from: row.reason,
        detail: 'Однократный авто-ретрай Git Integrator: контент дельты мог уже попасть в main.',
      })],
    );
  }
  if (!retriedIds.length) return { retried: 0, reopened: 0 };

  // (2) Переоткрыть child-driven заблокированных предков ретраенных задач: BLOCKED →
  // WAITING_FOR_CHILDREN, только если ПОСЛЕДНЕЕ событие блока предка — из WFC (роллап
  // по ребёнку), а не человеческий/иной блок. join/rollup пересоберут их сами.
  const reop = await c.query(
    `WITH RECURSIVE anc AS (
        SELECT parent_task_id AS id FROM tasks
         WHERE id = ANY($1::uuid[]) AND parent_task_id IS NOT NULL
        UNION
        SELECT t.parent_task_id FROM tasks t JOIN anc ON t.id = anc.id
         WHERE t.parent_task_id IS NOT NULL
     ),
     cand AS (
        SELECT p.id
          FROM tasks p
          CROSS JOIN LATERAL (
            SELECT te.from_status::text AS fs
              FROM task_events te
             WHERE te.task_id = p.id AND te.to_status = 'BLOCKED'
             ORDER BY te.created_at DESC LIMIT 1
          ) lb
         WHERE p.id IN (SELECT id FROM anc WHERE id IS NOT NULL)
           AND p.status = 'BLOCKED'
           AND p.assigned_agent_id IS NULL
           AND lb.fs = 'WAITING_FOR_CHILDREN'
     )
     UPDATE tasks p
        SET status = 'WAITING_FOR_CHILDREN', updated_at = now()
       FROM cand
      WHERE p.id = cand.id
      RETURNING p.id`,
    [retriedIds],
  );
  for (const row of reop.rows) {
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', 'BLOCKED', 'WAITING_FOR_CHILDREN', NULL, $2::jsonb)`,
      [row.id, JSON.stringify({
        runner: true, reason: 'gi_resync_reopen_parent',
        detail: 'Предок переоткрыт: ребёнок Git Integrator отправлен на ресинк-ретрай.',
      })],
    );
  }
  return { retried: retriedIds.length, reopened: reop.rowCount };
}

/**
 * Стартовая реконсиляция (вызывается один раз при запуске оркестратора).
 *
 * BOOT-RECONCILE-GRACE-001. Прежняя реализация исходила из того, что при полном
 * перезапуске активных сессий в полёте нет, и гасила ВСЕ RUNNING безусловно
 * (reapOrphanRunningRuns без ageCheck) + освобождала ВСЕ Programmer-назначения
 * немедленно (timeoutMs=0). Но деплой-стадия pipeline сама пересоздаёт контейнер
 * оркестратора (docker compose up -d), а живые host-runner'ы и Claude-агенты
 * переживают рестарт и досдают результат — значит каждый прогон pipeline убивал
 * чужие живые прогоны (ложный TIMEOUT, искажённый KPI роли).
 *
 * Теперь щадящий boot-reconcile: гасим ТОЛЬКО прогоны старше штатного таймаута
 * своей роли (ageCheck=true → CASE по роли: PROGRAMMER/host свои таймауты). Более
 * молодые RUNNING остаются «осиротевшими кандидатами» — их досдаст переживший
 * рестарт исполнитель, либо добьёт штатный жнец на тике (reapOrphanRunningRuns
 * ageCheck=true) / released-backoff по истечении таймаута (без задвоения — тот же
 * возрастной предикат). boot=true метит событие деплой-маркером (требование 3).
 * Programmer-назначения тоже освобождаем только по штатному таймауту
 * (CLAUDE_ASSIGN_TIMEOUT_MS), а не немедленно.
 *
 * Возвращает число освобождённых Programmer-задач.
 */
export async function reconcileOnStartupTx(c, { deployRef = null } = {}) {
  await reapOrphanRunningRuns(c, { ageCheck: true, boot: true, deployRef });
  return releaseStaleClaudeClaims(c, CLAUDE_ASSIGN_TIMEOUT_MS, 'orchestrator_restart_reconcile');
}

export async function reconcileOnStartup(s, { deployRef = process.env.APP_CODE_VERSION ?? null } = {}) {
  return withClient(clientConfig(s), (c) => reconcileOnStartupTx(c, { deployRef }));
}
