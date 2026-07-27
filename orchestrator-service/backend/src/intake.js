// Приём/интейк задач: завершения программиста от Scanner (acceptScannerCompletion),
// scanner-интейк новой задачи, канал «интеграции в приложения» (acceptIntakeReport),
// дедуп/закрытие дублей, авто-регистрация сервисов и резолверы проекта/входа.
import { withClient, clientConfig, roleIdByCode } from './dbCore.js';
import { withTransaction } from './transaction.js';
import { scannerError, resultSummaryText, looksCorruptedText, normalizeScannerCompletion } from './scannerCompat.js';
import { loadProjectRoute, loadRoleContract } from './routeLoaders.js';
import { routeIsUsable, resolveTransition } from './projectRoute.js';
import { ROLE_FLOW } from './rolePipeline.js';
import { shouldSkipReviewerForSmallTask, computeTaskPriority, isOrchestratorProject } from './taskPolicy.js';
import { extractOutputs } from './fieldsContract.js';
import { asObject } from './dataCard.js';
import { deriveServicePathFromFiles } from './serviceRepoPath.js';
import { hashToken, messageFingerprint } from './intakeIntegrations.js';
import { exportLatestAgentRunObservation } from './clickhouseObservability.js';
import { normalizeRunKpi, runKpiSet } from './db.js';

// PROGRAMMER-UNIFY-001 — финализировать RUNNING-прогон программиста при успешной
// сдаче. Захват создал ровно один agent_run RUNNING на эту задачу под ролью
// PROGRAMMER; переводим его в SUCCESS с KPI (turns=passes, model, code_version) —
// так программист считается в «Мониторе» (roleLoad) и версиях единообразно с
// рассуждающими ролями. Толерантно: нет прогона (legacy/прямое создание задачи) —
// 0 строк, сдача не падает. roleId — роль на момент ЗАХВАТА (PROGRAMMER), а не
// после продвижения задачи.
// BOOT-RECONCILE-GRACE-001: сопоставляем последний прогон в статусе RUNNING ЛИБО
// TIMEOUT. Claude-агент переживает рестарт оркестратора и досдаёт результат; если
// boot-жнец успел пометить прогон TIMEOUT, поздняя сдача переписывает исход на
// фактический SUCCESS (иначе KPI роли навсегда считает реально успешный прогон
// таймаутом). Свежий RUNNING имеет больший started_at и выбирается раньше старого
// TIMEOUT, поэтому переписываем именно осиротевший прогон этой сдачи.
async function finalizeProgrammerRunOnCompletion(c, { taskId, roleId, payload }) {
  if (roleId == null) return;
  // Читаемый summary (не «[object Object]») в output_json прогона — его же тянет
  // priorRoleOutputs в контекст следующих ролей.
  const summary = (resultSummaryText(payload?.result) || payload?.title || 'completed').slice(0, 2000);
  // OBSERVABILITY-PROGRAMMER-KPI-001 — usage/cost/cold start сдачи программиста в
  // agent_runs через те же хелперы, что и рассуждающие роли. Контракт с раннером:
  // tokensIn/tokensOut/tokensCacheRead/tokensCacheCreation/costUsd/coldStartMs +
  // numTurns (→ turns). token_input/output/cache/cost идут через COALESCE в
  // runKpiSet, поэтому СТАРЫЙ раннер без этих полей не затирает данные (остаются
  // нули/прежние значения) — обратная совместимость. Исход сдачи — всегда success.
  const kpi = normalizeRunKpi({ ...payload, turns: payload?.numTurns, outcome: 'success' });
  const outputJson = JSON.stringify({ status: 'DONE', summary, changedFiles: payload?.changedFiles ?? [] });
  const kpiSet = runKpiSet(kpi, 2);
  const roleIdx = 2 + kpiSet.params.length + 1;
  await c.query(
    `UPDATE agent_runs
        SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql}
      WHERE id = (
        SELECT id FROM agent_runs
         WHERE task_id = $1 AND role_id = $${roleIdx} AND status IN ('RUNNING','TIMEOUT')
         ORDER BY started_at DESC LIMIT 1
      )`,
    [taskId, outputJson, ...kpiSet.params, roleId],
  );
}

// STALE-COMPLETION-ROLE-GUARD-001 — вывести роль-источник сдачи из completionKey.
// Ключ сдачи программиста имеет вид `programmer-${taskRowId}-${agentAssignedEventId}`
// (см. claimNextClaudeTask), поэтому префикс кодирует роль-исполнителя, сделавшую
// сдачу. Неизвестный формат → null: ожидание роли не задаётся и guard не срабатывает
// (обратная совместимость с ключами без префикса роли).
function roleFromCompletionKey(key) {
  return String(key ?? '').startsWith('programmer-') ? 'PROGRAMMER' : null;
}

// REVIEWER-ONE-REWORK-001: считаем только реальные возвраты reviewer на Programmer.
// Общий reworkCount исторически считает FAILURE_ANALYSIS и не защищает эту петлю.
export async function countTaskReviewerReworks(c, taskId) {
  const r = await c.query(
    `SELECT count(*)::int AS n
       FROM task_events e
       JOIN roles r ON r.id = e.role_id
      WHERE e.task_id = $1
        AND r.code = 'TASK_REVIEWER'
        AND e.from_status = 'REVIEW'
        AND e.to_status = 'CODING'
        AND e.payload_json->>'outcome' = 'REWORK'`,
    [taskId],
  );
  return Number(r.rows[0]?.n) || 0;
}

async function resolveAfterSkippedReviewer(c, route, task, currentStatus, currentStageKey) {
  if (routeIsUsable(route)) {
    const resolved = resolveTransition(route, 'TASK_REVIEWER', { outcome: 'FORWARD' }, {
      currentStatus,
      currentStageKey,
    });
    return {
      toStatus: resolved.toStatus,
      nextRoleCode: resolved.nextRole,
      nextStageKey: resolved.nextStageKey ?? null,
      nextRoleId: resolved.done || !resolved.nextRole ? null : await roleIdByCode(c, resolved.nextRole),
    };
  }
  const flow = ROLE_FLOW.TASK_REVIEWER;
  return {
    toStatus: flow.to,
    nextRoleCode: flow.next,
    nextStageKey: null,
    nextRoleId: flow.next ? await roleIdByCode(c, flow.next) : null,
  };
}

/**
 * Принять завершение от файлового Scanner bridge и передать задачу Task Reviewer.
 * scanner_dispatches и транзакция обеспечивают exactly-once переход на стороне БД.
 */
export async function acceptScannerCompletion(s, input) {
  const payload = normalizeScannerCompletion(input);
  return withClient(clientConfig(s), async (c) => {
    const result = await acceptScannerCompletionTx(c, payload);
    if (result?.accepted && !result.duplicate) {
      await exportLatestAgentRunObservation(c, result.taskId || payload.taskId, {
        eventType: 'programmer_completion',
        roleCode: 'PROGRAMMER',
        reason: result.kind === 'subtask' ? 'programmer_subtask_done' : 'programmer_completed',
        payload: { result },
      });
    }
    return result;
  });
}

/**
 * Транзакционное ядро приёма завершения Programmer (тестируется с fake-клиентом).
 * payload уже нормализован normalizeScannerCompletion.
 */
export async function acceptScannerCompletionTx(c, payload) {
  {
    await c.query('BEGIN');
    try {
      // Задачи может не быть в БД (её завели прямо в документе Claude) — тогда
      // Scanner создаёт её ПО координатам completion, но только внутри уже
      // зарегистрированного вручную проекта и сервиса. Проверки соответствия
      // проекта/сервиса и их существования выполняет findOrCreateScannerTask.
      const { task, created } = await findOrCreateScannerTask(c, payload);
      if (['DONE', 'CANCELLED'].includes(task.status)) throw scannerError(409, 'task_is_terminal');

      const inserted = await c.query(
        `INSERT INTO scanner_dispatches
           (task_id, source_document, completion_key, payload_json)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (task_id, completion_key) DO NOTHING
         RETURNING id`,
        [payload.taskId, payload.sourceDocument, payload.completionKey, JSON.stringify(payload)],
      );
      if (!inserted.rowCount) {
        await c.query('COMMIT');
        return { accepted: true, duplicate: true, autoCreated: created, taskId: payload.taskId, nextRole: 'TASK_REVIEWER' };
      }

      // STALE-COMPLETION-ROLE-GUARD-001: сдача, чей completionKey кодирует роль
      // PROGRAMMER (префикс `programmer-`), НЕ может закрывать этап, чей текущий
      // исполнитель — другая роль (задача уже ушла с CODING, напр. держится
      // PIPELINE_SERVICE на TESTING). Иначе fromRole берётся из
      // task.current_role_code и resolveTransition(FORWARD) закрывает ЧУЖОЙ этап
      // именем программиста — так дубль/опоздавшая сдача программиста закрыла TESTING
      // в COMMIT и затёрла changedFiles реальной сдачи (инцидент f43a9f6c). Дедуп по
      // (task_id, completion_key) это не ловит, если у сдачи новый ключ. Маршрут не
      // продвигаем; dispatch уже зафиксирован как «увиден и проигнорирован» —
      // фиксируем транзакцию и возвращаем сдачу как stale-дубль.
      const expectedRole = roleFromCompletionKey(payload.completionKey);
      if (expectedRole && task.current_role_code && task.current_role_code !== expectedRole) {
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: true, stale: true, autoCreated: created,
          taskId: payload.taskId, currentRole: task.current_role_code,
          expectedRole, nextRole: null,
        };
      }

      // Завершение Programmer → продвижение по маршруту проекта
      // (PIPELINE-DYNAMIC-ROUTE-001). Канонический фолбэк — REVIEW/TASK_REVIEWER.
      const route = await loadProjectRoute(c, task.project_id);
      const fromRole = task.current_role_code || 'PROGRAMMER';
      let toStatus = 'REVIEW';
      let nextRoleId = task.reviewer_role_id;
      let nextRoleCode = 'TASK_REVIEWER';
      // FORK-JOIN-STAGEKEY-001: при продвижении Programmer'а переносим и ПОЗИЦИЮ в
      // графе (current_stage_key), а не только status/role. Иначе задача с непустым
      // stage_key (graph-режим — её порождают Архитектор/work_stack) уходила в REVIEW,
      // но stage_key застревал на узле Programmer, и guard захвата claimLlmRoleTask
      // (ps.stage_key = current_stage_key) для этапа ревьюера не совпадал — задачу не
      // брал ни один движок и она зависала в REVIEW. Зеркалим host-путь
      // (completeHostTaskTx: current_stage_key = resolved.nextStageKey ?? null).
      // Линейный/канонический маршрут (route не usable) оставляет NULL — guard
      // трактует NULL как wildcard, поэтому такие задачи claim'ятся как раньше.
      let nextStageKey = null;
      if (routeIsUsable(route)) {
        const resolved = resolveTransition(route, fromRole, { outcome: 'FORWARD' }, {
          currentStatus: task.status,
          currentStageKey: task.current_stage_key,
        });
        toStatus = resolved.toStatus;
        nextRoleCode = resolved.nextRole;
        nextStageKey = resolved.nextStageKey ?? null;
        nextRoleId = resolved.done || !resolved.nextRole
          ? null
          : await roleIdByCode(c, resolved.nextRole);
      }
      let skippedReviewer = false;
      let skipReason;
      if (nextRoleCode === 'TASK_REVIEWER') {
        // TASK-SIZE-TRIAGE-001 + REVIEWER-SKIP-GUARD-001: мелкая задача (size=small)
        // может пропустить Reviewer — НО только если фактическая дельта действительно
        // узкая и низкорисковая (shouldSkipReviewerForSmallTask сверяет changedFiles с
        // рискованными зонами: миграции/БД/контракты/инфра/auth, лимит файлов, cross-
        // service). Иначе ошибочный small протащил бы опасную правку мимо ревью → ведём
        // как medium (в Task Reviewer). Продвигаем мимо Reviewer тем же
        // resolveAfterSkippedReviewer, что и REVIEW-SKIP-REWORK-LIMIT-001 (анти-петля
        // после ≥1 возврата Reviewer→Programmer). Размер проверяем ПЕРВЫМ — короткое
        // замыкание не гоняет лишний запрос счётчика возвратов для small.
        const small = shouldSkipReviewerForSmallTask(task, payload);
        const reworkLimit = !small && (await countTaskReviewerReworks(c, payload.taskId)) >= 1;
        if (small || reworkLimit) {
          const skipped = await resolveAfterSkippedReviewer(c, route, task, toStatus, nextStageKey);
          toStatus = skipped.toStatus;
          nextRoleCode = skipped.nextRoleCode;
          nextStageKey = skipped.nextStageKey;
          nextRoleId = skipped.nextRoleId;
          skippedReviewer = true;
          skipReason = small ? 'task_size_small' : 'review_rework_limit_forwarded';
        }
      }

      // Поля Programmer → кумулятивная карточка задачи.
      const progContract = await loadRoleContract(c, fromRole);
      const { values: progCardValues, missingRequired } = extractOutputs(
        payload.fields ?? { result: payload.result, changedFiles: payload.changedFiles },
        progContract.outputs,
      );
      // Строгий режим контракта роли: вернуть задачу нельзя, пока заполнены не все
      // обязательные исходящие поля. «Настройка» — сам контракт (role_fields): если
      // обязательных полей у роли нет, missingRequired пуст и сдача проходит без
      // требований. ROLLBACK откатит и запись scanner_dispatches, чтобы повтор с
      // заполненными полями не считался дублем.
      if (missingRequired.length) {
        const err = scannerError(422, 'missing_required_fields');
        err.code = 'missing_required_fields';
        err.errors = missingRequired;
        throw err;
      }

      // DECOMP-CONTRACT-001: подзадача-на-файл при сдаче закрывается в DONE
      // (терминально), а её родитель (задача-на-сервис) уходит в REVIEW к Task
      // Reviewer ТОЛЬКО когда у него не осталось открытых подзадач. Одиночные
      // legacy-задачи (kind != subtask) ведут себя как раньше — сразу в REVIEW.
      if (task.task_kind === 'subtask') {
        await c.query(
          `UPDATE tasks SET status = 'DONE', assigned_agent_id = NULL, data_card = data_card || $2::jsonb
            WHERE id = $1`,
          [payload.taskId, JSON.stringify(progCardValues || {})],
        );
        await c.query(
          `INSERT INTO task_events
             (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_DONE', $2::task_status, 'DONE', $3, $4::jsonb)`,
          [payload.taskId, task.status, task.current_role_id, JSON.stringify({
            source: 'scanner', completionKey: payload.completionKey, service: payload.service,
            result: resultSummaryText(payload.result), changedFiles: payload.changedFiles,
            worktreeBranch: payload.worktreeBranch, deliveredCommit: payload.deliveredCommit,
            fields: progCardValues,
            parentTaskId: task.parent_task_id, kind: 'subtask', passes: payload.numTurns,
            codeVersion: payload.codeVersion, model: payload.model,
          })],
        );
        // Промоут родителя, если открытых подзадач не осталось.
        let parentPromoted = false;
        if (task.parent_task_id) {
          const open = await c.query(
            `SELECT count(*)::int AS n FROM tasks
              WHERE parent_task_id = $1 AND task_kind = 'subtask'
                AND status NOT IN ('DONE','CANCELLED')`,
            [task.parent_task_id],
          );
          if (open.rows[0].n === 0) {
            const parent = await c.query(
              `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
                      current_stage_key = $4::uuid
                WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'
                RETURNING status`,
              [task.parent_task_id, toStatus, nextRoleId, nextStageKey],
            );
            if (parent.rowCount) {
              parentPromoted = true;
              await c.query(
                `INSERT INTO task_events
                   (task_id, event_type, from_status, to_status, role_id, payload_json)
                 VALUES ($1, 'STATUS_CHANGED', 'WAITING_FOR_CHILDREN', $4::task_status, $2, $3::jsonb)`,
                [task.parent_task_id, nextRoleId, JSON.stringify({
                  source: 'scanner', reason: 'all_subtasks_done', nextRole: nextRoleCode, kind: 'service',
                  skippedReviewer, skipReason,
                }), toStatus],
              );
            }
          }
        }
        await finalizeProgrammerRunOnCompletion(c, {
          taskId: payload.taskId, roleId: task.current_role_id, payload,
        });
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: false, autoCreated: created, taskId: payload.taskId,
          kind: 'subtask', parentTaskId: task.parent_task_id, parentPromoted,
          nextRole: parentPromoted ? nextRoleCode : null,
        };
      }

      await c.query(
        `UPDATE tasks
         SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
             data_card = data_card || $4::jsonb, current_stage_key = $5::uuid
         WHERE id = $1`,
        [payload.taskId, toStatus, nextRoleId, JSON.stringify(progCardValues || {}), nextStageKey],
      );
      await c.query(
        `INSERT INTO task_events
           (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, $5::task_status, $3, $4::jsonb)`,
        [payload.taskId, task.status, nextRoleId, JSON.stringify({
          source: 'scanner',
          completionKey: payload.completionKey,
          service: payload.service,
          result: resultSummaryText(payload.result),
          changedFiles: payload.changedFiles,
          worktreeBranch: payload.worktreeBranch,
          deliveredCommit: payload.deliveredCommit,
          nextRole: nextRoleCode,
          skippedReviewer,
          skipReason,
          fields: progCardValues,
          passes: payload.numTurns,
          codeVersion: payload.codeVersion,
          model: payload.model,
        }), toStatus],
      );
      await finalizeProgrammerRunOnCompletion(c, {
        taskId: payload.taskId, roleId: task.current_role_id, payload,
      });
      await c.query('COMMIT');
      return { accepted: true, duplicate: false, autoCreated: created, taskId: payload.taskId, nextRole: nextRoleCode };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
}

// Найти проект по id (uuid) | code | name | root_path. В отличие от requireProject
// НЕ бросает ошибку при отсутствии — возвращает null (для интейка: нет проекта →
// задача становится «неразобранной»). Сравнение по id через ::text безопасно для
// произвольной строки (без падения на не-uuid).
export async function findProject(c, ref) {
  const v = String(ref ?? '').trim();
  if (!v) return null;
  // Быстрый путь: точное совпадение по id/code/name/root_path.
  const exact = await c.query(
    `SELECT id, code, root_path FROM projects
      WHERE id::text = $1 OR code = $1 OR name = $1 OR root_path = $1
      ORDER BY created_at LIMIT 1`,
    [v],
  );
  if (exact.rowCount) return exact.rows[0];
  // projectPath может прийти с другим регистром диска (F:\ vs f:\) или иными слешами —
  // на Windows root_path регистронезависим и «\» ≡ «/». Тогда точное сравнение выше
  // промахивается, и задача уходит в «Неразобранные». Сопоставляем НОРМАЛИЗОВАННО
  // (только по пути; id/code/name остаются строгими) среди всех проектов — их единицы.
  const vNorm = normalizeProjectPath(v);
  if (!vNorm) return null;
  const all = await c.query('SELECT id, code, root_path FROM projects ORDER BY created_at');
  return all.rows.find((row) => normalizeProjectPath(row.root_path) === vNorm) ?? null;
}

// Нормализация пути проекта для регистро/сепаратор-независимого сравнения:
// «\» → «/», срез хвостовых слешей, нижний регистр. Пусто → ''.
function normalizeProjectPath(p) {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Вычислить роль входа, стартовый узел графа и стартовый статус для задачи проекта.
// В граф-схеме (есть рёбра) задача стартует на узле с ролью входа; в линейной —
// stageKey NULL. Для неразобранной задачи (projectId = null) рёбер нет → stageKey NULL.
//
// TASK-INTAKE-OFFICER-MCP-001: entryRoleCode позволяет постановщику через MCP сдать
// уже выполненный интейк напрямую в целевую роль (например ARCHITECT) — задача
// создаётся сразу в статусе её этапа (ARCHITECTURE), минуя пайплайновый Приёмщик/
// BACKLOG. Если запрошенная роль входа не разрешается в включённый этап проекта —
// безопасный откат к штатному входу (Приёмщик, BACKLOG).
export async function computeEntry(c, projectId, entryRoleCode = null) {
  const requested = String(entryRoleCode ?? '').trim().toUpperCase() || null;
  if (requested && projectId) {
    const r = await c.query(
      `SELECT r.id, r.code, ps.stage_key, ps.task_status::text AS task_status,
              EXISTS (SELECT 1 FROM project_stage_edges e WHERE e.project_id = $1) AS has_edges
         FROM project_stages ps
         JOIN project_stage_roles psr ON psr.stage_id = ps.id
         JOIN roles r ON r.id = psr.role_id
        WHERE ps.project_id = $1 AND r.code = $2 AND ps.enabled = true
          AND ps.task_status IS NOT NULL
        ORDER BY ps.position LIMIT 1`,
      [projectId, requested],
    );
    if (r.rowCount) {
      const row = r.rows[0];
      return {
        role: { id: row.id, code: row.code },
        entryStageKey: row.has_edges ? row.stage_key : null,
        status: row.task_status,
      };
    }
    // Роль входа не нашлась среди включённых этапов проекта — падаем на штатный вход.
  }
  const role = await entryRole(c);
  if (!projectId) return { role, entryStageKey: null, status: 'BACKLOG' };
  const hasEdges = (await c.query(
    'SELECT 1 FROM project_stage_edges WHERE project_id = $1 LIMIT 1', [projectId],
  )).rowCount > 0;
  let entryStageKey = null;
  if (hasEdges) {
    const es = await c.query(
      `SELECT ps.stage_key FROM project_stages ps
         JOIN project_stage_roles psr ON psr.stage_id = ps.id
        WHERE ps.project_id = $1 AND psr.role_id = $2 AND ps.enabled = true
        ORDER BY ps.position LIMIT 1`,
      [projectId, role.id],
    );
    entryStageKey = es.rows[0]?.stage_key ?? null;
  }
  return { role, entryStageKey, status: 'BACKLOG' };
}

// Роль входа задачи в конвейер: Приёмщик задач (TASK_INTAKE_OFFICER), иначе первая
// роль единой схемы, иначе ARCHITECT. Scanner создаёт задачу под этой ролью.
async function entryRole(c) {
  const intake = await c.query(`SELECT id FROM roles WHERE code = 'TASK_INTAKE_OFFICER'`);
  if (intake.rowCount) return { id: intake.rows[0].id, code: 'TASK_INTAKE_OFFICER' };
  const first = await c.query(
    `SELECT r.id, r.code FROM global_stages gs
       JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
       JOIN roles r ON r.id = gsr.role_id
      WHERE gs.enabled = true ORDER BY gs.position, gsr.position LIMIT 1`,
  );
  if (first.rowCount) return { id: first.rows[0].id, code: first.rows[0].code };
  const arch = await c.query(`SELECT id FROM roles WHERE code = 'ARCHITECT'`);
  return { id: arch.rows[0]?.id ?? null, code: 'ARCHITECT' };
}

/**
 * TASK-DUPLICATE-CLOSE-001 — поиск живого «оригинала» по отпечатку текста
 * (messageFingerprint в data_card). Ловит повторную подачу одной и той же задачи
 * с РАЗНЫМИ external_id (пользователь дважды отправил репорт из виджета,
 * постановщик повторно завёл ту же задачу) — идемпотентность по external_id такое
 * не видит. Скоуп: канал интеграции (intakeIntegrationId) ЛИБО проект (projectId,
 * включая NULL-пул неразобранных). Дублем считаем только НЕтерминальную задачу
 * (DONE/CANCELLED/FAILED не в счёт: повторное обращение после закрытия может быть
 * регрессом, а не дублем) не старше 30 дней.
 */
export async function findDuplicateTaskTx(c, { intakeIntegrationId = null, projectId, serviceId = undefined, fingerprint }) {
  const fp = String(fingerprint ?? '');
  if (!fp) return null;
  let r;
  if (intakeIntegrationId) {
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE intake_integration_id = $1 AND data_card->>'messageFingerprint' = $2
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      [intakeIntegrationId, fp],
    );
  } else if (projectId) {
    const serviceFilter = serviceId !== undefined ? 'AND service_id IS NOT DISTINCT FROM $3' : '';
    const params = serviceId !== undefined ? [projectId, fp, serviceId] : [projectId, fp];
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE project_id = $1 AND data_card->>'messageFingerprint' = $2
          ${serviceFilter}
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      params,
    );
  } else {
    r = await c.query(
      `SELECT id, title FROM tasks
        WHERE project_id IS NULL AND data_card->>'messageFingerprint' = $1
          AND status NOT IN ('DONE','CANCELLED','FAILED')
          AND created_at > now() - interval '30 days'
        ORDER BY created_at LIMIT 1`,
      [fp],
    );
  }
  return r.rowCount ? r.rows[0] : null;
}

// TASK-DUPLICATE-CLOSE-001 — создать задачу-дубль СРАЗУ закрытой (CANCELLED) со
// ссылкой на оригинал: след подачи сохраняется в журнале (карточка + события
// TASK_CREATED/TASK_CANCELLED), но конвейер повторную работу не запускает.
async function insertDuplicateClosedTaskTx(c, {
  projectId = null, serviceId = null, externalId = null, intakeIntegrationId = null,
  title, description, roleId = null, dataCard, duplicateOf, source,
}) {
  const card = {
    ...asObject(dataCard),
    duplicateOf,
    duplicateNote: `Дубль живой задачи ${duplicateOf} (совпал отпечаток текста): закрыт автоматически`,
  };
  const ins = await c.query(
    `INSERT INTO tasks
       (project_id, service_id, external_id, intake_integration_id, title, description,
        status, current_role_id, current_stage_key, created_by, data_card)
     VALUES ($1, $2, $3, $4, $5, $6, 'CANCELLED'::task_status, NULL, NULL, $7, $8::jsonb)
     RETURNING id`,
    [projectId, serviceId, externalId, intakeIntegrationId, title, description, source, JSON.stringify(card)],
  );
  const taskId = ins.rows[0].id;
  await c.query(
    `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
     VALUES ($1, 'TASK_CREATED', 'CANCELLED'::task_status, $2, $3::jsonb)`,
    [taskId, roleId, JSON.stringify({ source, externalId, duplicate: true, duplicateOf })],
  );
  await c.query(
    `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
     VALUES ($1, 'TASK_CANCELLED', 'CANCELLED'::task_status, 'CANCELLED'::task_status, $2, $3::jsonb)`,
    [taskId, roleId, JSON.stringify({ source, reason: 'duplicate_closed', duplicateOf })],
  );
  return taskId;
}

/**
 * SCANNER-INTAKE-001 (TASK-INTAKE-OFFICER-001). Приём сырой задачи: Scanner
 * забирает запрос из папки (или задача приходит из модального окна) и создаёт её
 * в БД под ПЕРВОЙ ролью движения — Приёмщиком задач (TASK_INTAKE_OFFICER) в статусе
 * BACKLOG, после чего runner ведёт её по цепочке (BACKLOG → ARCHITECTURE → …). Сервис
 * при импорте АВТО-регистрируется. Идемпотентность — по UNIQUE (project_id,
 * external_id): повторный приём того же файла возвращает duplicate, не создавая дубль.
 * TASK-DUPLICATE-CLOSE-001: повторная подача того же ТЕКСТА с другим external_id
 * создаёт задачу сразу закрытой (CANCELLED, duplicateOf в карточке).
 */
export async function acceptScannerIntake(s, input) {
  const payload = normalizeScannerIntake(input);
  return withClient(clientConfig(s), async (c) => {
    // Постановщик явно указывает папку проекта (projectPath) или иной идентификатор.
    // Сопоставляем детерминированно. Не нашли → проект НЕ задан, задача станет
    // неразобранной (project_id IS NULL) и попадёт в корзину Приёмщика.
    const project = await findProject(c, payload.project);
    // SERVICE-REPO-PATH-001: каталог сервиса выводим из общего префикса путей
    // сдачи — при авторегистрации сразу заполняем services.repository_path.
    const servicePath = deriveServicePathFromFiles(payload.changedFiles);
    const serviceId = project
      ? await getOrCreateService(c, project.id, payload.service, null, servicePath)
      : null;
    // Идемпотентный поиск дубля: для назначенной — в рамках проекта, для
    // неразобранной — среди задач без проекта (частичный uniq-индекс).
    const findDup = () => (project
      ? c.query('SELECT id FROM tasks WHERE project_id = $1 AND external_id = $2', [project.id, payload.externalId])
      : c.query('SELECT id FROM tasks WHERE project_id IS NULL AND external_id = $1', [payload.externalId]));

    // TASK-DUPLICATE-CLOSE-001: отпечаток содержимого задачи — по заголовку и
    // описанию (external_id у повторной подачи другой, его uniq-проверка не ловит).
    const fingerprint = messageFingerprint(`${payload.title}\n${payload.description}`);

    await c.query('BEGIN');
    try {
      const existing = await findDup();
      if (existing.rowCount) {
        await c.query('COMMIT');
        return {
          accepted: true, imported: false, duplicate: true,
          taskId: existing.rows[0].id, externalId: payload.externalId,
        };
      }

      // Повторная подача того же текста (другой external_id) → задача-дубль
      // создаётся сразу закрытой, конвейер не запускается.
      const original = await findDuplicateTaskTx(c, { projectId: project?.id ?? null, fingerprint });
      if (original) {
        const dupCard = project
          ? { project: project.code, projectPath: project.root_path, messageFingerprint: fingerprint }
          : { requestedProject: payload.project || null, messageFingerprint: fingerprint };
        const taskId = await insertDuplicateClosedTaskTx(c, {
          projectId: project?.id ?? null, serviceId, externalId: payload.externalId,
          title: payload.title, description: payload.description,
          dataCard: dupCard, duplicateOf: original.id, source: 'scanner-intake',
        });
        await c.query('COMMIT');
        return {
          accepted: true, imported: false, duplicate: true, duplicateClosed: true,
          taskId, duplicateOf: original.id, externalId: payload.externalId,
        };
      }

      const entry = await computeEntry(c, project?.id ?? null, payload.entryRole);
      const { role, entryStageKey } = entry;
      // Назначенная задача стартует в статусе роли входа: BACKLOG у Приёмщика, либо
      // ARCHITECTURE, когда постановщик через MCP сдал готовый интейк сразу в Architect
      // (entryRole=ARCHITECT). Неразобранная паркуется в BLOCKED и ждёт назначения проекта.
      const status = project ? entry.status : 'BLOCKED';
      // Проект кладём в карточку сразу (детерминированно по папке). Карточку интейка
      // (card) от постановщика через MCP сливаем в data_card — Architect получит уже
      // подготовленные поля (short_title, structured_description, task_type, …).
      const dataCard = project
        ? {
            project: project.code,
            projectPath: project.root_path,
            ...asObject(payload.card),
          }
        : { requestedProject: payload.project || null };
      // TASK-DUPLICATE-CLOSE-001: отпечаток текста — по нему ловится повторная
      // подача той же задачи с другим external_id (см. findDuplicateTaskTx).
      if (fingerprint) dataCard.messageFingerprint = fingerprint;

      // TASK-PRIORITY-SCALE-001: приоритет форсим/нормализуем СЕРВЕРОМ по проекту.
      // Проект оркестратора → 0 (клиент не влияет); иначе clamp(1..3) с нормализацией
      // 0→1 и дефолтом 2. Неразобранная (project=null) → не оркестратор → обычный.
      const priority = computeTaskPriority(project, payload.priority ?? payload.card?.priority);
      const ins = await c.query(
        `INSERT INTO tasks
           (project_id, service_id, external_id, title, description, priority, status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, $4, $5, $6::smallint, $7::task_status, $8, $9::uuid, 'scanner-intake', $10::jsonb)
         RETURNING id`,
        [project?.id ?? null, serviceId, payload.externalId, payload.title, payload.description,
         priority, status, role.id, entryStageKey, JSON.stringify(dataCard)],
      );
      const taskId = ins.rows[0].id;

      // Исходный запрос в событии — Приёмщик увидит его через buildRoleContext.
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', $2::task_status, $3, $4::jsonb)`,
        [taskId, status, role.id, JSON.stringify({
          source: 'scanner-intake',
          externalId: payload.externalId,
          service: payload.service,
          result: payload.result,
          changedFiles: payload.changedFiles,
          requestedProject: payload.project || null,
          unassigned: !project,
          // TASK-INTAKE-OFFICER-MCP-001: фиксируем прямой вход постановщика в Architect.
          ...(payload.entryRole ? { entryRole: payload.entryRole } : {}),
          ...(project ? {} : { reason: 'project_unresolved' }),
        })],
      );
      await c.query('COMMIT');
      return {
        accepted: true, imported: true, duplicate: false, unassigned: !project,
        taskId, externalId: payload.externalId, project: project?.code ?? null,
        service: payload.service, nextRole: role.code, toStatus: status,
      };
    } catch (error) {
      await c.query('ROLLBACK');
      // Гонка: тот же external_id импортирован параллельно — это не ошибка.
      if (error.code === '23505') {
        const again = await findDup();
        if (again.rowCount) {
          return {
            accepted: true, imported: false, duplicate: true,
            taskId: again.rows[0].id, externalId: payload.externalId,
          };
        }
      }
      throw error;
    }
  });
}

// INTAKE-INTEGRATIONS-001 — короткий заголовок обращения из первой строки текста
// (Приёмщик позже заменит его на short_title). Ограничиваем длину для карточки.
function intakeReportTitle(message) {
  const firstLine = String(message ?? '').split(/\r?\n/)[0].trim();
  const base = firstLine || 'Обращение пользователя';
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

// INTAKE-CATEGORY-VALIDATION-001 — допустимые категории обращения из виджета.
// Категория пользователя — лишь ПОДСКАЗКА (не истина): Приёмщик перепроверяет её
// по тексту сообщения. Невалидное/пустое значение приём не роняет (→ null).
const INTAKE_CATEGORY_VALUES = new Set(['bug', 'idea', 'feature', 'question']);
function normalizeIntakeCategory(v) {
  const c = String(v ?? '').trim().toLowerCase();
  return INTAKE_CATEGORY_VALUES.has(c) ? c : null;
}

// INTAKE-WORKER-FORMAT-001 — совместимость с воркерами доставки подсистем ПС
// (Go internal/problemreports|problemdelivery): они шлют snake_case-поля
// (id/message_text/reporter_login/screen/context{build_version,...}), а канонический
// контракт — externalId/message/user/form/autocontext. Признак формата воркера —
// message_text без message; такой вход переводим в канонический ДО валидации.
// reporter_login может быть пуст (анонимная сессия) — доставку не роняем ('unknown').
function adaptWorkerIntakeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const str = (v) => String(v ?? '').trim();
  if (str(input.message) || !str(input.message_text)) return input;
  const ctx = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
    ? input.context : {};
  return {
    token: input.token,
    externalId: input.id,
    message: input.message_text,
    user: str(input.reporter_login) || str(input.reporter_user_id) || 'unknown',
    service: str(input.service_code) || str(input.service),
    form: input.screen,
    category: input.category,
    sourceTicketNo: input.ticket_no,
    autocontext: {
      url: ctx.url,
      buildVersion: ctx.build_version,
      userAgent: ctx.user_agent,
      timestamp: str(ctx.client_timestamp) || str(input.created_at),
      jsErrors: ctx.recent_errors,
      lastFailedApiRequestId: ctx.last_failed_request_id,
    },
  };
}

/**
 * INTAKE-INTEGRATIONS-001 — нормализация обращения из канала «интеграции в
 * приложения» (POST /api/intake/report). Чистая функция (без БД): проверяет
 * обязательные поля и собирает автоконтекст. token приходит из заголовка запроса
 * (Authorization: Bearer / X-Intake-Token) — сервер кладёт его в input.token.
 * Формат Go-воркеров подсистем принимается через adaptWorkerIntakeReport.
 */
export function normalizeIntakeReport(rawInput) {
  const input = adaptWorkerIntakeReport(rawInput);
  const str = (v) => String(v ?? '').trim();
  const token = str(input?.token);
  if (!token) throw scannerError(401, 'token_required');
  const externalId = str(input?.externalId);
  if (!externalId) throw scannerError(422, 'external_id_required');
  const message = str(input?.message);
  if (!message) throw scannerError(422, 'message_required');
  const user = str(input?.user);
  if (!user) throw scannerError(422, 'user_required');
  // Битую кодировку отклоняем на входе (как в scanner-интейке): по такому тексту
  // обращение не восстановить.
  if (looksCorruptedText(message)) throw scannerError(422, 'corrupted_encoding');

  const ac = input?.autocontext && typeof input.autocontext === 'object' && !Array.isArray(input.autocontext)
    ? input.autocontext : {};
  const autocontext = {
    url: str(ac.url) || null,
    buildVersion: str(ac.buildVersion) || null,
    userAgent: str(ac.userAgent) || null,
    timestamp: str(ac.timestamp) || null,
    jsErrors: Array.isArray(ac.jsErrors) ? ac.jsErrors.map((e) => str(e)).filter(Boolean).slice(0, 50) : [],
    lastFailedApiRequestId: str(ac.lastFailedApiRequestId) || null,
  };
  return {
    token,
    externalId,
    message,
    user,
    service: str(input?.service),      // микросервис-источник
    form: str(input?.form),            // форма/экран, с которого написано сообщение
    // INTAKE-CATEGORY-VALIDATION-001 — категория из виджета (подсказка пользователя,
    // не истина). Невалидное/пустое значение → null, приём не роняем.
    category: normalizeIntakeCategory(input?.category),
    autocontext,
    // Ссылка на объект-скриншот в MinIO (грузит бэкенд приложения-источника).
    screenshotUrl: str(input?.screenshotUrl) || null,
    // Номер тикета в подсистеме-источнике (его видел пользователь в виджете).
    sourceTicketNo: Number.isFinite(Number(input?.sourceTicketNo)) && Number(input?.sourceTicketNo) > 0
      ? Number(input.sourceTicketNo) : null,
  };
}

/**
 * INTAKE-INTEGRATIONS-001 — приём обращения о проблеме от зарегистрированного
 * приложения-источника (третий канал приёма Task Intake Officer). Авторизация по
 * токену интеграции; анти-спам (rate-limit по интеграции и по пользователю +
 * минимальная длина сообщения); идемпотентность по (intake_integration_id,
 * external_id). Обращение создаётся БЕЗ проекта, но СРАЗУ в статусе BACKLOG под
 * Приёмщиком (не BLOCKED) — чтобы не зависать в «Неразобранных»; проект определит
 * сам Приёмщик по каталогу проектов. Ответ содержит человекочитаемый номер
 * обращения (reportNumber) — приложение показывает его пользователю.
 */
export async function acceptIntakeReport(s, input) {
  const payload = normalizeIntakeReport(input);
  const tokenHash = hashToken(payload.token);
  return withClient(clientConfig(s), async (c) => {
    // 1. Авторизация по токену интеграции.
    const integ = await c.query(
      `SELECT id, name, enabled, rate_limit_per_min, user_rate_limit_per_min, min_message_length
         FROM intake_integrations WHERE token_hash = $1 AND token_hash <> ''`,
      [tokenHash],
    );
    if (!integ.rowCount) throw scannerError(401, 'invalid_intake_token');
    const integration = integ.rows[0];
    if (!integration.enabled) throw scannerError(403, 'integration_disabled');

    // 2. Анти-спам: слишком короткое сообщение отклоняем.
    if (payload.message.length < integration.min_message_length) {
      throw scannerError(422, 'message_too_short');
    }

    // Идемпотентность: обращение с тем же external_id уже принято → тот же номер.
    const findDup = () => c.query(
      'SELECT id, data_card FROM tasks WHERE intake_integration_id = $1 AND external_id = $2',
      [integration.id, payload.externalId],
    );
    const dupResult = (row) => ({
      accepted: true, duplicate: true, imported: false,
      taskId: row.id, reportNumber: row.data_card?.reportNumber ?? null,
      externalId: payload.externalId,
    });
    const dup0 = await findDup();
    if (dup0.rowCount) return dupResult(dup0.rows[0]);

    // 3. Анти-спам: rate-limit по интеграции и по пользователю. Окно — 1 минута по
    // created_at (устойчиво к рестарту одного инстанса; горизонтального
    // масштабирования оркестратора нет — счётчик держим в БД, не в памяти).
    const perInt = await c.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE intake_integration_id = $1 AND created_at > now() - interval '1 minute'`,
      [integration.id],
    );
    if (perInt.rows[0].n >= integration.rate_limit_per_min) throw scannerError(429, 'rate_limited');
    const perUser = await c.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE intake_integration_id = $1 AND created_at > now() - interval '1 minute'
          AND data_card->>'reporterUser' = $2`,
      [integration.id, payload.user],
    );
    if (perUser.rows[0].n >= integration.user_rate_limit_per_min) throw scannerError(429, 'user_rate_limited');

    // 4. Создание обращения: беспроектная задача СРАЗУ в BACKLOG под Приёмщиком.
    const role = await entryRole(c);
    // TASK-DUPLICATE-CLOSE-001: отпечаток текста обращения — повторная отправка
    // того же сообщения приходит с НОВЫМ external_id, uniq-проверка её не ловит
    // (инцидент 08.07: один и тот же репорт об ошибке каталога прислан дважды →
    // два параллельных конвейера сделали одну работу).
    const fingerprint = messageFingerprint(payload.message);
    await c.query('BEGIN');
    try {
      // Повторная проверка дубля под транзакцией (гонка параллельной доставки).
      const dup = await findDup();
      if (dup.rowCount) {
        await c.query('COMMIT');
        return dupResult(dup.rows[0]);
      }
      const seq = await c.query("SELECT nextval('intake_report_seq')::bigint AS n");
      const reportNumber = Number(seq.rows[0].n);
      const dataCard = {
        source: 'intake-integration',
        integration: integration.name,
        reportNumber,
        externalId: payload.externalId,
        // Номер тикета в подсистеме-источнике (виджет показал его пользователю).
        sourceTicketNo: payload.sourceTicketNo,
        reporterUser: payload.user,
        reporterService: payload.service || null,
        reporterForm: payload.form || null,
        // INTAKE-CATEGORY-VALIDATION-001 — категория, выбранная пользователем в
        // виджете (подсказка). Приёмщик перепроверит её и зафиксирует user_category
        // + resolved_category в карточке.
        category: payload.category,
        autocontext: payload.autocontext,
        // Ссылка на скриншот в MinIO — сохраняется в карточке и доступна ролям.
        screenshotUrl: payload.screenshotUrl,
        // TASK-DUPLICATE-CLOSE-001: отпечаток текста для ловли повторной подачи.
        ...(fingerprint ? { messageFingerprint: fingerprint } : {}),
      };
      // Повторная подача того же текста в тот же канал при живом оригинале →
      // обращение фиксируем (пользователь получает номер), но задачу создаём сразу
      // закрытой (CANCELLED, duplicateOf) — конвейер повторную работу не запускает.
      const original = await findDuplicateTaskTx(c, { intakeIntegrationId: integration.id, fingerprint });
      if (original) {
        const taskId = await insertDuplicateClosedTaskTx(c, {
          externalId: payload.externalId, intakeIntegrationId: integration.id,
          title: intakeReportTitle(payload.message), description: payload.message,
          roleId: role.id, dataCard, duplicateOf: original.id, source: 'intake-integration',
        });
        await c.query('COMMIT');
        return {
          accepted: true, duplicate: true, duplicateClosed: true, imported: false,
          taskId, duplicateOf: original.id, reportNumber, externalId: payload.externalId,
        };
      }
      const ins = await c.query(
        `INSERT INTO tasks
           (project_id, service_id, external_id, intake_integration_id, title, description,
            status, current_role_id, current_stage_key, created_by, data_card)
         VALUES (NULL, NULL, $1, $2, $3, $4, 'BACKLOG'::task_status, $5, NULL, 'intake-integration', $6::jsonb)
         RETURNING id`,
        [payload.externalId, integration.id, intakeReportTitle(payload.message), payload.message,
         role.id, JSON.stringify(dataCard)],
      );
      const taskId = ins.rows[0].id;
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', 'BACKLOG'::task_status, $2, $3::jsonb)`,
        [taskId, role.id, JSON.stringify({
          source: 'intake-integration', integration: integration.name, integrationId: integration.id,
          reportNumber, externalId: payload.externalId, reporterUser: payload.user,
          reporterService: payload.service || null, reporterForm: payload.form || null,
          category: payload.category,
          hasScreenshot: Boolean(payload.screenshotUrl),
        })],
      );
      await c.query('COMMIT');
      return {
        accepted: true, duplicate: false, imported: true,
        taskId, reportNumber, externalId: payload.externalId,
        nextRole: role.code, toStatus: 'BACKLOG',
      };
    } catch (error) {
      await c.query('ROLLBACK');
      // Гонка: тот же external_id принят параллельно — это не ошибка.
      if (error.code === '23505') {
        const again = await findDup();
        if (again.rowCount) return dupResult(again.rows[0]);
      }
      throw error;
    }
  });
}

/**
 * Список неразобранных задач (project_id IS NULL) — корзина роли Task Intake
 * Officer. Это задачи, для которых постановщик не указал/не сопоставился проект.
 */
export async function listUnassignedTasks(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT t.id, t.external_id, t.title, t.description, t.status::text AS status,
              t.priority, t.created_at, t.data_card
         FROM tasks t
        WHERE t.project_id IS NULL
          AND t.status NOT IN ('DONE', 'CANCELLED')
        ORDER BY t.priority ASC, t.created_at ASC`,
    );
    return {
      tasks: r.rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        requestedProject: row.data_card?.requestedProject ?? null,
      })),
    };
  });
}

/**
 * Назначить неразобранной задаче проект и пустить её по конвейеру. Только задача
 * без проекта (project_id IS NULL) может быть назначена. После назначения задача
 * получает project_id, роль входа (Приёмщик), статус BACKLOG — runner ведёт её
 * дальше по цепочке. Возвращает { assigned, taskId, project, nextRole }.
 */
export async function assignTaskProject(s, taskId, projectRef) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'task_required');
  return withClient(clientConfig(s), async (c) => {
    const project = await findProject(c, projectRef);
    if (!project) throw scannerError(404, 'project_not_registered');
    return withTransaction(c, async () => {
      const cur = await c.query(
        'SELECT id, external_id, project_id, priority FROM tasks WHERE id = $1 FOR UPDATE', [id],
      );
      if (!cur.rowCount) throw scannerError(404, 'task_not_found');
      if (cur.rows[0].project_id) throw scannerError(409, 'task_already_assigned');

      // В целевом проекте уже может быть задача с таким external_id — назначение
      // нарушило бы UNIQUE (project_id, external_id). Явно сообщаем о конфликте.
      const externalId = cur.rows[0].external_id;
      if (externalId) {
        const dup = await c.query(
          'SELECT id FROM tasks WHERE project_id = $1 AND external_id = $2', [project.id, externalId],
        );
        if (dup.rowCount) throw scannerError(409, 'external_id_conflict');
      }

      const { role, entryStageKey } = await computeEntry(c, project.id);
      // TASK-PRIORITY-SCALE-001: при назначении проекта форсим/пересчитываем приоритет.
      // Оркестратор → 0; уход из оркестратора при 0 → 2; иначе сохраняем текущий.
      const curPriority = cur.rows[0].priority;
      const newPriority = isOrchestratorProject(project)
        ? 0
        : (curPriority === 0 ? 2 : curPriority);
      const upd = await c.query(
        `UPDATE tasks
            SET project_id = $2, status = 'BACKLOG', current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL,
                priority = $7::smallint,
                data_card = COALESCE(data_card, '{}'::jsonb)
                            || jsonb_build_object('project', $5::text, 'projectPath', $6::text),
                updated_at = now()
          WHERE id = $1 AND project_id IS NULL
          RETURNING id`,
        [id, project.id, role.id, entryStageKey, project.code, project.root_path, newPriority],
      );
      if (!upd.rowCount) throw scannerError(409, 'task_already_assigned');

      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_UPDATED', 'BACKLOG', $2, $3::jsonb)`,
        [id, role.id, JSON.stringify({ source: 'intake-assign', project: project.code, nextRole: role.code })],
      );
      return { assigned: true, taskId: id, project: project.code, nextRole: role.code };
    });
  });
}


// Найти сервис по (project, code) или СОЗДАТЬ его (авто-регистрация при импорте).
// Пустой код → null (задача без сервиса). service_name = code, если имени нет.
export async function getOrCreateService(c, projectId, serviceCode, serviceName, repositoryPath) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const found = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (found.rowCount) return found.rows[0].id;
  // SERVICE-REPO-PATH-001: при авторегистрации сразу пишем каталог сервиса
  // (выведенный из путей work_item/сдачи), чтобы PIPELINE_SERVICE не собирал от
  // корня репозитория. Пустой путь → NULL (бэкфилл по коду произойдёт на claim).
  let repoPath = String(repositoryPath ?? '').trim() || null;
  if (!repoPath) {
    // SERVICE-REPO-PATH-INHERIT-001: новый ВАРИАНТ ИМЕНИ того же сервиса
    // (PS-Torg-frontend vs PSTORG_FRONTEND vs front_salesflow/front-salesflow) иначе
    // авто-создаётся с repository_path=NULL и гарантированно блокирует Архитектора —
    // preflightServiceRepoPath трактует NULL-путь как missing_repository_path (бэкфилл
    // по коду каталога он намеренно отвергает). Каждый источник (scanner-intake, виджет,
    // постановщик) шлёт своё написание кода → плодятся пустые дубли и блоки. Наследуем
    // путь от существующего сервиса-СИБЛИНГА того же проекта с совпадающим
    // НОРМАЛИЗОВАННЫМ кодом (lower, без разделителей -, _ и /: чтобы
    // Pricing_AI_pricing_engine наследовал путь от Pricing/AI_pricing_engine) и
    // валидным путём. Порог
    // неоднозначности: если под одним норм-кодом у сиблингов РАЗНЫЕ пути — не угадываем,
    // оставляем NULL (штатный блок, регистр правит человек). Логические не-код «сервисы»
    // (ARCHITECTURE/INTEGRATION/…) сиблинга с путём не имеют → остаются NULL, как и было.
    const sib = await c.query(
      `SELECT DISTINCT repository_path FROM services
        WHERE project_id = $1
          AND repository_path IS NOT NULL AND btrim(repository_path) <> ''
          AND regexp_replace(lower(service_code), '[-_/]', '', 'g')
            = regexp_replace(lower($2), '[-_/]', '', 'g')`,
      [projectId, code],
    );
    if (sib.rowCount === 1) repoPath = String(sib.rows[0].repository_path).trim();
  }
  const ins = await c.query(
    `INSERT INTO services (project_id, service_code, service_name, repository_path)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, service_code) DO UPDATE SET service_code = EXCLUDED.service_code
     RETURNING id`,
    [projectId, code, String(serviceName ?? '').trim() || code, repoPath],
  );
  return ins.rows[0].id;
}

/**
 * Эвристика «битой кодировки» (mojibake). Текст приходит уже повреждённым с
 * клиента (напр. codex на Windows-консоли схлопывает кириллицу в «?»; разрыв
 * UTF-8 на границе чанков даёт символ-замену U+FFFD «�»). Такой текст бесполезен:
 * исходную задачу по нему не восстановить. Чтобы мусор не оседал в БД отдельной
 * BLOCKED-задачей, отклоняем его прямо на приёмке. Возвращает true, если текст
 * выглядит повреждённым:
 *  - содержит U+FFFD (символ-замену), либо
 *  - содержит подряд 3+ знака «?» (схлопнутое слово кириллицы), либо
 *  - доля «?» среди непробельных символов ≥ 25% (рассыпанные «?»).
 * Одиночные/двойные «?» (риторический вопрос) НЕ считаются порчей.
 */
export function normalizeScannerIntake(input) {
  const required = (key) => {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw scannerError(422, `${key}_required`);
    return value;
  };
  // Идентификатор проекта: приоритет у явной папки (projectPath), затем project.
  // НЕ обязателен — нераспознанный/пустой проект делает задачу неразобранной.
  const project = String(input?.projectPath ?? input?.project ?? '').trim();
  const title = required('title');
  const description = String(input?.description ?? '').trim() || null;
  // Битую кодировку отклоняем на входе: задачу по такому тексту не восстановить,
  // а клиенту нужно переприслать запрос в корректной UTF-8 (а не плодить мусор).
  if (looksCorruptedText(title) || looksCorruptedText(description)) {
    throw scannerError(422, 'corrupted_encoding');
  }
  return {
    externalId: required('externalId'),
    project,
    title,
    service: String(input?.service ?? '').trim(),
    description,
    result: String(input?.result ?? ''),
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map(String) : [],
    // TASK-INTAKE-OFFICER-MCP-001: роль входа (например ARCHITECT) — постановщик через
    // MCP сдаёт готовый интейк сразу в Architect, минуя пайплайновый Приёмщик/BACKLOG.
    entryRole: String(input?.entryRole ?? '').trim().toUpperCase() || null,
    // TASK-PRIORITY-SCALE-001: пользовательский приоритет (1..3) из тела или карточки.
    // Сырое значение — нормализацию/форс делает acceptScannerIntake по проекту.
    priority: input?.priority
      ?? (input?.card && typeof input.card === 'object' && !Array.isArray(input.card)
        ? input.card.priority : undefined)
      ?? null,
    // Карточка интейка (поля контракта Приёмщика) → сливается в data_card для Architect.
    card: input?.card && typeof input.card === 'object' && !Array.isArray(input.card)
      ? input.card : null,
  };
}

// SELECT задачи в форме, нужной диспетчеру Scanner (FOR UPDATE — блокируем строку).
const SCANNER_TASK_SELECT = `SELECT t.id, t.status::text AS status, p.id AS project_id,
        p.code AS project_code, s.service_code, rr.id AS reviewer_role_id,
        t.current_role_id, t.current_stage_key, cr.code AS current_role_code,
        t.task_kind, t.parent_task_id, t.data_card
   FROM tasks t
   JOIN projects p ON p.id = t.project_id
   LEFT JOIN services s ON s.id = t.service_id
   LEFT JOIN roles cr ON cr.id = t.current_role_id
   JOIN roles rr ON rr.code = 'TASK_REVIEWER'
  WHERE t.id = $1
  FOR UPDATE OF t`;

/**
 * Найти задачу по id или создать её из completion, если в БД её ещё нет.
 *
 * ВАЖНО: проекты и сервисы заводятся ТОЛЬКО вручную (через UI/API). Сканер их
 * больше НЕ создаёт: если проект/сервис из completion не зарегистрирован —
 * задача отклоняется (project_not_registered / service_not_registered). Раньше
 * по полям project/service из документа плодились «левые» проекты и сервисы
 * (напр. PS + Chat_Service/IAM_Service/…), не привязанные к папке проекта.
 *
 * Сама задача по-прежнему создаётся из completion (в статусе CODING под ролью
 * PROGRAMMER, с событием TASK_CREATED) — но только внутри уже существующих
 * проекта и сервиса. Идемпотентно: ON CONFLICT + повторный SELECT под блокировкой.
 * Возвращает { task, created } (created — была ли задача создана сейчас).
 */
export async function findOrCreateScannerTask(c, payload) {
  // Проект обязан существовать (создаётся только вручную). Резолвим гибко:
  // по code | name | root_path — чтобы поле project из документа совпало с
  // зарегистрированным проектом независимо от способа записи.
  const project = await requireProject(c, payload.project);

  const existing = await c.query(SCANNER_TASK_SELECT, [payload.taskId]);
  if (existing.rowCount) {
    const task = existing.rows[0];
    // Существующая задача должна принадлежать тому же проекту/сервису, что и completion.
    if (task.project_code !== project.code) throw scannerError(409, 'project_mismatch');
    if ((task.service_code ?? '') !== String(payload.service ?? '').trim()) {
      throw scannerError(409, 'service_mismatch');
    }
    return { task, created: false };
  }

  // Сервис тоже только ручной: пустой код → задача без сервиса; непустой неизвестный → ошибка.
  const serviceId = await requireService(c, project.id, payload.service);
  const role = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
  const programmerRoleId = role.rows[0]?.id ?? null;

  const ins = await c.query(
    `INSERT INTO tasks (id, project_id, service_id, title, status, current_role_id, created_by)
     VALUES ($1, $2, $3, $4, 'CODING', $5, 'scanner')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [payload.taskId, project.id, serviceId, payload.title, programmerRoleId],
  );
  if (ins.rowCount) {
    await c.query(
      `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_CREATED', 'CODING', $2, $3::jsonb)`,
      [payload.taskId, programmerRoleId, JSON.stringify({
        source: 'scanner', autoCreated: true, project: payload.project, service: payload.service, title: payload.title,
      })],
    );
  }

  const created = await c.query(SCANNER_TASK_SELECT, [payload.taskId]);
  if (!created.rowCount) throw scannerError(500, 'task_autocreate_failed');
  return { task: created.rows[0], created: ins.rowCount > 0 };
}

// Найти проект по code | name | root_path. Проекты создаются ТОЛЬКО вручную,
// поэтому при отсутствии — ошибка (а не авто-создание). Возвращает { id, code }.
async function requireProject(c, ref) {
  const v = String(ref ?? '').trim();
  if (!v) throw scannerError(422, 'project_required');
  const r = await c.query(
    `SELECT id, code FROM projects
      WHERE code = $1 OR name = $1 OR root_path = $1
      ORDER BY created_at LIMIT 1`,
    [v],
  );
  if (!r.rowCount) throw scannerError(404, 'project_not_registered');
  return r.rows[0];
}

// Найти сервис по (project, service_code). Сервисы тоже только ручные: пустой код
// → null (задача без сервиса); непустой неизвестный код → ошибка (не авто-создание).
async function requireService(c, projectId, serviceCode) {
  const code = String(serviceCode ?? '').trim();
  if (!code) return null;
  const r = await c.query(
    'SELECT id FROM services WHERE project_id = $1 AND service_code = $2', [projectId, code],
  );
  if (!r.rowCount) throw scannerError(404, 'service_not_registered');
  return r.rows[0].id;
}
