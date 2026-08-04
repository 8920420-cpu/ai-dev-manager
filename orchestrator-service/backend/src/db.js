// Работа с PostgreSQL: проверка подключения, автосоздание БД, миграции, seed.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW, fastForwardHiddenRoles, normalizeTaskRoute } from './rolePipeline.js';
import { runReasoningRole, decideOutcome, summarizePriorRuns, LLM_ROLE_CODES, MAX_REWORK, buildUserPayload, buildVerdictJsonSchema, normalizeVerdict, parseVerdict, renderProjectMaps, isMissingArtifactComplaint, REVIEW_DELTA_ROLES, DOC_BRANCH_ROLE_CODES } from './roleEngine.js';
import { buildRoute, resolveTransition, forwardFrom, routeIsUsable, TERMINAL_STATUSES } from './projectRoute.js';
import { buildGraph, nextNodeKey, forkBranchKeys, nodeByKey, reworkNodeKey } from './graphRoute.js';
import { extractOutputs, missingRequiredInputs } from './fieldsContract.js';
import { buildPipelineClaimContract } from './pipelineDispatch.js';
import { deriveServicePathFromFiles, resolveServiceRepoPath } from './serviceRepoPath.js';
import { reconcileClockSkew } from './clockGuard.js';
import { isDbConnectionError, noteDbConnectionFailure, claimGraceActive } from './bootClaimGuard.js';
import { resolveDuration, resolveInt, logEffectiveConfig, parseDurationMs } from './envConfig.js';
import { asObject, parseDataCard } from './dataCard.js';
import { isDriverProvider } from './connectors.js';
import { hashToken, messageFingerprint } from './intakeIntegrations.js';
import { exportLatestAgentRunObservation } from './clickhouseObservability.js';
import { checkApproach } from './antiRegression.js';
import { withTransaction } from './transaction.js';
import {
  buildProgrammerClaimTask,
  buildProgrammerRunSnapshot,
  programmerModelForKind,
  resolveTaskStack,
} from './programmerClaim.js';
import {
  computeTaskPriority,
  isOrchestratorProject,
  normalizeClientPriority,
  normalizeTaskSize,
  renderWorkArtifactSections,
  shouldSkipReviewerForSmallTask,
  taskRouteFromCard,
  taskSizeFromCard,
  TERMINAL_TASK_STATUSES,
} from './taskPolicy.js';
import {
  looksCorruptedText,
  normalizeScannerCompletion,
  resultSummaryText,
  scannerError,
} from './scannerCompat.js';
import { createLogger } from '../../../shared/logging/index.js';
// dbCore.js — ядро подключения/миграций/seed + общие хелперы. Реэкспортируем,
// чтобы прежние импорты `from './db.js'` продолжали видеть эти имена, и импортируем
// для внутреннего использования оставшимся в db.js кодом.
import { clientConfig, withClient, publicTx, roleIdByCode } from './dbCore.js';

const log = createLogger({ service: 'orchestrator-service' });

const { Client } = pg;

export * from './dbCore.js';
// forkJoin.js — advanceForkNodes + очередь работ (advanceWorkStack) + роллап эпиков
// (advanceDecompositionParents). advanceJoinNodes оставлен в db.js (закреплён
// текстовым тестом docRolesGiSerialize). Реэкспорт сохраняет прежнюю поверхность,
// именованный импорт нужен планировщику advanceAutomatedTasks (вызовы в db.js).
export * from './forkJoin.js';
import { advanceForkNodes, advanceWorkStack, advanceDecompositionParents } from './forkJoin.js';
// routeLoaders.js — загрузка маршрута/графа проекта и контрактов ролей (чистый leaf).
// Реэкспорт сохраняет поверхность, именованный импорт нужен коду db.js (core/claim/janitor).
export * from './routeLoaders.js';
import { loadProjectRoute, loadProjectGraph, resolveGraphTransition, loadRoleContract } from './routeLoaders.js';
// janitor.js — санитары/реконсиляция (реап, эскалации петель, реаттач, GI-ресинк).
// Реэкспорт сохраняет поверхность; именованный импорт нужен планировщику и claim в db.js.
export * from './janitor.js';
import {
  resetStaleClaims, reapOrphanRunningRuns, reattachOrphanStageRoles, reattachBlockedOwnerRoles,
  closeBlockedDuplicateTasks, blockExhaustedFailureAnalysis, escalateProgrammerReleaseLoop,
  escalateArchitectBudgetLoop, escalateRunawayRoleLoops, advanceStuckDocumentationBranches,
  retryGiBlockedForResync,
} from './janitor.js';
// tasksLifecycle.js — UI/эндпоинт-мутации задач и поток needs-input.
// Реэкспорт сохраняет поверхность; autoAcceptDoneTasks зовёт планировщик в db.js.
export * from './tasksLifecycle.js';
import { autoAcceptDoneTasks } from './tasksLifecycle.js';
// intake.js — приём/интейк задач, дедуп, авто-регистрация сервисов и резолверы.
// Реэкспорт сохраняет поверхность; core зовёт findProject/computeEntry/countTaskReviewerReworks.
export * from './intake.js';
import { findProject, computeEntry, countTaskReviewerReworks } from './intake.js';

export {
  REVIEWER_SKIP_MAX_FILES,
  TASK_SIZES,
  computeTaskPriority,
  isOrchestratorProject,
  normalizeClientPriority,
  normalizeTaskSize,
  renderWorkArtifactSections,
  reviewerSkipHasDangerousFile,
  shouldSkipReviewerForSmallTask,
  taskRouteFromCard,
  taskSizeFromCard,
} from './taskPolicy.js';

export {
  looksCorruptedText,
  normalizeScannerCompletion,
} from './scannerCompat.js';

export { programmerModelForKind };


// ROLE-ENGINE-ROUTING-002 — снимок коннектора роли для agent_runs. Источник истины
// «чем исполнялся прогон»: включённый коннектор, назначенный коду роли в карточке
// роли (role_connectors → «Движок»). Возвращает неизменяемый снимок
// { connectorId, provider, model, driverType } на момент захвата задачи; все поля
// null, если роли не назначен включённый коннектор (исторические/локальные прогоны).
// driverType: 'driver' (хостовый движок codex/claude_code) либо 'api' (сетевой AI-API).
async function resolveConnectorSnapshot(c, roleCode) {
  const empty = { connectorId: null, provider: null, model: null, driverType: null };
  const code = String(roleCode ?? '').trim();
  if (!code) return empty;
  const r = await c.query(
    `SELECT cn.id::text AS id, cn.provider, cn.model
       FROM role_connectors rc
       JOIN connectors cn ON cn.id = rc.connector_id
      WHERE rc.role_code = $1 AND cn.is_enabled = true
      ORDER BY cn.priority ASC, cn.updated_at DESC
      LIMIT 1`,
    [code],
  );
  if (!r.rowCount) return empty;
  const row = r.rows[0];
  const provider = row.provider == null ? null : String(row.provider);
  return {
    connectorId: row.id ?? null,
    provider,
    model: row.model ? String(row.model) : null,
    driverType: provider == null ? null : (isDriverProvider(provider) ? 'driver' : 'api'),
  };
}




/**
 * Обратный мост БД → файл: атомарно захватить следующую задачу для Claude.
 * Берём задачу в статусе CODING под ролью PROGRAMMER, ещё не отданную (никому
 * не назначен агент), помечаем её claude_programmer и пишем событие AGENT_ASSIGNED.
 * FOR UPDATE SKIP LOCKED исключает выдачу одной задачи двум фидерам.
 * Возвращает { task: {...} } для записи в claude-tasks.json или { task: null }.
 */
// Ключ транзакционного advisory-lock для claim'а PROGRAMMER. Сериализует заявки
// между параллельными воркерами, чтобы условие «один активный CODING на сервис»
// (NOT EXISTS ниже) проверялось по уже зафиксированным назначениям, а не в гонке
// (иначе N воркеров одновременно проходят проверку и хватают ОДИН сервис).
const CLAUDE_CLAIM_LOCK_KEY = 911_017;

export const claimNextClaudeTask = publicTx(claimNextClaudeTaskTx);

/**
 * Транзакционное ядро claimNextClaudeTask (тестируется с fake-клиентом без живого
 * Postgres — как completeHostTaskTx/acceptScannerCompletionTx). Захват программиста
 * с cooldown-предикатом PROGRAMMER-RELEASE-BACKOFF-001 (см. picked ниже).
 */
export async function claimNextClaudeTaskTx(c) {
  if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
  return withTransaction(c, async () => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [CLAUDE_CLAIM_LOCK_KEY]);
      const picked = await c.query(
        `WITH picked AS (
           SELECT t.id
           FROM tasks t
           JOIN roles r ON r.id = t.current_role_id
           JOIN projects p ON p.id = t.project_id
           WHERE r.code = 'PROGRAMMER'
             AND r.hidden = false
             AND t.status = 'CODING'
             AND t.assigned_agent_id IS NULL
             AND t.service_id IS NOT NULL
             -- DECOMP-CONTRACT-001: программист клеймит ТОЛЬКО подзадачи-на-файл.
             -- Задачи-на-сервис (kind='service') ждут детей в WAITING_FOR_CHILDREN
             -- и не клеймятся; одиночные legacy-задачи остаются kind='service' со
             -- статусом CODING — для них правило не меняется (они клеймятся как
             -- раньше, см. ниже): поэтому фильтруем по «не epic», а не «= subtask».
             AND t.task_kind <> 'epic'
             AND p.status <> 'paused'
             -- PROGRAMMER-WORKTREE-PER-SERVICE: не более одной активной CODING-
             -- задачи на микросервис (один worktree на сервис). Если у сервиса уже
             -- есть назначенная задача — пропускаем его, чтобы воркеры разбирали
             -- РАЗНЫЕ сервисы параллельно, а не толпились на одном (иначе они
             -- сериализуются на сервис-локе runner'а и параллелизм теряется).
             AND NOT EXISTS (
               SELECT 1 FROM tasks t2
                WHERE t2.project_id = t.project_id
                  AND t2.service_id = t.service_id
                  AND t2.status = 'CODING'
                  AND t2.assigned_agent_id IS NOT NULL
             )
             -- PROGRAMMER-RELEASE-BACKOFF-001: cooldown на повторный захват ТОЙ ЖЕ
             -- задачи после подряд идущих неудачных release. Инцидент 03.07.2026:
             -- PRINT-054 крутилась в CODING-петле (агент падал за ~5с →
             -- releaseClaudeTask возвращал захват → задача бралась снова, 1407
             -- прогонов за 2 часа), и, так как у программиста ровно один агент, петля
             -- заблокировала стадию CODING для остальных. N = число неуспешных
             -- PROGRAMMER-прогонов (FAILED/TIMEOUT) ПОСЛЕ последнего SUCCESS этой
             -- задачи; backoff(N) берём из расписания $1 (int[] мс), индекс = LEAST(N,
             -- длина) → потолок на хвосте. Пока now() < last_fail + backoff(N) — задачу
             -- не выдаём (программист свободен разбирать ДРУГИЕ сервисы). Успех
             -- обнуляет N сам: считаем только прогоны после последнего SUCCESS. Один
             -- AND-предикат — приоритет (ORDER BY) и worktree-NOT EXISTS не затронуты.
             AND NOT EXISTS (
               SELECT 1 FROM (
                 SELECT count(*) AS n_fail, max(ar.finished_at) AS last_fail
                   FROM agent_runs ar
                  WHERE ar.task_id = t.id
                    AND ar.role_id = t.current_role_id
                    AND ar.status IN ('FAILED','TIMEOUT')
                    AND ar.finished_at IS NOT NULL
                    -- manual-move сбрасывает и cooldown: оператор перезапустил задачу
                    -- руками — не заставляем её досиживать хвост backoff.
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
               WHERE cd.n_fail > 0
                 AND now() < cd.last_fail
                             + (($1::int[])[LEAST(cd.n_fail::int, array_length($1::int[], 1))])
                               * interval '1 millisecond'
             )
             -- PROGRAMMER-CONTRACT-BARRIER-001: подзадачу-потребителя (task_kind=
             -- 'subtask', путь Декомпозера) не выдаём, пока её зависимость (владелец
             -- общего контракта proto) не «устаканилась». Гейт СТРОГО для subtask'ов:
             -- fork/epic-зависимости висят на task_id service/epic и сюда не попадают.
             -- Активная зависимость держит; терминал/BLOCKED — отпускает (без дедлока).
             AND NOT (
               t.task_kind = 'subtask'
               AND EXISTS (
                 SELECT 1 FROM task_dependencies d
                   JOIN tasks dep ON dep.id = d.depends_on_task_id
                  WHERE d.task_id = t.id
                    AND dep.status NOT IN ('DONE','CANCELLED','FAILED','BLOCKED'))
             )
           ORDER BY t.priority ASC, t.created_at ASC
           FOR UPDATE OF t SKIP LOCKED
           LIMIT 1
         )
         UPDATE tasks t
            SET assigned_agent_id = (SELECT id FROM agents WHERE code = 'claude_programmer')
           FROM picked
          WHERE t.id = picked.id
          RETURNING t.id, t.title, t.description, t.project_id, t.service_id, t.current_role_id`,
        [PROGRAMMER_RELEASE_BACKOFF_MS],
      );
      if (!picked.rowCount) {
        return { task: null };
      }
      const row = picked.rows[0];
      const meta = await c.query(
        `SELECT p.code AS project_code, s.service_code, t.task_kind, t.data_card
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id
          WHERE t.id = $1`,
        [row.id],
      );
      const { project_code, service_code, task_kind, data_card } = meta.rows[0];
      // STACK-SPECIALIZATION-001: стек задачи из карточки (Архитектор проставляет его
      // по сервису в work_items). Раннер подаёт по нему профиль скилов; null → раннер
      // определит стек сам по описанию.
      const stack = resolveTaskStack(data_card);
      // Проброс контекста Programmer'у: вывод ARCHITECT/DECOMPOSER и последнее
      // ревью, чтобы Claude реализовывал по проекту, а не с нуля.
      const prior = await fetchPriorOutputs(c, row.id);
      // Инструменты PROGRAMMER: MCP-серверы (для запуска Claude Code) + уровни
      // доступа (read/modify/create/delete). Claude Code получит MCP-конфиг.
      const { getToolsForRole } = await import('./tools.js');
      const { buildMcpConfig } = await import('./toolsClient.js');
      const progTools = await getToolsForRole(c, 'PROGRAMMER');
      const mcpConfig = progTools.mcp.length ? await buildMcpConfig(progTools.mcp) : { mcpServers: {} };
      // Контракт роли: требования, которые Claude ОБЯЗАН выполнить перед сдачей.
      // Те же поля строго проверяет acceptScannerCompletion (нельзя вернуть без них).
      const progContract = await loadRoleContract(c, 'PROGRAMMER');
      const requiredFields = progContract.outputs.filter((f) => f.required).map((f) => f.key);
      const assigned = await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'AGENT_ASSIGNED', 'CODING', $2, $3::jsonb)
         RETURNING id`,
        [row.id, row.current_role_id, JSON.stringify({ target: 'claude-tasks.json', agent: 'claude_programmer' })],
      );
      // PROGRAMMER-UNIFY-001: программист наблюдается так же, как рассуждающие роли —
      // через agent_runs (а не только task_events). Создаём прогон RUNNING при
      // захвате; путь сдачи (acceptScannerCompletion) и releaseClaudeTask его
      // финализируют, осиротевший — закрывает releaseStaleClaudeClaims по
      // CLAUDE_ASSIGN_TIMEOUT_MS (resetStaleClaims программиста НЕ трогает — у него
      // более длинный таймаут сессии). Так PROGRAMMER попадает в «Монитор» (roleLoad)
      // и в версионные KPI единообразно со всеми.
      //
      // Движок роли (карточка роли → role_connectors): модель назначенного
      // включённого коннектора версионирует прогон и реально выбирает агента для
      // программиста (см. claudeAgent.js). Так «тот же промт, разные модели/агенты»
      // сравнимы в разрезе версий. Без назначения — модель агента по умолчанию.
      const progAgent = await c.query(
        `SELECT id, model FROM agents WHERE code = 'claude_programmer' LIMIT 1`,
      );
      const progAgentId = progAgent.rows[0]?.id ?? null;
      // Программиста исполняет Claude Agent SDK (programmer-runner), поэтому модель
      // берём ТОЛЬКО у Claude-совместимого движка (драйвер claude_code или
      // anthropic-API). Модель от deepseek/codex/openai не подсунет SDK имя чужой
      // модели; такой коннектор → fallback на дефолт агента.
      const progConn = await c.query(
        `SELECT cn.id::text AS connector_id, cn.provider, cn.model FROM role_connectors rc
           JOIN connectors cn ON cn.id = rc.connector_id
          WHERE rc.role_code = 'PROGRAMMER' AND cn.is_enabled = true
            AND lower(cn.provider) IN ('claude_code', 'anthropic')
          LIMIT 1`,
      );
      // PROGRAMMER-MODEL-ROUTING-001: модель по сложности задачи (Sonnet для мелких
      // подзадач-на-файл, Opus для цельных задач-на-сервис). Эффективная модель:
      // явный Claude-коннектор роли (осознанный override оператора) > роутинг по
      // сложности > дефолт агента > пусто (раннер сам решит).
      // ROLE-ENGINE-ROUTING-002: неизменяемый снимок фактического движка программиста.
      // Источник истины — назначенный роли Claude-совместимый коннектор (см. выше). Нет
      // назначения → снимок пустой (раннер исполняет дефолтным агентом, коннектор не
      // зафиксирован). snapshot_model = эффективная модель, которой реально исполняется.
      const { model: programmerModel, snapshot: progSnap } = buildProgrammerRunSnapshot({
        connectorRow: progConn.rows[0] ?? null,
        agentRow: progAgent.rows[0] ?? null,
        taskKind: task_kind,
      });
      // Прогон закрывают по task_id (на задачу — ровно один RUNNING под PROGRAMMER),
      // поэтому id прогона дальше не нужен.
      if (progAgentId) {
        await c.query(
          `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json, model,
             snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
           VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8, $9)`,
          [row.id, progAgentId, row.current_role_id,
            JSON.stringify({ roleCode: 'PROGRAMMER', status: 'CODING' }), programmerModel,
            progSnap.connectorId, progSnap.provider, progSnap.model, progSnap.driverType],
        );
      }
      // Ключ сдачи ДОЛЖЕН быть уникален для каждого захвата задачи, а не только для
      // её id. Иначе после повторного входа задачи в CODING (RESTART/refeed/доработка
      // от ревьюера) её сдача попадёт в scanner_dispatches как дубль по уже
      // существующему (task_id, completion_key) → acceptScannerCompletion вернёт
      // duplicate БЕЗ продвижения, задача навсегда залипнет в CODING и claim_next_
      // claude_task начнёт по кругу выдавать одну и ту же «уже завершённую» задачу.
      // Привязка к id события AGENT_ASSIGNED (создаётся при каждом захвате) даёт
      // свежий ключ на каждый заход и сохраняет идемпотентность в рамках одного
      // захвата (исполнитель сдаёт ровно тем ключом, что получил здесь).
      const completionKey = `programmer-${row.id}-${assigned.rows[0].id}`;
      const task = buildProgrammerClaimTask({
        row,
        projectCode: project_code,
        serviceCode: service_code,
        model: programmerModel,
        prior,
        tools: progTools,
        mcpConfig,
        requiredFields,
        completionKey,
        stack,
      });
      return { task };
  });
}

/**
 * Откат захвата: вернуть задачу в пул, если фидер не смог записать файл.
 * Снимаем назначение агента только с задачи, всё ещё ожидающей кодинга.
 */
// PROGRAMMER-RELEASE-REASON-001: предел длины outcome/error_text при освобождении
// захвата. Единая точка записи → защищает agent_runs от раздувания независимо от
// источника reason (длинный error.message, петля захват→провал→release). 500
// символов достаточно для диагностики причины.
const RELEASE_TEXT_MAX = 500;
function clipReleaseText(v) {
  const str = String(v ?? '');
  return str.length > RELEASE_TEXT_MAX ? str.slice(0, RELEASE_TEXT_MAX) : str;
}

// Публичная обёртка над Tx: открывает соединение и делегирует транзакционной части
// (её же дёргают юнит-тесты с поддельным клиентом, как advanceTaskTx/moveTaskTx).
export async function releaseClaudeTask(s, taskId, opts = {}) {
  return withClient(clientConfig(s), async (c) => {
    const result = await releaseClaudeTaskTx(c, taskId, opts);
    if (result?.released) {
      await exportLatestAgentRunObservation(c, taskId, {
        eventType: 'programmer_released',
        roleCode: 'PROGRAMMER',
        reason: opts.reason || 'released',
        payload: { result, meta: opts.meta ?? null },
      });
    }
    return result;
  });
}

export async function releaseClaudeTaskTx(c, taskId, opts = {}) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withTransaction(c, async () => {
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND status = 'CODING'
        RETURNING id, current_role_id`,
      [id],
    );
    const released = r.rowCount > 0;
    // PROGRAMMER-LIMIT-KPI-001: упор программиста в лимит ходов — отдельный KPI.
    // Пишем append-only событие (event_type=TASK_UPDATED + kind-дискриминатор),
    // чтобы Монитор считал его как сигнал плохой нарезки задачи (Декомпозитор/
    // Архитектор), не заводя новое значение в enum event_type. Записываем только
    // когда задача реально была освобождена из CODING (есть строка с контекстом).
    if (released && opts.reason === 'max_turns_exceeded') {
      const numTurns = Number(opts.meta?.numTurns);
      const maxTurns = Number(opts.meta?.maxTurns);
      await c.query(
        `INSERT INTO task_events (task_id, event_type, role_id, payload_json)
         VALUES ($1, 'TASK_UPDATED', $2, $3::jsonb)`,
        [id, r.rows[0].current_role_id, JSON.stringify({
          source: 'programmer-runner',
          kind: 'programmer_limit_exceeded',
          reason: 'max_turns_exceeded',
          numTurns: Number.isFinite(numTurns) ? numTurns : null,
          maxTurns: Number.isFinite(maxTurns) ? maxTurns : null,
        })],
      );
    }
    // PROGRAMMER-UNIFY-001: освобождение захвата = прогон не дал результата.
    // Финализируем RUNNING-прогон программиста (созданный при захвате), чтобы он не
    // висел вечно и корректно считался в KPI. Исход по причине: упор в лимит ходов и
    // прочие провалы → FAILED; таймаут агента → TIMEOUT. turns берём из meta, если
    // раннер прислал. Толерантно: нет прогона → 0 строк.
    if (released) {
      const reason = String(opts.reason ?? '').trim();
      const runStatus = reason === 'agent_timeout' ? 'TIMEOUT' : 'FAILED';
      // Обрезаем и outcome, и error_text до предела: reason приходит извне (может
      // быть длинным error.message), а петля release множит такие записи.
      const outcome = clipReleaseText(reason || 'released');
      const errorText = clipReleaseText(`programmer_released: ${outcome}`);
      const turns = Number.isFinite(Number(opts.meta?.numTurns))
        ? Math.trunc(Number(opts.meta.numTurns)) : null;
      await c.query(
        `UPDATE agent_runs
            SET status = $2::agent_run_status, finished_at = now(), turns = $3, outcome = $4,
                error_text = $5
          WHERE id = (
            SELECT id FROM agent_runs
             WHERE task_id = $1 AND role_id = $6 AND status = 'RUNNING'
             ORDER BY started_at DESC LIMIT 1
          )`,
        [id, runStatus, turns, outcome, errorText, r.rows[0].current_role_id],
      );
    }
    // PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: агент явно упёрся в контракт/сгенерированный
    // код ДРУГОГО сервиса (meta.blockerKind='cross_service'). Гонять такую задачу по
    // кругу в CODING бессмысленно — граница сервиса выбрана неверно. Сразу уводим в
    // BLOCKED с точной причиной и именем блокирующего сервиса: оператор переразобьёт
    // (Архитектор/Декомпозер) через manual-move. Ловим на ПЕРВОМ явном сигнале, а не
    // после исчерпания backoff/loop-cap (5 холостых прогонов). Причину дублируем в
    // data_card (видно в карточке, как у прочих авто-блоков).
    let crossServiceBlocked = false;
    if (released && opts.meta && opts.meta.blockerKind === 'cross_service') {
      const upd = await c.query(
        `UPDATE tasks SET status = 'BLOCKED' WHERE id = $1 AND status = 'CODING' RETURNING id`,
        [id],
      );
      if (upd.rowCount) {
        crossServiceBlocked = true;
        const blockedBy = opts.meta.blockedByService
          ? String(opts.meta.blockedByService).slice(0, 120) : null;
        const detail = 'Программист заблокирован контрактом/сгенерированным кодом другого '
          + 'сервиса — нужна ре-декомпозиция (Архитектор/Декомпозер), а не повтор в CODING.';
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_BLOCKED', 'CODING', 'BLOCKED', $2, $3::jsonb)`,
          [id, r.rows[0].current_role_id, JSON.stringify({
            runner: true, reason: 'cross_service_dependency', blockedByService: blockedBy, detail,
          })],
        );
        await c.query(
          `UPDATE tasks SET data_card = COALESCE(data_card, '{}'::jsonb) || jsonb_build_object(
             'cross_service_block',
             jsonb_build_object('reason', 'cross_service_dependency', 'blockedByService', $2::text))
            WHERE id = $1`,
          [id, blockedBy],
        );
      }
    }
    return { released, taskId: id, crossServiceBlocked };
  });
}

// --- Host-мост для ролей действия (PIPELINE_SERVICE, GIT_INTEGRATOR) ---------
// Эти роли требуют реального docker/git и не могут исполняться в контейнере
// оркестратора. Host-runner (нативный процесс) забирает задачу, выполняет
// действие на хосте и сообщает результат обратно. БД остаётся источником истины.

const HOST_ROLES = {
  PIPELINE_SERVICE: { from: 'TESTING' },
  GIT_INTEGRATOR: { from: 'COMMIT' },
};

/**
 * FORK-BRANCH-CONTEXT-001 — контекст host-задачи с учётом fork-веток. Ветка fork
 * (ребёнок, created_by='fork') не несёт событий сдачи программиста — они на
 * родителе/корне. Раньше scan смотрел только события самой задачи: у ребёнка их
 * нет → Git Integrator получал пустой changedFiles и завершался
 * note='no_changed_files', код оставался не закоммиченным. Ищем по всей цепочке
 * предков; пустые ([]/'') не считаются сдачей (иначе TASK_CREATED с changedFiles:[]
 * перекрыл бы реальную сдачу).
 *
 * STALE-COMPLETION-ROLE-GUARD-001: changedFiles АГРЕГИРУЕМ по всей цепочке событий
 * сдачи с дедупом (объединение непустых списков, порядок первого вхождения), а не
 * берём одно последнее событие. Иначе поздний дубль сдачи с changedFiles:[] (но
 * непустым result) выигрывал по created_at DESC и перекрывал реальный список файлов
 * из более ранней валидной сдачи (инцидент f43a9f6c: пустой список затёр 5 файлов →
 * Git Integrator получил no_changed_files, код не был закоммичен). result берём из
 * последней сдачи с непустым result. rootTask — корень цепочки (карточка Приёмщика
 * для коммита).
 */
export async function resolveHostTaskContext(c, taskId) {
  const chain = await c.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_task_id, title, description, 0 AS depth
         FROM tasks WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_task_id, p.title, p.description, chain.depth + 1
         FROM tasks p JOIN chain ON p.id = chain.parent_task_id
        WHERE chain.depth < 8
     )
     SELECT id, title, description, depth FROM chain ORDER BY depth`,
    [taskId],
  );
  const chainIds = chain.rows.length ? chain.rows.map((r) => r.id) : [taskId];
  const rootTask = chain.rows[chain.rows.length - 1] ?? null;
  const ev = await c.query(
    `SELECT payload_json FROM task_events
      WHERE task_id = ANY($1::uuid[])
        AND (
          (jsonb_typeof(payload_json->'changedFiles') = 'array'
            AND jsonb_array_length(payload_json->'changedFiles') > 0)
          OR COALESCE(payload_json->>'result', '') <> ''
        )
      ORDER BY created_at DESC`,
    [chainIds],
  );
  if (!ev.rows.length) return { chainIds, rootTask, scan: null };
  // Агрегируем changedFiles по всем событиям сдачи цепочки с дедупом; пустой список
  // одного события не перекрывает непустой из другого (см. docblock).
  const seen = new Set();
  const changedFiles = [];
  for (const row of ev.rows) {
    const files = row.payload_json?.changedFiles;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      const key = String(f);
      if (seen.has(key)) continue;
      seen.add(key);
      changedFiles.push(f);
    }
  }
  // result — последняя сдача с непустым результатом (события отсортированы DESC).
  // COMPLETION-SUMMARY-TEXT-001: извлекаем текстовый summary (result мог быть записан
  // объектом), а НЕ приводим объект через String() → иначе «[object Object]» уходит в
  // приоры следующих ролей.
  const withResult = ev.rows.find((row) => resultSummaryText(row.payload_json?.result) !== '');
  const result = withResult ? resultSummaryText(withResult.payload_json.result) : '';
  // WORKTREE-BRANCH-CONTEXT-001: последняя непустая ветка/коммит worktree сдачи
  // программиста по цепочке событий (события отсортированы created_at DESC, поэтому
  // первое непустое значение — самое свежее). Нужны Git Integrator, чтобы влить
  // ветку programmer/<...> в main. Старая сдача без этих полей → null (прежнее поведение).
  // DELIVERED-COMMIT-COUPLE-001: worktreeBranch и deliveredCommit ОБЯЗАНЫ браться из
  // ОДНОЙ и той же (самой свежей) сдачи. Раньше они резолвились независимо: после
  // повторного прогона с ПУСТОЙ дельтой у свежей сдачи deliveredCommit=null, но
  // worktreeBranch есть — и независимый поиск дотягивал deliveredCommit до СТАРОГО
  // цикла. Git Integrator пытался влить устаревший коммит и падал cherry_pick_failed,
  // хотя ветка уже сброшена на main и дельта пуста. Берём самую свежую сдачу с
  // непустым worktreeBranch и её deliveredCommit «как есть»: null → GI сам возьмёт
  // tip ветки (already_integrated + повтор доставки), а не устаревший SHA.
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const deliveryRow = ev.rows.find((r) => str(r.payload_json?.worktreeBranch) !== null);
  const worktreeBranch = deliveryRow ? str(deliveryRow.payload_json.worktreeBranch) : null;
  const deliveredCommit = deliveryRow ? str(deliveryRow.payload_json.deliveredCommit) : null;
  return { chainIds, rootTask, scan: { payload_json: { changedFiles, result, worktreeBranch, deliveredCommit } } };
}

/**
 * Захватить следующую задачу для host-роли. Аналог claimNextClaudeTask, но для
 * PIPELINE_SERVICE/GIT_INTEGRATOR. Помечает agent_run RUNNING и возвращает
 * контекст для исполнения на хосте (включая changedFiles сдачи программиста,
 * найденные по цепочке предков — см. resolveHostTaskContext).
 */
export async function claimNextHostTask(s, roleCode) {
  const role = HOST_ROLES[roleCode];
  if (!role) throw scannerError(422, 'unsupported_host_role');
  return withClient(clientConfig(s), async (c) => {
    if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
    await c.query('BEGIN');
    try {
      const picked = await c.query(
        `SELECT t.id, t.title, t.description, t.current_role_id, t.project_id, t.service_id,
                t.status::text AS status
           FROM tasks t
           JOIN roles r ON r.id = t.current_role_id
           JOIN projects p ON p.id = t.project_id
          WHERE r.code = $1 AND r.hidden = false AND t.assigned_agent_id IS NULL
            AND p.status <> 'paused'
            AND (
              EXISTS (
                SELECT 1 FROM project_stages ps
                  JOIN project_stage_roles psr ON psr.stage_id = ps.id
                 WHERE ps.project_id = t.project_id AND ps.enabled = true
                   AND psr.role_id = r.id AND ps.task_status::text = t.status::text
                   AND (t.current_stage_key IS NULL OR ps.stage_key = t.current_stage_key)
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM project_stages ps2
                   WHERE ps2.project_id = t.project_id AND ps2.enabled = true AND ps2.task_status IS NOT NULL
                )
                AND t.status = $2::task_status
              )
            )
          ORDER BY t.priority ASC, t.created_at ASC
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1`,
        [roleCode, role.from],
      );
      if (!picked.rowCount) {
        await c.query('COMMIT');
        return { task: null };
      }
      const t = picked.rows[0];
      // Исполнитель host-роли — активный агент роли; для не-AI ролей это local-
      // провайдер (pipeline-runner), который предпочитается AI-агенту.
      const agent = await c.query(
        `SELECT id FROM agents WHERE role_id = $1 AND is_active = true
          ORDER BY (provider = 'local') DESC, created_at LIMIT 1`,
        [t.current_role_id],
      );
      const agentId = agent.rows[0]?.id ?? null;
      if (!agentId) {
        await c.query('ROLLBACK');
        return { task: null };
      }
      await c.query('UPDATE tasks SET assigned_agent_id = $2 WHERE id = $1', [t.id, agentId]);
      // ROLE-ENGINE-ROUTING-002: снимок движка host-роли (обычно локальный
      // исполнитель без AI-коннектора → все поля NULL; заполняется, если роли явно
      // назначен включённый коннектор).
      const hostSnap = await resolveConnectorSnapshot(c, roleCode);
      const run = await c.query(
        `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json,
           snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
         VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8) RETURNING id`,
        [t.id, agentId, t.current_role_id, JSON.stringify({ roleCode, host: true }),
          hostSnap.connectorId, hostSnap.provider, hostSnap.model, hostSnap.driverType],
      );
      const meta = await c.query(
        `SELECT p.id AS project_id, p.code AS project, p.root_path,
                s.id AS service_id, s.service_code AS service, s.service_name, s.repository_path
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
        [t.id],
      );
      const m = meta.rows[0] ?? {};
      const { rootTask, scan } = await resolveHostTaskContext(c, t.id);

      // PIPELINE_SERVICE — не-AI исполнитель: контракт claim фиксирует точный
      // микросервис и разрешённую рабочую директорию (без AI agent run/LLM).
      // Неизвестный сервис или выход за корень проекта → диагностируемая ошибка
      // ДО запуска команд (транзакция откатывается, задача не выдаётся).
      let pipeline = null;
      if (roleCode === 'PIPELINE_SERVICE') {
        // PIPELINE-CLAIM-UNWEDGE-001: нерезолвящийся сервис раньше ронял claim
        // HTTP 422 — раннер получал отказ по кругу, а «кривая» задача (голова
        // выборки) заклинивала ВСЕ pipeline-задачи проекта. Теперь стопорим САМУ
        // задачу: прогон закрываем FAILED с ошибкой (видно в истории этапа),
        // задачу — в BLOCKED с причиной в карточке (пуск руками после заполнения
        // пути сервиса), COMMIT. Следующий тик claim берёт следующего кандидата.
        const blockPipelineTask = async (code, message) => {
          await c.query(
            `UPDATE agent_runs SET status = 'FAILED', finished_at = now(),
                    output_json = $2::jsonb, error_text = $3 WHERE id = $1`,
            [run.rows[0].id, JSON.stringify({ error: { code, message } }), message],
          );
          await c.query(
            `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL,
                    data_card = COALESCE(data_card, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
            [t.id, JSON.stringify({ pipeline_claim_block: { code, reason: message, service: m.service ?? null } })],
          );
          await c.query(
            `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
             VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
            [t.id, t.status, t.current_role_id,
             JSON.stringify({ runner: true, reason: code, detail: message, service: m.service ?? null })],
          );
          await c.query('COMMIT');
        };
        // SERVICE-REPO-PATH-001: репозиторный путь сервиса ОБЯЗАН указывать на
        // существующий каталог. Пустой/устаревший путь раньше проходил как
        // «сборка от корня» → pipeline_compose_not_found. Теперь: валидный путь
        // оставляем, иначе бэкфилл по коду (ленивое обновление), иначе —
        // диагностируемый провал service_path_unresolved ДО запуска стадий.
        const resolvedPath = resolveServiceRepoPath(m.root_path, m.service, m.repository_path);
        if (!resolvedPath.ok) {
          await blockPipelineTask(resolvedPath.code, resolvedPath.message);
          return { task: null, blocked: { taskId: t.id, code: resolvedPath.code } };
        }
        if (resolvedPath.changed) {
          await c.query('UPDATE services SET repository_path = $2 WHERE id = $1', [m.service_id, resolvedPath.repositoryPath]);
          m.repository_path = resolvedPath.repositoryPath;
        }
        try {
          pipeline = buildPipelineClaimContract({
            projectId: m.project_id,
            projectCode: m.project,
            serviceId: m.service_id,
            serviceCode: m.service,
            serviceName: m.service_name,
            projectRoot: m.root_path,
            repositoryPath: resolvedPath.repositoryPath,
          });
        } catch (err) {
          await blockPipelineTask(err.code || 'pipeline_contract_invalid', err.message || 'pipeline_contract_invalid');
          return { task: null, blocked: { taskId: t.id, code: err.code || 'pipeline_contract_invalid' } };
        }
      }

      await c.query('COMMIT');
      // FORK-BRANCH-CONTEXT-001: коммит Git Integrator подписывается карточкой
      // Приёмщика (short_title/structured_description) — они на КОРНЕВОЙ задаче,
      // а у fork-ребёнка заголовок с суффиксом «[ветка]». Для остальных host-ролей
      // заголовок оставляем как есть (в коммит он не попадает).
      const useRoot = roleCode === 'GIT_INTEGRATOR' && rootTask && rootTask.id !== t.id;
      return {
        task: {
          id: t.id,
          role: roleCode,
          title: useRoot ? rootTask.title : t.title,
          description: (useRoot ? rootTask.description : t.description) ?? '',
          projectId: m.project_id ?? null,
          project: m.project ?? '',
          serviceId: m.service_id ?? null,
          service: m.service ?? '',
          serviceName: m.service_name ?? '',
          projectRoot: m.root_path ?? '',
          repositoryPath: m.repository_path ?? '',
          changedFiles: scan?.payload_json?.changedFiles ?? [],
          programmerResult: scan?.payload_json?.result ?? '',
          // WORKTREE-BRANCH-CONTEXT-001: ветка/коммит worktree сдачи программиста —
          // Git Integrator вливает их в main (merge/cherry-pick), а не ищет
          // незакоммиченные файлы в основном дереве. Нет сдачи через worktree → null.
          worktreeBranch: scan?.payload_json?.worktreeBranch ?? null,
          deliveredCommit: scan?.payload_json?.deliveredCommit ?? null,
          agentRunId: run.rows[0].id,
          // Контракт прямого запуска pipeline (только для PIPELINE_SERVICE).
          ...(pipeline ? { pipeline } : {}),
        },
      };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

// Терминальные статусы задачи: жизненный цикл завершён, каноническая запись
// сохраняется как история проекта. Повторный сигнал завершения такой задачи
// обрабатывается идемпотентно — без новых событий, изменения истории и двойного
// учёта в «Завершено». Набор общий (src/taskPolicy.js, импортирован выше).

// ENV-SETUP-FAIL-FAST-001 (клапан, дефолт OFF) — при setup-сбое Go-воркспейса
// (env_setup_failed: модуль вне go.work → тесты/сборка не стартуют) блокировать
// задачу СРАЗУ, минуя Аналитика сбоя: анализировать нечего (код задачи не при чём),
// а петля CODING→TESTING→FA до max_rework лишь жжёт токены (инцидент 26.07: 4 круга
// × ~$12/задача). Включить: env PIPELINE_ENV_FAIL_FAST=1|true|on. При OFF — прежнее
// поведение (провал стадии → Аналитик сбоя).
const PIPELINE_ENV_FAIL_FAST = /^(1|true|on)$/i.test(String(process.env.PIPELINE_ENV_FAIL_FAST ?? '').trim());

/**
 * Принять результат host-роли и сделать переход. Для PIPELINE_SERVICE пишет
 * pipeline_runs. Переход считает МАРШРУТ ПРОЕКТА (граф при current_stage_key,
 * иначе позиционный) — nextRole НЕ захардкожен: успех Pipeline Service ведёт в
 * следующий узел графа (напр. fork), Failure Analyst достижим только по ветке
 * провала. Для GIT_INTEGRATOR success → конец маршрута (DONE), fail → BLOCKED.
 */
export async function completeHostTask(s, input) {
  return withClient(clientConfig(s), async (c) => {
    const result = await completeHostTaskTx(c, input);
    if (result?.taskId) {
      await exportLatestAgentRunObservation(c, result.taskId, {
        eventType: 'host_role_completed',
        roleCode: result.role,
        reason: result.reason || (result.success === false ? 'host_failed' : 'host_completed'),
        payload: { result },
      });
    }
    return result;
  });
}

/**
 * Транзакционное ядро completeHostTask. Вынесено отдельной экспортируемой
 * функцией, чтобы тестировать переходы и идемпотентность на фейковом клиенте
 * без живого Postgres. Никогда не удаляет каноническую запись задачи: успешное
 * завершение лишь переводит её в DONE и пишет событие TASK_DONE.
 */
export async function completeHostTaskTx(c, input) {
  const taskId = String(input?.taskId ?? '').trim();
  const roleCode = String(input?.roleCode ?? input?.role ?? '').trim();
  const success = input?.success === true || input?.success === 'true';
  const output = input?.output ?? {};
  if (!taskId) throw scannerError(422, 'taskId_required');
  if (!HOST_ROLES[roleCode]) throw scannerError(422, 'unsupported_host_role');

  {
    await c.query('BEGIN');
    try {
      // LEFT JOIN: у терминальной задачи current_role_id = NULL, INNER JOIN дал
      // бы пустой результат и ложный 404 на повторном сигнале завершения.
      const found = await c.query(
        `SELECT t.id, t.status::text AS status, t.current_role_id, t.assigned_agent_id,
                t.project_id, t.current_stage_key, r.code AS role_code
           FROM tasks t LEFT JOIN roles r ON r.id = t.current_role_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [taskId],
      );
      if (!found.rowCount) throw scannerError(404, 'task_not_found');
      const t = found.rows[0];

      // Идемпотентность: задача уже завершена/отменена/провалена. Повторный
      // completion (двойной сигнал host-runner, ретрай, переотправка после
      // очистки активной очереди) не пишет событие, не меняет историю и не
      // увеличивает «Завершено» — каноническая запись остаётся как есть.
      if (TERMINAL_TASK_STATUSES.has(t.status)) {
        await c.query('COMMIT');
        return { accepted: true, duplicate: true, taskId, toStatus: t.status, nextRole: null };
      }

      if (t.role_code !== roleCode) throw scannerError(409, 'role_mismatch');

      // Целевой переход — по маршруту проекта (PIPELINE-DYNAMIC-ROUTE-001).
      // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (в т.ч.
      // Pipeline Service при успехе → узел fork, а НЕ захардкоженный Documentation
      // Auditor на родителе, минуя FORK_GATE). Без ключа — прежняя позиционная
      // маршрутизация (линейные схемы не затронуты).
      const route = await loadProjectRoute(c, t.project_id);
      const claimedLike = {
        id: t.id, project_id: t.project_id, current_stage_key: t.current_stage_key,
        role_code: roleCode, status: t.status,
      };
      const resolveHost = (decision) => (t.current_stage_key
        ? resolveGraphTransition(c, claimedLike, decision)
        : resolveTransition(route, roleCode, decision, {
          currentStatus: t.status,
          currentStageKey: t.current_stage_key,
        }));
      let resolved;
      if (roleCode === 'PIPELINE_SERVICE') {
        await c.query(
          `INSERT INTO pipeline_runs (task_id, status, failed_stage, started_at, finished_at, summary_json, log_path)
           VALUES ($1, $2::pipeline_status, $3, $4, now(), $5::jsonb, $6)`,
          [
            taskId,
            success ? 'SUCCESS' : 'FAILED',
            output.failedStage ?? null,
            output.startedAt ?? null,
            JSON.stringify(output.summary ?? output),
            output.logPath ?? null,
          ],
        );
        // ENV-SETUP-FAIL-FAST-001: инфраструктурный setup-сбой Go-воркспейса (модуль
        // вне go.work → go test/build не стартует) анализировать нечего — блокируем
        // СРАЗУ, минуя Аналитика сбоя и петлю реворков. За клапаном (дефолт OFF).
        if (!success && PIPELINE_ENV_FAIL_FAST && detectEnvSetupFailure(output)) {
          const reason = 'env_setup_failed';
          await c.query(
            `UPDATE tasks SET status = 'BLOCKED', current_role_id = NULL, assigned_agent_id = NULL,
                    data_card = data_card || $2::jsonb, current_stage_key = $3::uuid
              WHERE id = $1`,
            [taskId, JSON.stringify({ orchestration_error: reason }), t.current_stage_key ?? null],
          );
          await c.query(
            `UPDATE agent_runs
                SET status = 'FAILED', finished_at = COALESCE(finished_at, now()), error_text = $2,
                    output_json = $3::jsonb
              WHERE id = (
                SELECT id FROM agent_runs
                 WHERE task_id = $1 AND role_id = $4 AND status IN ('RUNNING','TIMEOUT')
                 ORDER BY started_at DESC LIMIT 1
              )`,
            [taskId, deriveHostFailureText(roleCode, output), JSON.stringify(output), t.current_role_id],
          );
          await c.query(
            `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
             VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
            [taskId, t.status, t.current_role_id, JSON.stringify({
              runner: true, host: true, role: roleCode, event: 'env_setup_failed', reason,
              detail: 'setup-сбой Go-воркспейса (модуль вне go.work): нужен GOWORK=off или включение модуля в go.work; задача заблокирована без анализа сбоя (ENV-SETUP-FAIL-FAST-001)',
              outcome: 'BLOCK',
            })],
          );
          await c.query('COMMIT');
          return { taskId, role: roleCode, success: false, toStatus: 'BLOCKED', nextRole: null, reason };
        }
        // Успех → вперёд по маршруту (граф минует аналитика на зелёном пути);
        // провал → к аналитику (ветка 'failure' графа / branch линейного маршрута).
        resolved = await resolveHost(success
          ? { outcome: 'FORWARD' }
          : { outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework' });
      } else {
        // GIT_INTEGRATOR: успех завершает маршрут, провал — стоп.
        // GI-BLOCK-KEEP-STAGE-001: при провале СОХРАНЯЕМ current_stage_key (nextStageKey
        // = текущий узел), иначе общий UPDATE ниже (current_stage_key = nextStageKey ??
        // null) обнулял позицию в графе, и ручной разблок (bulk_unblock_refeed) не мог
        // возобновить граф-задачу с нужного узла COMMIT. Ср. ветку next_role_missing,
        // которая current_stage_key не трогает.
        resolved = success
          ? await resolveHost({ outcome: 'FORWARD' })
          : { nextRole: null, toStatus: 'BLOCKED', done: false, blocked: true, nextStageKey: t.current_stage_key, via: t.current_stage_key ? 'graph' : 'route' };
      }
      const toStatus = resolved.toStatus;
      const nextRole = resolved.nextRole;

      // Значения исходящих полей host-роли → кумулятивная карточка задачи.
      const hostContract = await loadRoleContract(c, roleCode);
      const { values: hostCardValues } = extractOutputs(output?.fields ?? output, hostContract.outputs);

      const keepCurrentRoleOnBlock = roleCode === 'GIT_INTEGRATOR' && !success && resolved.blocked;
      const nextRoleId = keepCurrentRoleOnBlock
        ? t.current_role_id
        : (!nextRole ? null : await roleIdByCode(c, nextRole));
      if (nextRole && !nextRoleId) {
        const reason = `next_role_missing:${nextRole}`;
        await c.query(
          `UPDATE tasks SET status = 'BLOCKED', current_role_id = NULL, assigned_agent_id = NULL,
                  data_card = data_card || $2::jsonb
            WHERE id = $1`,
          [taskId, JSON.stringify({ orchestration_error: reason, ...hostCardValues })],
        );
        const failureText = reason.slice(0, HOST_FAILURE_TEXT_MAX);
        await c.query(
          `UPDATE agent_runs
              SET status = 'FAILED', finished_at = COALESCE(finished_at, now()), error_text = $2,
                  output_json = COALESCE(output_json, '{}'::jsonb) || $3::jsonb
            WHERE task_id = $1 AND role_id = $4
              AND status IN ('RUNNING','TIMEOUT')`,
          [taskId, failureText, JSON.stringify({ reason, output }), t.current_role_id],
        );
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
          [taskId, t.status, t.current_role_id, JSON.stringify({
            runner: true, host: true, role: roleCode, reason, missingRole: nextRole,
            outcome: 'BLOCK', via: resolved.via,
          })],
        );
        await c.query('COMMIT');
        return { taskId, role: roleCode, success: false, toStatus: 'BLOCKED', nextRole: null, reason };
      }

      // FORK-JOIN-001: в граф-режиме переносим текущий узел на следующий (напр. на
      // узел fork после успеха Pipeline Service); в линейном режиме остаётся NULL.
      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3, assigned_agent_id = NULL,
                data_card = data_card || $4::jsonb, current_stage_key = $5::uuid WHERE id = $1`,
        [taskId, toStatus, nextRoleId, JSON.stringify(hostCardValues || {}), resolved.nextStageKey ?? null],
      );
      // BOOT-RECONCILE-GRACE-001: закрыть прогон host-роли по фактическому исходу.
      // Берём последний прогон роли в статусе RUNNING ЛИБО TIMEOUT. Host-runner
      // переживает рестарт оркестратора и досылает результат ПОСЛЕ boot-жнеца; тот
      // уже снял assigned_agent_id и мог пометить прогон TIMEOUT — поэтому не гейтим
      // по assigned_agent_id и переписываем TIMEOUT на фактический SUCCESS/FAILED,
      // иначе KPI и «Нагрузка по ролям» навсегда считают такой прогон таймаутом.
      // HOST-FAILURE-TEXT-001: при провале host-роли пишем НЕПУСТОЙ структурированный
      // error_text (код причины из output), чтобы монитор показывал причину падения
      // PIPELINE_SERVICE, а не пустоту. При успехе error_text не трогаем ($5 не
      // добавляем). Общий формат кода причины (deriveHostFailureText) переиспользует
      // ветка GIT_INTEGRATOR (ORCH-GI-BLOCKED-OWNER-001).
      const runParams = [taskId, success ? 'SUCCESS' : 'FAILED', JSON.stringify(output), t.current_role_id];
      if (!success) runParams.push(deriveHostFailureText(roleCode, output));
      await c.query(
        `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb${success ? '' : ', error_text = $5'}
          WHERE id = (
            SELECT id FROM agent_runs
             WHERE task_id = $1 AND role_id = $4 AND status IN ('RUNNING','TIMEOUT')
             ORDER BY started_at DESC LIMIT 1
          )`,
        runParams,
      );
      const done = toStatus === 'DONE';
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
        [
          taskId,
          done ? 'TASK_DONE' : 'STATUS_CHANGED',
          t.status,
          toStatus,
          t.current_role_id,
          JSON.stringify({ host: true, role: roleCode, success, output, nextRole }),
        ],
      );
      await c.query('COMMIT');
      return { accepted: true, duplicate: false, taskId, toStatus, nextRole };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  }
}

// Откат захвата host-задачи (host-runner не смог выполнить действие).
export async function releaseHostTask(s, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND status IN ('TESTING','COMMIT') RETURNING id`,
      [id],
    );
    await c.query(
      `UPDATE agent_runs SET status = 'CANCELLED', finished_at = now() WHERE task_id = $1 AND status = 'RUNNING'`,
      [id],
    );
    const result = { released: r.rowCount > 0, taskId: id };
    if (result.released) {
      await exportLatestAgentRunObservation(c, id, {
        eventType: 'host_role_released',
        reason: 'host_released',
        payload: { result },
      });
    }
    return result;
  });
}

// --- ROLE-ENGINE-ROUTING-001: generic-мост рассуждающих ролей на хостовые драйверы
//
// Рассуждающие роли (Приёмщик/Архитектор/Декомпозитор и пр.), назначенные в
// настройках внешнему движку ('codex' или 'claude_code'), исполняет соответствующий
// хостовый драйвер: оркестратор в Linux-контейнере не может запустить локальный
// `codex`/`claude` и не видит их подписки. Контракт ЕДИН для обоих движков (claim
// возвращает роль+готовый промпт+схему; драйвер «тупой»): меняется лишь локальный
// агент, который гоняет драйвер. LLM-вызов делается внешне, а ВЕСЬ разбор вердикта
// и переход остаются в оркестраторе (applyReasoningVerdict) — поведение ролей не
// меняется, заменяется только источник вердикта (DeepSeek-коннектор → Codex/Claude).

// GET /api/runner/next-reasoning-task?engine=codex|claude_code[&role=CODE] —
// захватить одну задачу роли, назначенной ЭТОМУ движку, и вернуть ГОТОВЫЙ промпт +
// JSON-схему вердикта. Раннер «тупой»: сборка промпта и схема остаются здесь.
// Возвращает { task: null }, если брать нечего или движок/роль не сходятся.
// INFRA-DEPARTMENT-001 — read-only список задач Инфраструктурного отдела (проекты
// pipeline_kind='infrastructure') с текущей ролью и этапом графа. Обслуживает
// MCP-инструмент статуса инфра-задач. projectRef — необязательный фильтр по коду/id
// проекта (внутри инфра-конвейера может быть несколько проектов).
export async function listInfraTasks(s, projectRef = null) {
  return withClient(clientConfig(s), async (c) => {
    const ref = String(projectRef ?? '').trim();
    const params = [];
    let projFilter = "p.pipeline_kind = 'infrastructure'";
    if (ref) {
      params.push(ref);
      projFilter += ` AND (p.code = $${params.length} OR p.id::text = $${params.length})`;
    }
    const r = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.priority::text AS priority,
              t.parent_task_id, t.created_at, t.updated_at, p.code AS project_code,
              cr.code AS current_role_code, cr.name AS current_role_name,
              ps.name AS current_stage_name, ps.kind AS current_stage_kind
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND ${projFilter}
         LEFT JOIN roles cr ON cr.id = t.current_role_id
         LEFT JOIN project_stages ps
           ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key
        ORDER BY t.created_at DESC
        LIMIT 200`,
      params,
    );
    return { tasks: r.rows };
  });
}

export async function claimNextReasoningTask(s, engineParam = null, roleParam = null) {
  const engine = String(engineParam ?? '').trim().toLowerCase();
  const role = String(roleParam ?? '').trim() || null;
  return withClient(clientConfig(s), async (c) => {
    if (!(await getOrchestratorEnabledTx(c))) return { task: null, paused: true };
    if (!EXTERNAL_ENGINES.has(engine)) return { task: null };
    const engines = await getRoleEngines(c);
    const mine = rolesForEngine(engines, engine);
    if (mine.length === 0) return { task: null };
    if (role && !mine.includes(role)) return { task: null };

    // claimLlmRoleTask делает свой BEGIN/COMMIT и создаёт agent_run RUNNING +
    // assigned_agent_id — захват защищён от внутреннего цикла и ловится реапером
    // (resetStaleClaims) по таймауту, если драйвер умрёт, не сдав результат.
    let claimed = null;
    const order = role ? [role] : mine;
    for (const rc of order) {
      claimed = await claimLlmRoleTask(c, rc);
      if (claimed) break;
    }
    if (!claimed) return { task: null };

    // Входной гейт полей (ROLE-FIELD-CONTRACT-001) — как в processClaimedRole:
    // нет обязательного входящего поля → BLOCKED, задачу Codex не отдаём.
    const contract = await loadRoleContract(c, claimed.role_code);
    const card = parseDataCard(claimed);
    const missingIn = missingRequiredInputs(card, contract.inputs);
    if (missingIn.length) {
      await blockClaimedForFields(c, claimed, missingIn);
      return { task: null, blocked: { taskId: claimed.id, reason: 'missing_required_inputs', fields: missingIn } };
    }

    const context = await buildRoleContext(c, claimed, { engine });
    const { composeRoleSystemPrompt, resolveRoleMaxTurns } = await import('./roles.js');
    const roleSystem = await composeRoleSystemPrompt(c, claimed.role_code);
    // ARCHITECT-TURN-CAP-001: персональный кап ходов роли (рунавей-гард). Драйвер
    // claude_code применит его вместо своего дефолта; codex maxTurns игнорирует.
    // ARCHITECT-BUDGET-SCALE-001: для Архитектора кап масштабируется размером эпика
    // (число сервисов/фронтов в описании + длина описания) — мега-эпику одного
    // фиксированного капа не хватает продумать разбивку за один прогон.
    const roleMaxTurns = resolveRoleMaxTurns(claimed.role_code, { description: claimed.description });
    // PROMPT-CACHE-001: для claude_code выносим СТАТИЧНУЮ часть (промт роли + карта) в
    // system-префикс — драйвер держит его в кэше (SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 5-мин
    // ephemeral), и повторные claim'ы того же проекта/роли не переоплачивают карту. У
    // codex/deepseek кэша нет: карта остаётся в user-payload как раньше (codex — short).
    const cacheClaude = engine === 'claude_code';
    const mapBlock = cacheClaude ? renderProjectMaps(context.projectMaps) : '';
    const systemPrompt = mapBlock ? `${roleSystem}\n\n${mapBlock}` : roleSystem;
    const userPrompt = buildUserPayload(claimed.role_code, context, contract.outputs, { includeMap: !cacheClaude });
    const outputSchema = buildVerdictJsonSchema(contract.outputs);

    return {
      task: {
        id: claimed.id,
        engine,
        role: claimed.role_code,
        title: claimed.title,
        projectId: claimed.project_id,
        project: context.project,
        // Реальный корень проекта: драйвер запускает агента с этим cwd, и тот сам
        // читает файлы (свой агентный tool-loop вместо tools-service).
        projectPath: context.projectPath,
        docsPath: context.docsPath,
        agentRunId: claimed.agentRunId,
        systemPrompt,
        userPrompt,
        // PROMPT-CACHE-001: claude-драйвер держит systemPrompt как кэшируемый статичный
        // префикс (роль+карта), а userPrompt шлёт как динамику. Для codex флаг игнорируется.
        cachePrefix: cacheClaude,
        // ARCHITECT-TURN-CAP-001: персональный кап ходов (null → драйвер возьмёт дефолт).
        maxTurns: roleMaxTurns,
        outputSchema,
      },
    };
  });
}

// POST /api/runner/reasoning-completed — принять вердикт от codex-runner и сделать
// переход тем же путём, что и внутренний DeepSeek (applyReasoningVerdict). Маршрутные
// данные перечитываем на сервере по taskId (раннеру не доверяем). Идемпотентно:
// если задача терминальна или RUNNING-прогона нет (реапер/повтор) — duplicate.
export async function completeReasoningTask(s, input) {
  return withClient(clientConfig(s), async (c) => {
    const result = await completeReasoningTaskTx(c, input);
    if (result?.taskId && !result.duplicate) {
      await exportLatestAgentRunObservation(c, result.taskId, {
        eventType: 'reasoning_role_completed',
        reason: result.reason || result.verdict || result.toStatus || 'reasoning_completed',
        payload: { result },
      });
    }
    return result;
  });
}

export async function completeReasoningTaskTx(c, input) {
  const taskId = String(input?.taskId ?? '').trim();
  if (!taskId) throw scannerError(422, 'taskId_required');

  const found = await c.query(
    `SELECT t.id, t.title, t.description, t.status::text AS status, t.project_id,
            t.data_card, t.current_stage_key,
            r.code AS role_code, r.id AS role_id,
            ar.id AS agent_run_id, ar.agent_id
       FROM tasks t
       LEFT JOIN roles r ON r.id = t.current_role_id
       LEFT JOIN agent_runs ar ON ar.task_id = t.id AND ar.status = 'RUNNING'
      WHERE t.id = $1`,
    [taskId],
  );
  if (!found.rowCount) throw scannerError(404, 'task_not_found');
  const row = found.rows[0];
  if (TERMINAL_TASK_STATUSES.has(row.status)) {
    return { accepted: true, duplicate: true, taskId, toStatus: row.status, nextRole: null };
  }
  // Нет RUNNING-прогона — захват уже снят/финализирован (реапер, двойная сдача).
  if (!row.agent_run_id) {
    return { accepted: true, duplicate: true, taskId, toStatus: row.status, nextRole: null };
  }
  const engines = await getRoleEngines(c);
  if (!EXTERNAL_ENGINES.has(engines[row.role_code])) throw scannerError(409, 'role_not_delegated_to_engine');

  // reworkCount — как в claimLlmRoleTask (сколько раз задача возвращалась с анализа).
  const rc = await c.query(
    `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND from_status = 'FAILURE_ANALYSIS'`,
    [taskId],
  );
  const claimed = {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    project_id: row.project_id,
    data_card: row.data_card,
    current_stage_key: row.current_stage_key,
    role_code: row.role_code,
    role_id: row.role_id,
    agentId: row.agent_id,
    agentRunId: row.agent_run_id,
    reworkCount: rc.rows[0].n,
  };

  // Вердикт: codex с --output-schema отдаёт валидный JSON-объект; принимаем либо
  // распарсенный объект (verdict), либо сырой текст (response, парсим толерантно).
  const text = typeof input?.response === 'string' && input.response.trim()
    ? input.response
    : (input?.verdict != null ? JSON.stringify(input.verdict) : '');
  const parsed = input?.verdict && typeof input.verdict === 'object' && !Array.isArray(input.verdict)
    ? input.verdict
    : parseVerdict(text);

  // Журнал обмена для UI «Промпты» (внешний движок без коннектора → connector_id
  // NULL). Необязателен — не валим сдачу, если запись не удалась.
  let exchangeId = null;
  try {
    const ins = await c.query(
      `INSERT INTO prompt_exchanges (connector_id, consumer_service, prompt, response, status, http_status, duration_ms, is_manual)
       VALUES (NULL, $1, $2, $3, 'завершен', NULL, $4, false) RETURNING id`,
      [
        `${engines[row.role_code]}:${row.role_code}`,
        String(input?.promptText ?? '').slice(0, 100000),
        text,
        Number.isFinite(Number(input?.durationMs)) ? Number(input.durationMs) : null,
      ],
    );
    exchangeId = ins.rows[0].id;
  } catch { /* журнал необязателен */ }

  // SILENT-FAIL-GUARD-001: вердикт не распознан. VERDICT-RETRY-001: сначала авто-повтор
  // прогона роли (задача освобождается — тот же внешний движок заберёт её снова), и
  // только после исчерпания лимита — терминальный FAILED (как DeepSeek-путь).
  if (parsed === null) {
    const outcome = await failRoleUnparsed(c, claimed, { response: text, exchangeId });
    if (outcome === null) {
      return { accepted: true, taskId, toStatus: null, reason: 'verdict_unparsed', retried: true };
    }
    return { accepted: true, taskId, toStatus: 'FAILED', reason: 'verdict_unparsed' };
  }

  const verdict = normalizeVerdict(row.role_code, parsed);
  const route = await loadProjectRoute(c, row.project_id);
  const contract = await loadRoleContract(c, row.role_code);
  const res = await applyReasoningVerdict(c, claimed, {
    route,
    contract,
    verdict,
    response: text,
    exchangeId,
    durationMs: Number.isFinite(Number(input?.durationMs)) ? Number(input.durationMs) : null,
    kpi: normalizeRunKpi(input),
  });
  return {
    accepted: true,
    duplicate: false,
    taskId,
    toStatus: res?.toStatus ?? null,
    nextRole: res?.nextRole ?? null,
    verdict: verdict.status,
  };
}

// POST /api/runner/release-reasoning-task — откат захвата (codex-runner не смог
// выполнить задачу): снять назначение, agent_run RUNNING → CANCELLED. Задача
// переигрывается штатно (тот же codex-мост заберёт её снова).
export async function releaseReasoningTask(s, taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw scannerError(422, 'taskId_required');
  return withClient(clientConfig(s), async (c) => {
    await c.query(
      `UPDATE agent_runs SET status = 'CANCELLED', finished_at = now() WHERE task_id = $1 AND status = 'RUNNING'`,
      [id],
    );
    const r = await c.query(
      `UPDATE tasks SET assigned_agent_id = NULL
        WHERE id = $1 AND assigned_agent_id IS NOT NULL AND status NOT IN ('DONE','CANCELLED') RETURNING id`,
      [id],
    );
    const result = { released: r.rowCount > 0, taskId: id };
    if (result.released) {
      await exportLatestAgentRunObservation(c, id, {
        eventType: 'reasoning_role_released',
        reason: 'reasoning_released',
        payload: { result },
      });
    }
    return result;
  });
}

// Пары (роль, статус) только для ИИ-ролей: их продвигает runner через вызов
// модели. PIPELINE_SERVICE/GIT_INTEGRATOR исключены — их ведёт host-мост.
const LLM_FLOW_PAIRS = LLM_ROLE_CODES.flatMap((code) =>
  ROLE_FLOW[code].from.map((status) => ({ code, status })),
);

// Захваченная под ролью задача, у которой ИИ-вызов завис, не должна держать
// слот вечно: по таймауту снимаем захват и помечаем прогон TIMEOUT.
//
// CONFIG-AUDIT-001: единый дефолт орфан-таймаута роли = 10 мин — совпадает с
// docker-compose (RUNNER_ROLE_TIMEOUT_MS:-600000) и .env. Прежде здесь было 15 мин,
// в compose — 3 мин, в .env — 10 мин: один параметр имел ТРИ разных дефолта, и
// эффективное значение зависело от способа запуска. КОНТРАКТ: должно быть БОЛЬШЕ
// hard-timeout раннеров (start-runners.ps1 = 540000 ≈ 9 мин), иначе реапер
// освобождает захват раньше раннера → agent_aborted по кругу. Парсинг через
// `Number(env) || default`, а НЕ `Number(env || default)`: мусорный env → дефолт,
// а не NaN (NaN-таймаут срабатывал бы мгновенно). См. CONFIG_AUDIT.md.
const DEFAULT_ROLE_TIMEOUT_MS = 10 * 60 * 1000;
const roleTimeoutCfg = resolveDuration('RUNNER_ROLE_TIMEOUT_MS', DEFAULT_ROLE_TIMEOUT_MS, { min: 30_000, max: 2 * 60 * 60_000 });
export const ROLE_TIMEOUT_MS = roleTimeoutCfg.value;

// Задача, выданная Claude (PROGRAMMER) через файловый мост, помечается
// assigned_agent_id, но НЕ создаёт agent_run RUNNING. Если completion от Claude
// не вернулся (сессия прервалась, Scanner был недоступен, слот очищен без
// доставки), задача навсегда зависает в CODING: фидер её не переподаёт (нужен
// assigned_agent_id IS NULL), а runner роль PROGRAMMER не ведёт. По таймауту
// освобождаем назначение — фидер переподаст её, как только слот освободится.
const claudeAssignCfg = resolveDuration('RUNNER_CLAUDE_TIMEOUT_MS', ROLE_TIMEOUT_MS, { min: 30_000, max: 2 * 60 * 60_000 });
export const CLAUDE_ASSIGN_TIMEOUT_MS = claudeAssignCfg.value;

// HOST-ORPHAN-TIMEOUT-001: host-роли (PIPELINE_SERVICE из TESTING, GIT_INTEGRATOR
// из COMMIT) при claim через /api/runner/next-host-task создают agent_run RUNNING
// (claimNextHostTask). Если host-runner умирает посреди работы (docker compose build
// в PIPELINE_SERVICE, коммит в GIT_INTEGRATOR), release-host-task не приходит и прогон
// висит RUNNING, держа слот роли и назначение (AGENT_ASSIGNED) навсегда. Формально их
// реапят resetStaleClaims/reapOrphanRunningRuns, но по ОБЩЕМУ ROLE_TIMEOUT_MS (10 мин),
// который короче длинной docker-сборки → живой прогон срезался бы посреди build (тот же
// класс инцидента, что 10-минутный срез PROGRAMMER). Даём host-ролям ОТДЕЛЬНЫЙ больший
// таймаут: дефолт 40 мин — с запасом над самой долгой ожидаемой сборкой, но не
// бесконечность. КОНТРАКТ (CONFIG-AUDIT-001): дефолт совпадает в db.js/compose/.env и
// БОЛЬШЕ ROLE_TIMEOUT_MS. См. CONFIG_AUDIT.md.
const DEFAULT_HOST_TIMEOUT_MS = 40 * 60 * 1000;
const hostTimeoutCfg = resolveDuration('RUNNER_HOST_TIMEOUT_MS', DEFAULT_HOST_TIMEOUT_MS, { min: 60_000, max: 4 * 60 * 60_000 });
export const HOST_TIMEOUT_MS = hostTimeoutCfg.value;
// Коды host-ролей для ветвления таймаута/события в жнецах (из единого HOST_ROLES).
export const HOST_ROLE_CODES = Object.keys(HOST_ROLES);

// DOC-BRANCH-LIVENESS-001: максимальный возраст «зависания» документационной
// fork-ветви, после которого она принудительно продвигается к join (чтобы не
// держать родителя, даже если движок документации вообще не создаёт прогонов —
// напр. codex-драйвер завис/недоступен, bad_runs не растёт). Документация вправе
// идти ДОЛЬШЕ коммита (дефолт 1 час — щедро), но не бесконечно.
const docBranchAgeCfg = resolveDuration('RUNNER_DOC_BRANCH_MAX_AGE_MS', 60 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 });
export const DOC_BRANCH_MAX_AGE_MS = docBranchAgeCfg.value;

// GI-RESYNC-RETRY-001 — однократный авто-ретрай задач, заблокированных Git
// Integrator'ом git-причиной (cherry_pick_failed/stale_branch_reverts_main/…), для
// ресинка статуса с реальным main. Контент дельты часто уже в main (ветка пересажена
// на свежий main — WORKTREE-REBASE-STALE-001; сиблинг/ручная доставка влили его), и
// повторный прогон GI разрулит задачу (already_integrated_content). Grace — сколько
// ждать после блокировки перед ретраем. Клапан: GI_RESYNC_RETRY=0/false/off.
export const GI_RESYNC_RETRY_ENABLED = !/^(0|false|off)$/i.test(String(process.env.GI_RESYNC_RETRY ?? '').trim());
const giResyncGraceCfg = resolveDuration('GI_RESYNC_RETRY_GRACE_MS', 10 * 60_000, { min: 60_000, max: 6 * 60 * 60_000 });
export const GI_RESYNC_GRACE_MS = giResyncGraceCfg.value;
// Git-причины блока GI, которые повторный прогон способен разрулить (контент мог
// уже долететь в main). Orchestration-причины (next_role_missing и т.п.) сюда НЕ входят.
export const GI_RESYNC_NOTES = [
  'cherry_pick_failed', 'stale_branch_reverts_main', 'empty_deliverable_declared_changes',
  'autodeploy_failed', 'dirty_worktree_conflict',
];

// CONFIG-AUDIT-001: стартовый лог эффективных орфан-таймаутов с атрибуцией
// источника (env|default) — чтобы по логу было видно, что реально применилось.
logEffectiveConfig('orchestrator timeouts', [roleTimeoutCfg, claudeAssignCfg, hostTimeoutCfg]);

// PROGRAMMER-RELEASE-BACKOFF-001 — расписание backoff/cooldown на повторный захват
// одной задачи программистом после подряд идущих неудачных release и порог K для
// предохранителя от вечной петли (инцидент 03.07.2026, PRINT-054: 1407 бесполезных
// прогонов за 2 часа, стадия CODING заблокирована для остальных задач). Дефолт —
// 30с → 2мин → 10мин (потолок на хвосте) и K=5 подряд провалов. Оба параметра
// переопределяемы через env (рядом с CLAUDE_ASSIGN_TIMEOUT_MS для обозримости).
const DEFAULT_PROGRAMMER_RELEASE_BACKOFF_MS = [30_000, 120_000, 600_000];

// Разбор расписания backoff из env: CSV длительностей ("30s,2m,10m" или
// "30000,120000,600000"). Пусто/мусор целиком → дефолт; невалидные/непозитивные
// элементы отбрасываются, пустой результат → дефолт. Чистая функция (юнит-тест).
export function parseBackoffScheduleMs(raw, dflt = DEFAULT_PROGRAMMER_RELEASE_BACKOFF_MS) {
  if (raw == null || String(raw).trim() === '') return [...dflt];
  const vals = String(raw)
    .split(',')
    .map((p) => parseDurationMs(p))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n));
  return vals.length ? vals : [...dflt];
}

const PROGRAMMER_RELEASE_BACKOFF_MS = parseBackoffScheduleMs(
  process.env.PROGRAMMER_RELEASE_BACKOFF_MS_SCHEDULE,
);
const programmerLoopMaxCfg = resolveInt('PROGRAMMER_RELEASE_LOOP_MAX', 5, { min: 1, max: 1000 });
export const PROGRAMMER_RELEASE_LOOP_MAX = programmerLoopMaxCfg.value;
// PROGRAMMER-MODEL-ROUTING-001: модель программиста по сложности задачи. Мелкая
// подзадача-на-файл декомпозиции (task_kind='subtask') — точечная правка: дефолт
// Sonnet (быстрее и дешевле Opus, без потери качества на узкой задаче). Цельная
// задача-на-сервис (task_kind='service', в т.ч. legacy-одиночки) — шире по контексту:
// дефолт Opus. Раньше ВСЕ CODING шли на Opus (дефолт агента/раннера) — избыточно для
// мелочи. Имена моделей переопределяемы через env (сменить поколение без правки кода).
// Явно назначенный роли Claude-коннектор (role_connectors) ПЕРЕБИВАЕТ роутинг — это
// осознанный выбор оператора «одна модель на всё» (см. claimNextClaudeTaskTx).
// ARCHITECT-BUDGET-LOOP-001: сколько подряд CANCELLED/TIMEOUT-прогонов Архитектора
// (мега-эпик не влезает в бюджет одного прогона) уводят задачу в BLOCKED С ПРИЧИНОЙ.
// Дефолт 3 — по инциденту («три CANCELLED подряд по таймауту»). Настройка.
const architectBudgetLoopMaxCfg = resolveInt('ARCHITECT_BUDGET_LOOP_MAX', 3, { min: 1, max: 100 });
export const ARCHITECT_BUDGET_LOOP_MAX = architectBudgetLoopMaxCfg.value;
// Человекочитаемая причина блока (кладём и в карточку задачи, и в событие).
export const ARCHITECT_BUDGET_BLOCK_REASON = 'Архитектор не уложился в бюджет: несколько прогонов подряд отменены по таймауту рассуждения — задача слишком крупная. Разбейте эпик на пакеты по 4–5 сервисов/фронтов и верните в ARCHITECTURE, либо увеличьте бюджет ходов/времени Архитектора.';
// TASK-RUN-LOOP-CAP-001: общий предохранитель для ЛЮБОЙ роли — K подряд
// CANCELLED/TIMEOUT-прогонов этапа → BLOCKED с причиной («пуск руками»). Порог выше
// архитекторского (узкие жнецы срабатывают раньше со своим диагнозом). Настройка.
const taskRunLoopMaxCfg = resolveInt('TASK_RUN_LOOP_MAX', 5, { min: 1, max: 1000 });
export const TASK_RUN_LOOP_MAX = taskRunLoopMaxCfg.value;
export const TASK_RUN_LOOP_BLOCK_REASON = 'Автоматика остановлена: несколько прогонов этапа подряд оборваны без результата (таймаут/отмена) — задача перезапускалась по кругу и жгла токены. Разберите причину (лог прогонов этапа, бюджет времени роли) и запустите вручную: переместите задачу на нужный этап.';
logEffectiveConfig('programmer release loop', [programmerLoopMaxCfg]);
logEffectiveConfig('architect budget loop', [architectBudgetLoopMaxCfg]);
logEffectiveConfig('task run loop cap', [taskRunLoopMaxCfg]);
console.log(`programmer release backoff schedule (ms)=${JSON.stringify(PROGRAMMER_RELEASE_BACKOFF_MS)}`);


/**
 * Stage 3: один шаг фонового runner. Для каждой ИИ-роли:
 *   1) claim задачи в отдельной транзакции (FOR UPDATE SKIP LOCKED + пометка
 *      assigned_agent_id и agent_run RUNNING) — слот занят, повторно не возьмут;
 *   2) вызов модели ВНЕ транзакции (роль «думает»), журнал в prompt_exchanges;
 *   3) финализация в новой транзакции: переход по вердикту, agent_run, событие,
 *      для ревью — запись в reviews.
 * Сетевой вызов держим вне транзакции, чтобы не блокировать строки на минуты.
 * Возвращает массив применённых шагов.
 */
export async function advanceAutomatedTasks(s, opts = {}) {
  if (opts.orchestratorEnabled === false) return [];
  if (opts.orchestratorEnabled === undefined && !(await getOrchestratorEnabled(s))) return [];

  // RUNNER-CONCURRENCY-001: лимит «горутин на роль» берём из app_settings (UI),
  // переопределение через opts — для тестов. Минимум 1.
  const cap = Math.max(
    1,
    Number(opts.maxConcurrencyPerRole ?? (await getMaxConcurrencyPerRole(s))) || 1,
  );

  // Предшаги (реконсиляция, пропуск ролей, fork/join) — быстрые, на одном клиенте.
  // Здесь же планируем, сколько свободных слотов осталось по каждой роли.
  const slots = await withClient(clientConfig(s), async (c) => {
    await resetStaleClaims(c);
    // RUNNER-RUNTIME-REAP-001: помимо просроченных захватов, на каждом тике гасим
    // осиротевшие RUNNING-прогоны рассуждающих ролей старше таймаута. Свежие сироты
    // возникают в рантайме при обрыве соединения с БД (pgbouncer/Patroni) — их
    // финализация рвётся, и они держат слот роли до 30-минутного таймаута, заклинивая
    // очередь. ageCheck=true: возраст проверяется по RUNNER_ROLE_TIMEOUT_MS с
    // clockGuard, поэтому реально идущие прогоны не гасятся раньше срока.
    await reapOrphanRunningRuns(c, { ageCheck: true });
    // ORPHAN-ROLE-REATTACH-001: самоисцеление осиротевших по роли задач. Активная
    // задача без current_role_id НЕВИДИМА для claim (claimLlmRoleTask/claimHostTask
    // делают INNER JOIN roles по current_role_id) и висит вечно. Так получается после
    // массовых ручных операций (напр. bulk_unblock_refeed выставил статус, но не роль).
    // Восстанавливаем роль из этапов проекта ДО claim, чтобы задача поехала тем же тиком.
    await reattachOrphanStageRoles(c);
    await reattachBlockedOwnerRoles(c);
    await closeBlockedDuplicateTasks(c);
    // TESTS-GREEN-SKIP-FA-001 (fix B): разорвать бесконечный self-loop аналитика
    // сбоя. Прогон FAILURE_ANALYST на слабой модели может раз за разом упираться в
    // таймаут роли — resetStaleClaims возвращает задачу в тот же FAILURE_ANALYSIS, и
    // она переигрывается вечно, занимая слот. Задачу с РЕАЛЬНЫМ провалом тестов, у
    // которой накопилось >= MAX_REWORK безрезультатных прогонов аналитика, уводим в
    // BLOCKED (на человека). Зелёные задачи сюда не попадают — их раньше пропускает
    // maybeSkipFailureAnalyst (forward), поэтому здесь явно требуем провала пайплайна.
    await blockExhaustedFailureAnalysis(c);
    // PROGRAMMER-RELEASE-BACKOFF-001: предохранитель от вечной петли захвата одной
    // задачи программистом. После K подряд неуспешных PROGRAMMER-прогонов уводим
    // CODING-задачу в BLOCKED (см. escalateProgrammerReleaseLoop) — cooldown в
    // claimNextClaudeTask лишь тормозит захват, а этот свипер разрывает петлю, чтобы
    // задача не молотила часами и не держала единственный слот программиста.
    await escalateProgrammerReleaseLoop(c);
    // ARCHITECT-BUDGET-LOOP-001: Архитектор, K раз подряд отменённый/просроченный по
    // reasoning-таймауту на мега-эпике, уводится в BLOCKED С ВНЯТНОЙ ПРИЧИНОЙ (в
    // карточке и событии), а не молча — чтобы человек видел «задача слишком крупная,
    // разбейте на пакеты или увеличьте бюджет», а не пустой блок без диагноза.
    await escalateArchitectBudgetLoop(c);
    // TASK-RUN-LOOP-CAP-001: общий предохранитель — ЛЮБАЯ роль, K раз подряд
    // оборванная без вердикта (CANCELLED/TIMEOUT), останавливается в BLOCKED с
    // причиной в карточке; дальше пуск руками (move на этап после разбора).
    await escalateRunawayRoleLoops(c);
    // DOC-BRANCH-LIVENESS-001: документационная fork-ветвь не должна заклинивать
    // родителя на join. Мёртвую ветку документации (BLOCKED/FAILED/исчерпание попыток)
    // продвигаем на узел вперёд к join ДО снятия join-барьера, чтобы родитель поехал.
    await advanceStuckDocumentationBranches(c);
    // GI-RESYNC-RETRY-001: ресинк статуса с реальным main. Однократно возвращаем на
    // COMMIT задачи, заблокированные Git Integrator'ом git-причиной (контент часто уже
    // в main после WORKTREE-REBASE-STALE-001 / сиблинг-доставки), и переоткрываем их
    // child-driven заблокированных предков — GI и join/rollup доведут их сами.
    await retryGiBlockedForResync(c);
    // Пропускаемые роли (ROLE-GROUPS-001 / per-project) прокручиваются до первой
    // активной роли ДО любого claim — за пропущенные роли не создаётся agent/host run.
    await advanceSkippedStageRoles(c);
    // FORK-JOIN-001: расщепление в fork и снятие барьера в join — до claim, чтобы
    // дети попадали в очередь, а родитель не клеймился на gate-узле.
    await advanceForkNodes(c);
    await advanceJoinNodes(c);
    // WORK-STACK-001: очередь работ Архитектор→Программист. Reconcile промоутнутых
    // (терминальная дочерняя задача → терминальный элемент, снимаем замок сервиса) +
    // promote следующего PENDING-элемента на каждый свободный микросервис (заводит
    // дочернюю CODING-задачу). ДО роллапа — чтобы свежесозданные дети и освободившиеся
    // сервисы учитывались тем же тиком.
    await advanceWorkStack(c);
    // DECOMP-CONTRACT-001: эпик, у которого все задачи-на-сервис стали терминальны,
    // завершается (DONE) или блокируется (BLOCKED, если сервис упал). Линейный
    // аналог снятия join-барьера для декомпозиции по микросервисам.
    await advanceDecompositionParents(c);
    // TASK-AUTO-ACCEPT-001: авто-приёмка DONE по умолчанию ВЫКЛЮЧЕНА. Оба дефолта
    // (readAppSetting fallback и parseBoolSetting fallback) — false: при отсутствии
    // ключа 'auto_accept_done' гейт закрыт, autoAcceptDoneTasks НЕ вызывается, и свежие
    // DONE остаются в подразделе «Проверка» до ручного «Принять». Если авто-приёмку
    // включили в UI, помечаем свежие DONE принятыми в том же тике — задача сразу в
    // «Выполнено». Делаем ПОСЛЕ шагов, приводящих к DONE (join/rollup), чтобы не ждать
    // следующего тика.
    if (parseBoolSetting(await readAppSetting(c, 'auto_accept_done', false), false)) {
      await autoAcceptDoneTasks(c);
    }
    // ROLE-ENGINE-ROUTING-001: роли, делегированные внешнему движку (codex/
    // claude_code), внутренний DeepSeek-цикл НЕ исполняет — их захватывает
    // соответствующий хостовый драйвер через /api/runner/next-reasoning-task.
    // Иначе движки конкурировали бы за одни и те же задачи.
    const external = new Set(externalRoles(await getRoleEngines(c)));
    const internalRoles = LLM_ROLE_CODES.filter((r) => !external.has(r));
    return computeRoleFreeSlots(c, cap, internalRoles);
  });

  // ORCH-BOOT-CLAIM-GRACE-001 (проактивная часть): если недавно ловили обрыв
  // соединения с БД, придерживаем НОВЫЕ claim'ы на короткое окно. Предшаги выше
  // (реконсиляция часов, реап осиротевших RUNNING, fork/join) уже отработали и
  // расчищают залипшие прогоны — а новые claim'ы во время нестабильной БД только
  // плодили бы новых сирот (claim прошёл, финализация порвалась). opts.now —
  // монотонные мс (undefined в проде → текущее, заданное число — в тестах).
  if (claimGraceActive(opts.now)) return [];

  // По одному воркеру на каждый свободный слот роли. Каждый claim+process идёт в
  // СВОЁМ соединении и транзакции — задачи разных (и одной) ролей обрабатываются
  // параллельно. Двойной захват исключён FOR UPDATE SKIP LOCKED в claimLlmRoleTask.
  const jobs = [];
  for (const [roleCode, free] of slots) {
    for (let i = 0; i < free; i += 1) jobs.push(roleCode);
  }
  // DB-FINALIZE-RETRY-001: конфиг БД пробрасываем в processClaimedRole, чтобы ретрай
  // финализации мог открыть СВЕЖЕЕ соединение (withClient(cfg)), когда claim-соединение
  // порвалось. Один снимок конфига на тик — read-only данные, безопасно шарить.
  const cfg = clientConfig(s);
  const results = await Promise.all(
    jobs.map((roleCode) =>
      withClient(cfg, async (c) => {
        const claimed = await claimLlmRoleTask(c, roleCode);
        if (!claimed) return null;
        return processClaimedRole(c, claimed, cfg);
      }).catch((error) => {
        // ORCH-BOOT-CLAIM-GRACE-001 (реактивная часть): обрыв СОЕДИНЕНИЯ именно в
        // claim/process — главный источник осиротевших RUNNING-прогонов (claim
        // создан, но финализация порвалась). Фиксируем шторм, чтобы ближайшие тики
        // придержали новые claim'ы, пока БД не стабилизируется, и не плодили новых
        // сирот.
        if (isDbConnectionError(error)) noteDbConnectionFailure(opts.now);
        // DB-FINALIZE-RETRY-001: НЕ глушим ошибку молча. Пост-LLM запись уже прошла
        // ограниченный ретрай на свежем соединении (см. finalizeWithConnRetry); если
        // и он исчерпан — логируем явно. Прогон остаётся RUNNING и будет подобран
        // per-tick сбросом (reapOrphanRunningRuns/resetStaleClaims по таймауту роли).
        // Возврат null не роняет тик — прочие слоты и предшаги продолжают работать.
        log.error('прогон роли: claim/финализация не завершена; оставлен под per-tick сброс', {
          event_code: 'DB_QUERY_FAILED', operation: 'role.finalize',
          error_code: isDbConnectionError(error) ? 'DB_UNAVAILABLE' : 'INTERNAL_ERROR',
          attributes: { roleCode }, err: error,
        });
        return null;
      }),
    ),
  );
  return results.filter(Boolean);
}

// RUNNER-CONCURRENCY-001: сколько новых воркеров запускать по каждой ИИ-роли в
// этом тике. free = min(ожидающие задачи, cap − уже в работе). Считаем по всем
// видимым ролям активных проектов одним запросом; роли без ожидающих опускаем.
async function computeRoleFreeSlots(c, cap, roleCodes = LLM_ROLE_CODES) {
  if (!roleCodes || roleCodes.length === 0) return new Map();
  const r = await c.query(
    `SELECT r.code AS role_code,
            count(*) FILTER (WHERE t.assigned_agent_id IS NOT NULL)::int AS inflight,
            count(*) FILTER (WHERE t.assigned_agent_id IS NULL)::int AS pending
       FROM roles r
       JOIN tasks t ON t.current_role_id = r.id
       JOIN projects p ON p.id = t.project_id
      WHERE r.code = ANY($1::text[])
        AND r.hidden = false
        AND p.status <> 'paused'
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT')
      GROUP BY r.code`,
    [roleCodes],
  );
  const slots = new Map();
  for (const row of r.rows) {
    const free = Math.min(row.pending, Math.max(0, cap - row.inflight));
    if (free > 0) slots.set(row.role_code, free);
  }
  return slots;
}

// Низкоуровневое чтение app_settings (рантайм-конфиг). Таблицы может ещё не быть
// (миграция не накатана) — тогда отдаём fallback, не роняя runner.
export async function readAppSetting(c, key, fallback) {
  try {
    const r = await c.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

export function parseBoolSetting(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

async function getOrchestratorEnabledTx(c) {
  return parseBoolSetting(await readAppSetting(c, 'orchestrator_enabled', true), true);
}

export const getOrchestratorEnabled = publicTx(getOrchestratorEnabledTx);

// Лимит параллельных обработок на роль (app_settings.max_concurrency_per_role).
export async function getMaxConcurrencyPerRole(s) {
  return withClient(clientConfig(s), async (c) => {
    const v = await readAppSetting(c, 'max_concurrency_per_role', 3);
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : 3;
  });
}

// ROLE-ENGINE-ROUTING-001: карта «рассуждающая роль → движок».
//
// ИСТОЧНИК ИСТИНЫ — назначения «роль → интеграция (коннектор)» (role_connectors):
// движок роли = тип провайдера назначенного ВКЛЮЧЁННОГО коннектора. Это и есть
// объединение бывших полей «Интеграция (коннектор)» и «Движок» в одно — выбор
// интеграции в карточке роли определяет исполнителя:
//   provider codex/claude_code → хостовый драйвер (внешний движок);
//   deepseek/openai/прочее     → внутренний DeepSeek-цикл оркестратора.
const EXTERNAL_ENGINES = new Set(['codex', 'claude_code']);

// Тип провайдера коннектора → движок исполнения роли. Должен совпадать с
// frontend roleEngines.ts (providerToEngine).
function providerToEngine(provider) {
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'codex' || p === 'claude_code') return p;
  return 'deepseek';
}

async function getRoleEngines(c) {
  const allowed = new Set(LLM_ROLE_CODES);

  // Источник истины — role_connectors: движок роли = тип провайдера её назначенного
  // ВКЛЮЧЁННОГО коннектора. Выключенная интеграция = «не делегируем» (и в UI она не
  // показывается в списке движков).
  const assigned = new Map();
  const rc = await c.query(
    `SELECT rc.role_code, cn.provider
       FROM role_connectors rc
       JOIN connectors cn ON cn.id = rc.connector_id
      WHERE cn.is_enabled = true`,
  );
  for (const row of rc.rows) {
    const role = String(row.role_code).trim().toUpperCase();
    if (allowed.has(role)) assigned.set(role, providerToEngine(row.provider));
  }

  // Отдаём только внешние делегирования (codex/claude_code) — внутренний движок
  // (deepseek) есть дефолт и в карте не хранится, его консьюмеры трактуют как «не
  // внешний».
  const out = {};
  for (const role of allowed) {
    const engine = assigned.get(role);
    if (engine === 'codex' || engine === 'claude_code') out[role] = engine;
  }
  return out;
}

// Роли, делегированные ВНЕШНЕМУ движку (codex/claude_code): их не исполняет
// внутренний DeepSeek-цикл, а захватывает соответствующий хостовый драйвер.
function externalRoles(engines) {
  return Object.entries(engines).filter(([, e]) => EXTERNAL_ENGINES.has(e)).map(([r]) => r);
}

// Роли, назначенные конкретному внешнему движку (для claim хостовым драйвером).
function rolesForEngine(engines, engine) {
  return Object.entries(engines).filter(([, e]) => e === engine).map(([r]) => r);
}

/**
 * Пропуск скрытых ролей (ROLE-CONFIGURATION-001): задачи, чья текущая роль
 * помечена hidden, переводятся к первой следующей активной роли без вызова
 * исполнителя. Работает для одной и нескольких скрытых ролей подряд и для
 * пропущенной последней роли маршрута (задача штатно достигает DONE). Не трогает
 * задачи в работе (assigned_agent_id) и терминальные. Идемпотентно по тикам.
 * Возвращает число продвинутых задач.
 *
 * Per-project (ROLE-GROUPS-001): роль пропускается, если назначена на ОТКЛЮЧЁННЫЙ
 * этап проекта (project_stages.enabled = false) и не встречается ни на одном
 * включённом этапе того же проекта. Глобального скрытия (roles.hidden) больше нет
 * — пропуск настраивается отдельно для каждого проекта в «Этапы пайплайна».
 */
async function advanceSkippedStageRoles(c) {
  // Набор пропускаемых кодов ролей по проектам: роль в отключённом этапе и НЕ в
  // одном включённом этапе того же проекта (иначе она остаётся активной).
  const skippedRows = await c.query(
    `SELECT ps.project_id, r.code
       FROM project_stages ps
       JOIN project_stage_roles psr ON psr.stage_id = ps.id
       JOIN roles r ON r.id = psr.role_id
      GROUP BY ps.project_id, r.code
     HAVING bool_or(NOT ps.enabled) AND NOT bool_or(ps.enabled)`,
  );
  if (!skippedRows.rowCount) return 0;
  const byProject = new Map();
  for (const row of skippedRows.rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, new Set());
    byProject.get(row.project_id).add(row.code);
  }

  const tasks = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id, t.project_id, r.code AS role_code
       FROM tasks t JOIN roles r ON r.id = t.current_role_id
      WHERE t.project_id = ANY($1::uuid[])
        AND t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','WAITING_FOR_CHILDREN','NEEDS_INPUT')`,
    [[...byProject.keys()]],
  );

  let moved = 0;
  for (const t of tasks.rows) {
    const skipped = byProject.get(t.project_id);
    if (!skipped || !skipped.has(t.role_code)) continue;
    // PIPELINE-DYNAMIC-ROUTE-001: прокручиваем через маршрут проекта — forwardFrom
    // возвращает первую ВКЛЮЧЁННУЮ роль после текущей (пропуская отключённые этапы).
    const route = await loadProjectRoute(c, t.project_id);
    const fwd = forwardFrom(route, t.role_code);
    if (fwd === undefined) continue; // роли нет в маршруте — не трогаем
    const done = fwd === null;
    const toStatus = done ? 'DONE' : fwd.status;
    const nextRoleCode = done ? null : fwd.roleCode;
    const nextRoleId = !nextRoleCode
      ? null
      : await roleIdByCode(c, nextRoleCode);
    const updated = await withTransaction(c, async () => {
      const upd = await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3
          WHERE id = $1 AND assigned_agent_id IS NULL AND status NOT IN ('DONE','CANCELLED')`,
        [t.id, toStatus, nextRoleId],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
          [
            t.id,
            done ? 'TASK_DONE' : 'STATUS_CHANGED',
            t.status,
            toStatus,
            t.current_role_id,
            JSON.stringify({
              runner: true,
              reason: 'skipped_disabled_stage_role',
              skippedRole: t.role_code,
              nextRole: nextRoleCode,
            }),
          ],
        );
      }
      return upd.rowCount > 0;
    });
    if (updated) moved += 1;
  }
  return moved;
}

/**
 * FORK-JOIN-001 (Phase 5) — узел join. Двухшаговый подметатель:
 *  (1) дочерняя задача, доехавшая до узла kind='join', завершается (ветка сдала
 *      результат) → DONE;
 *  (2) родитель в WAITING_FOR_CHILDREN на узле join, у которого ВСЕ дети
 *      терминальны: при упавшей ветке → BLOCKED; иначе слить data_card детей и
 *      продвинуть родителя за join по рёбрам (нет рёбер → DONE).
 * Идемпотентно (предикаты статуса + SKIP LOCKED). Только UPDATE, без DELETE.
 */
export async function advanceJoinNodes(c) {
  let advanced = 0;
  // (1) Дети на join → DONE. FORK-CHILD-001: WAITING_FOR_CHILDREN исключён — это
  // ребёнок, сам ставший fork-родителем и припаркованный на join; его завершает
  // шаг (2), когда его собственные ветки станут терминальными.
  const kids = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.parent_task_id IS NOT NULL
        AND t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT')
      FOR UPDATE OF t SKIP LOCKED`,
  );
  for (const k of kids.rows) {
    const updated = await withTransaction(c, async () => {
      const upd = await c.query(
        `UPDATE tasks SET status = 'DONE', current_role_id = NULL, assigned_agent_id = NULL
          WHERE id = $1 AND status NOT IN ('DONE','CANCELLED','FAILED')`,
        [k.id],
      );
      if (upd.rowCount) {
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'TASK_DONE', $2::task_status, 'DONE', $3, $4::jsonb)`,
          [k.id, k.status, k.current_role_id, JSON.stringify({ runner: true, reason: 'branch_reached_join' })],
        );
      }
      return upd.rowCount > 0;
    });
    if (updated) advanced += 1;
  }

  // (2) Fork-родители на join со всеми терминальными детьми → снять барьер.
  // FORK-CHILD-001: без фильтра parent_task_id — припаркованный на join может быть
  // и сервисным ребёнком эпика, ставшим fork-родителем своих веток.
  const parents = await c.query(
    `SELECT t.id, t.project_id, t.status::text AS status, t.current_role_id, t.current_stage_key, t.data_card
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'join'
      WHERE t.status = 'WAITING_FOR_CHILDREN'
        AND t.assigned_agent_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id)
        AND NOT EXISTS (
              SELECT 1 FROM tasks ch
               WHERE ch.parent_task_id = t.id AND ch.status NOT IN ('DONE','CANCELLED','FAILED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  for (const p of parents.rows) {
    const childRows = await c.query(
      `SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id = $1`,
      [p.id],
    );
    const failed = childRows.rows.some((ch) => ch.status === 'FAILED' || ch.status === 'CANCELLED');
    const advancedParent = await withTransaction(c, async () => {
      if (failed) {
        // Политика all-DONE-required: упавшая ветка → родитель BLOCKED (всплывает пользователю).
        await c.query(
          `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1`,
          [p.id],
        );
        await c.query(
          `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
           VALUES ($1, 'STATUS_CHANGED', 'WAITING_FOR_CHILDREN', 'BLOCKED', $2, $3::jsonb)`,
          [p.id, p.current_role_id, JSON.stringify({ runner: true, reason: 'join_child_failed' })],
        );
        return true;
      }
      // Слить карточки детей в родителя (накопительная карточка).
      let merged = { ...parseDataCard(p) };
      for (const ch of childRows.rows) {
        merged = { ...merged, ...parseDataCard(ch) };
      }
      // DOC-COMMIT-ON-JOIN-001: агрегируем changedFiles детей (правки Doc Keeper лежат
      // на СОСЕДНЕЙ ветке — их нет в цепочке предков родителя, поэтому
      // resolveHostTaskContext их не видит) в ОБЪЕДИНЕНИЕ с дедупом и выносим их
      // ВЕРХНИМ уровнем в событие продвижения родителя. resolveHostTaskContext берёт
      // непустые changedFiles по событиям цепочки → пост-join Git Integrator (роль
      // узла ЗА join, работает на РОДИТЕЛЕ) увидит doc-пути и закоммитит их отдельным
      // коммитом. Пустой список (Doc Auditor→NO_CHANGES: доки не редактировались) →
      // поля в событии нет → пост-join Git Integrator упрётся в уже закоммиченный код
      // (nothing_to_stage), второго коммита не будет — поведение как сейчас.
      const childChanged = [];
      const seenChanged = new Set();
      for (const ch of childRows.rows) {
        const files = ch.data_card && Array.isArray(ch.data_card.changedFiles) ? ch.data_card.changedFiles : [];
        for (const f of files) {
          const key = String(f);
          if (!key || seenChanged.has(key)) continue;
          seenChanged.add(key);
          childChanged.push(f);
        }
      }
      // Продвинуть родителя за join по рёбрам графа.
      const loaded = await loadProjectGraph(c, p.project_id);
      const nextKey = loaded ? nextNodeKey(loaded.graph, p.current_stage_key, { outcome: 'FORWARD' }) : null;
      const nextNode = nextKey ? nodeByKey(loaded.graph, nextKey) : null;
      const done = !nextNode;
      const nextRoleId = nextNode?.roleId ?? null;
      const toStatus = done ? 'DONE' : (nextNode.status || p.status);
      await c.query(
        `UPDATE tasks SET status = $2::task_status, current_role_id = $3,
                current_stage_key = $4::uuid, assigned_agent_id = NULL,
                data_card = data_card || $5::jsonb WHERE id = $1`,
        [p.id, toStatus, nextRoleId, nextKey, JSON.stringify(merged)],
      );
      const joinPayload = { runner: true, reason: 'join_completed', nextStageKey: nextKey };
      if (childChanged.length) joinPayload.changedFiles = childChanged;
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, done ? 'TASK_DONE' : 'STATUS_CHANGED', toStatus, p.current_role_id,
         JSON.stringify(joinPayload)],
      );
      return true;
    });
    if (advancedParent) advanced += 1;
  }
  return advanced;
}


// Захватить одну задачу под ИИ-ролью. Возвращает контекст захвата или null.
// PIPELINE-DYNAMIC-ROUTE-001: статус, в котором роль легитимно владеет задачей,
// берём из этапов проекта (project_stages.task_status у включённого этапа с этой
// ролью). Если у проекта нет настроенного маршрута — канонический фолбэк по
// LLM_FLOW_PAIRS (ROLE_FLOW.from). Проекты на паузе (status='paused') пропускаем.
async function claimLlmRoleTask(c, roleCode = null) {
  // Пары канонического фолбэка начинаются с $2 ($1 = массив кодов ИИ-ролей).
  const valuesSql = LLM_FLOW_PAIRS.map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::text)`).join(', ');
  const params = [LLM_ROLE_CODES, ...LLM_FLOW_PAIRS.flatMap((p) => [p.code, p.status])];
  // RUNNER-CONCURRENCY-001: при параллельной обработке claim сужают до одной роли,
  // чтобы соблюсти лимит «N горутин на роль» — каждый воркер берёт задачу своей роли.
  let roleFilter = '';
  if (roleCode) {
    params.push(roleCode);
    roleFilter = `AND r.code = $${params.length}`;
  }
  // DOCROLES-GI-SERIALIZE-001: сериализуем doc-ветвь ПОСЛЕ git-ветви одной fork-группы
  // сервиса. Documentation Auditor/Keeper (DOC_BRANCH_ROLE_CODES) и fork-ребёнок Git
  // Integrator делят ОДНО рабочее дерево repoRoot; doc-роли пишут README.md/docs/*.md
  // в это дерево, а GI вливает дельту Программиста cherry-pick'ом. Если doc-роль пишет
  // тот же файл, что есть в дельте Программиста, ОДНОВРЕМЕННО с GI — дерево «грязное»
  // чужой незакоммиченной правкой, GI КОРРЕКТНО отказывается её затирать
  // (dirty_worktree_conflict) → задача в BLOCKED. Придерживаем claim doc-роли, пока
  // git-сиблинг той же fork-группы (та же parent_task_id) НЕтерминален и стоит на
  // GIT_INTEGRATOR: GI отработает дельту Программиста в ЧИСТОМ дереве РАНЬШЕ doc-правок
  // («GI раньше записи doc-ролей»). Как только git-ветвь ушла с GIT_INTEGRATOR (роль →
  // JOIN_GATE) или стала терминальной — гейт снимается, doc-ветвь пишет поверх уже
  // влитого кода. Живость (DOC-BRANCH-LIVENESS-001) цела: зависимость односторонняя
  // (doc ждёт быстрый GI, а не наоборот — основной поток не блокируется). Предикат
  // бьёт ТОЛЬКО по doc-ролям fork-ребёнка (parent_task_id IS NOT NULL); прочие ИИ-роли
  // и не-fork документация (parent_task_id IS NULL) не гейтятся.
  params.push(DOC_BRANCH_ROLE_CODES);
  const docSerializeGate = `
          AND (
            NOT (r.code = ANY($${params.length}::text[]))
            OR t.parent_task_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM tasks sib
                JOIN roles sr ON sr.id = sib.current_role_id
               WHERE sib.parent_task_id = t.parent_task_id
                 AND sib.id <> t.id
                 AND sib.status NOT IN ('DONE','CANCELLED','FAILED')
                 AND sr.code = 'GIT_INTEGRATOR'
            )
          )`;
  await c.query('BEGIN');
  try {
    const picked = await c.query(
      `SELECT t.id, t.title, t.description, t.status::text AS status, t.project_id,
              t.data_card, t.current_stage_key, t.parent_task_id, r.code AS role_code, r.id AS role_id
         FROM tasks t
         JOIN roles r ON r.id = t.current_role_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assigned_agent_id IS NULL
          AND r.hidden = false
          AND (p.id IS NULL OR p.status <> 'paused')
          AND r.code = ANY($1::text[])
          ${roleFilter}
          AND (
            (t.project_id IS NOT NULL AND (
              EXISTS (
                SELECT 1 FROM project_stages ps
                  JOIN project_stage_roles psr ON psr.stage_id = ps.id
                 WHERE ps.project_id = t.project_id AND ps.enabled = true
                   AND psr.role_id = r.id AND ps.task_status::text = t.status::text
                   AND (t.current_stage_key IS NULL OR ps.stage_key = t.current_stage_key)
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM project_stages ps2
                   WHERE ps2.project_id = t.project_id AND ps2.enabled = true AND ps2.task_status IS NOT NULL
                )
                AND (r.code, t.status::text) IN (VALUES ${valuesSql})
              )
              -- TASK-RESTART-001: перезапущенные задачи Приёмщик забирает БЕЗУСЛОВНО,
              -- даже если у проекта нет этапа с маппингом на этот статус (иначе после
              -- ручного перезапуска они бы снова зависли, как BACKLOG при входе READY).
              OR (r.code = 'TASK_INTAKE_OFFICER' AND t.status::text = 'RESTART')
            ))
            -- INTAKE-INTEGRATIONS-001: беспроектное обращение из канала «интеграции в
            -- приложения» — Приёмщик забирает его СРАЗУ в BACKLOG. Без этой ветки
            -- INNER JOIN projects скрывал бы задачу без проекта, и обращение зависло бы.
            OR (t.project_id IS NULL AND r.code = 'TASK_INTAKE_OFFICER' AND t.status::text = 'BACKLOG')
          )${docSerializeGate}
        ORDER BY t.priority ASC, t.created_at ASC
        FOR UPDATE OF t SKIP LOCKED
        LIMIT 1`,
      params,
    );
    if (!picked.rowCount) {
      await c.query('COMMIT');
      return null;
    }
    const task = picked.rows[0];
    const agent = await c.query('SELECT id FROM agents WHERE role_id = $1 ORDER BY created_at LIMIT 1', [task.role_id]);
    const agentId = agent.rows[0]?.id ?? null;
    if (!agentId) {
      // Без агента нельзя записать agent_run — не зацикливаемся на этой задаче.
      await c.query('ROLLBACK');
      return null;
    }
    await c.query('UPDATE tasks SET assigned_agent_id = $2 WHERE id = $1', [task.id, agentId]);
    // ROLE-ENGINE-ROUTING-002: снимок фактического движка роли (connector/provider/
    // model/driver) на момент захвата — источник истины для дневной агрегации по
    // моделям, устойчивый к последующему переименованию/удалению коннектора.
    const snap = await resolveConnectorSnapshot(c, task.role_code);
    const run = await c.query(
      `INSERT INTO agent_runs (task_id, agent_id, role_id, status, started_at, input_json,
         snapshot_connector_id, snapshot_provider, snapshot_model, snapshot_driver_type)
       VALUES ($1, $2, $3, 'RUNNING', now(), $4::jsonb, $5, $6, $7, $8) RETURNING id`,
      [task.id, agentId, task.role_id, JSON.stringify({ roleCode: task.role_code, status: task.status }),
        snap.connectorId, snap.provider, snap.model, snap.driverType],
    );
    // VERSION-KPI-TRACKING-001: штампуем версию промта роли в момент захвата (а не
    // сдачи) — именно эта версия исполняется, даже если промт поправят в полёте.
    const { getActivePromptVersion } = await import('./roles.js');
    const promptVersion = await getActivePromptVersion(c, task.role_code);
    if (promptVersion != null) {
      await c.query('UPDATE agent_runs SET prompt_version = $2 WHERE id = $1', [run.rows[0].id, promptVersion]);
    }
    const rc = await c.query(
      `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND from_status = 'FAILURE_ANALYSIS'`,
      [task.id],
    );
    await c.query('COMMIT');
    return { ...task, agentId, agentRunId: run.rows[0].id, reworkCount: rc.rows[0].n };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Прошлые успешные выводы ролей по задаче (для проброса по цепочке) + последнее
// ревью. Позволяет DECOMPOSER видеть решение ARCHITECT, FAILURE_ANALYST — ревью,
// Programmer — проект и разбивку. Общий источник для роли и для Claude-моста.
export async function fetchPriorOutputs(c, taskId) {
  // PIPELINE-PRIOR-DEDUP-001: при Dynamic Workflow (REWORK/BRANCH к Failure
  // Analyst/RESTART/доработка через moveTask) задача проходит роли многократно,
  // и каждый SUCCESS-прогон копится в agent_runs. Следующей роли по маршруту
  // нужен только ПОСЛЕДНИЙ вывод каждой предшественницы, а не вся портянка её
  // попыток (замер по живой БД: до 182 SUCCESS-прогонов одной роли → ~106K
  // символов, ~25-30K токенов в каждом вызове модели). DISTINCT ON (r.code) с
  // ORDER BY r.code, started_at DESC оставляет последний прогон каждой роли;
  // внешний ORDER BY по started_at восстанавливает хронологию ролей (читаемость
  // промпта). Ср. programmer-runner/src/promptBuilder.js ("Keep the latest output
  // per role"). История agent_runs/prompt_exchanges НЕ трогается — это только
  // выборка контекста; форма строк и контракт summarizePriorRuns(runs.rows) те же.
  const runs = await c.query(
    `SELECT latest.role_code, latest.status, latest.output_json
       FROM (
         SELECT DISTINCT ON (r.code)
                r.code AS role_code, ar.status::text AS status, ar.output_json, ar.started_at
           FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
          WHERE ar.task_id = $1 AND ar.status = 'SUCCESS' AND ar.output_json IS NOT NULL
          ORDER BY r.code, ar.started_at DESC
       ) latest
      ORDER BY latest.started_at`,
    [taskId],
  );
  const review = await c.query(
    `SELECT status::text AS status, review_text FROM reviews WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  return {
    priorRoleOutputs: summarizePriorRuns(runs.rows),
    lastReview: review.rows[0] ? { status: review.rows[0].status, text: review.rows[0].review_text } : null,
  };
}

// FA-MISSING-ARTIFACT-001 — сжать output_json ПРОВАЛЬНОГО прогона host-роли
// (PIPELINE_SERVICE/GIT_INTEGRATOR) в компактный артефакт для контекста Аналитика
// сбоя. Без этого артефакта FA «не видит» причину падения (нет упавшей команды,
// кода возврата, строк лога) и раунд за раундом просит «реальный лог», хотя причина
// уже лежит в БД (инцидент 1c3967ab/1ff73c5a: pipeline_compose_not_found).
// Чистая функция (форма output известна из pipeline-runner/host-runner). Толерантна
// к форме `error`: объект {code,message,logTail} ЛИБО строка (GIT_INTEGRATOR:
// output.error='commit failed: …'); и к месту `error`: верхний уровень (инцидент)
// ЛИБО summary.error (pipeline-runner). Ошибка ДО запуска команд (compose-not-found)
// → error.message несёт причину, logTail/failedCommand пустые (это норма, не потеря).
export function summarizeFailureArtifact(roleCode, output) {
  const clip = (v, max) => {
    if (v == null) return null;
    const s = String(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const o = output && typeof output === 'object' && !Array.isArray(output) ? output : {};
  const summary = o.summary && typeof o.summary === 'object' && !Array.isArray(o.summary) ? o.summary : {};
  const rawErr = o.error ?? summary.error ?? null;
  let errorCode = null;
  let errorMessage = null;
  let logTail = '';
  if (rawErr && typeof rawErr === 'object' && !Array.isArray(rawErr)) {
    errorCode = clip(rawErr.code, 200);
    errorMessage = clip(rawErr.message, 2000);
    if (typeof rawErr.logTail === 'string') logTail = rawErr.logTail;
  } else if (typeof rawErr === 'string') {
    errorMessage = clip(rawErr, 2000);
  }
  const failedStage = o.failedStage ?? summary.failedStage ?? null;
  // Упавшая команда с exit code — из summary.actions (если команды вообще стартовали).
  const actions = Array.isArray(summary.actions) ? summary.actions : [];
  const failedAction = actions.find((a) => a && typeof a === 'object'
    && a.status && a.status !== 'success' && a.status !== 'SKIPPED') ?? null;
  const failedCommand = failedAction && failedAction.command
    ? { command: clip(failedAction.command, 500), exitCode: failedAction.exitCode ?? null }
    : null;
  // Хвост лога: из error.logTail (уже усечён pipeline-runner), иначе — из logFragment
  // упавшей команды. При ошибке ДО команд остаётся пустым (причина — в errorMessage).
  if (!logTail && failedAction && typeof failedAction.logFragment === 'string') {
    logTail = failedAction.logFragment;
  }
  const note = typeof o.note === 'string' ? o.note
    : (typeof summary.note === 'string' ? summary.note : null);
  return {
    role: roleCode,
    status: 'FAILED',
    failedStage: failedStage ?? null,
    errorCode,
    errorMessage,
    failedCommand,
    logTail: clip(logTail, 4000) ?? '',
    logPath: o.logPath ?? summary.logPath ?? null,
    runId: summary.runId ?? o.runId ?? null,
    // GIT_INTEGRATOR и пр.: пометка исхода (no_changed_files/nothing_to_stage).
    note: note != null ? clip(note, 500) : null,
  };
}

// HOST-FAILURE-TEXT-001 — предел длины error_text host-роли. 500 символов хватает
// на код причины + сообщение; кап защищает agent_runs от раздувания длинным
// error.message (тот же принцип, что RELEASE_TEXT_MAX для release-reason).
const HOST_FAILURE_TEXT_MAX = 500;

// HOST-FAILURE-TEXT-001 — роль-агностичный текст причины падения host-роли для
// agent_runs.error_text. Переиспользует summarizeFailureArtifact (единый разбор
// output → errorCode/failedStage/errorMessage/note), чтобы формат кода причины был
// ОБЩИМ с веткой GIT_INTEGRATOR (ORCH-GI-BLOCKED-OWNER-001 переиспользует этот же
// helper). Формат строки:
//   <errorCode|failedStage|<role>_failed>: <errorMessage|note|'no structured detail'>
// Гарантированно НЕПУСТАЯ строка (монитор показывает причину, а не пустоту),
// усечённая до предела error_text.
export function deriveHostFailureText(roleCode, output) {
  const role = String(roleCode ?? '').trim() || 'host_role';
  const artifact = summarizeFailureArtifact(role, output);
  const nonEmpty = (v) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s : null;
  };
  // ENV-SETUP-FAIL-001: setup-сбой Go-воркспейса (модуль вне go.work) → код причины
  // env_setup_failed вместо родового pipeline_stage_failed, чтобы классификатор CH
  // (clickhouseObservability.classify) и монитор видели именно ОКРУЖЕНИЕ, а не «тест».
  const code = detectEnvSetupFailure(output)
    ? 'env_setup_failed'
    : (nonEmpty(artifact.errorCode)
      ?? nonEmpty(artifact.failedStage)
      ?? `${role.toLowerCase()}_failed`);
  const detail = nonEmpty(artifact.errorMessage)
    ?? nonEmpty(artifact.note)
    ?? 'no structured detail';
  const text = `${code}: ${detail}`;
  return text.length > HOST_FAILURE_TEXT_MAX ? text.slice(0, HOST_FAILURE_TEXT_MAX) : text;
}

// ENV-SETUP-FAIL-001 — распознать инфраструктурный setup-сбой Go-воркспейса в артефакте
// провала стадии: модуль сервиса вне корневого go.work → `go test/build` не стартует
// (`directory prefix . does not contain modules listed in go.work` / `[setup failed]`).
// Это ОКРУЖЕНИЕ (лечится GOWORK=off / включением модуля в go.work), а не код задачи —
// гонять такой провал через Аналитика сбоя бессмысленно (нет кода для правки). Матчим по
// errorMessage + logTail + упавшей команде; узкий набор маркеров против ложных срабатываний.
export function detectEnvSetupFailure(output) {
  const a = summarizeFailureArtifact('', output);
  const hay = `${a.errorMessage || ''}\n${a.logTail || ''}\n${a.failedCommand?.command || ''}`.toLowerCase();
  return hay.includes('go.work')
    || hay.includes('[setup failed]')
    || hay.includes('does not contain modules listed');
}

// FA-MISSING-ARTIFACT-001 — артефакт ПОСЛЕДНЕГО провального прогона host-роли задачи
// для контекста Аналитика сбоя. Источник — agent_runs.output_json упавшего прогона
// (status='FAILED'), который completeHostTaskTx уже пишет целиком; тот же output
// лежит и в payload события STATUS_CHANGED→FAILURE_ANALYSIS — берём из agent_runs как
// единственной строки на прогон. Возвращает null, если провальных прогонов нет.
export async function fetchFailureArtifact(c, taskId) {
  const r = await c.query(
    `SELECT r.code AS role_code, ar.output_json
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND ar.status = 'FAILED'
        AND r.code IN ('PIPELINE_SERVICE', 'GIT_INTEGRATOR')
        AND ar.output_json IS NOT NULL
      ORDER BY ar.started_at DESC LIMIT 1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return summarizeFailureArtifact(row.role_code, row.output_json);
}

// FA-MISSING-ARTIFACT-001 — жаловался ли ПРЕДЫДУЩИЙ прогон Аналитика сбоя на
// отсутствие артефакта провала? Читаем output_json последнего завершённого прогона
// FAILURE_ANALYST (кроме текущего, ещё RUNNING) и прогоняем через
// isMissingArtifactComplaint. Нужен анти-петле decideOutcome: две жалобы подряд по
// одному провалу → BLOCKED сразу (missing_artifact), а не ещё круг вхолостую.
async function priorFailureAnalystMissedArtifact(c, taskId, excludeRunId) {
  const r = await c.query(
    `SELECT ar.output_json
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND r.code = 'FAILURE_ANALYST'
        AND ar.output_json IS NOT NULL AND ($2::uuid IS NULL OR ar.id <> $2)
      ORDER BY ar.started_at DESC LIMIT 1`,
    [taskId, excludeRunId ?? null],
  );
  const o = r.rows[0]?.output_json;
  if (!o || typeof o !== 'object') return false;
  return isMissingArtifactComplaint({ summary: o.summary, findings: o.findings });
}

// MISSING-OUTPUTS-CAP-001 — сколько ПОДРЯД последних завершённых прогонов этой роли
// по задаче кончились недобором обязательных выходных полей (reason missing_outputs:*).
// Нужен капу в applyReasoningVerdict: REWORK от missing_outputs назначается ПОСЛЕ
// decideOutcome, мимо его защиты max_rework_exceeded, и никаким счётчиком не покрыт:
// кап провалов считает FAILED-прогоны (а эти SUCCESS), reworkCount — только возвраты
// с FAILURE_ANALYSIS. Для ПЕРВОЙ роли маршрута REWORK ведёт в неё же саму
// (reworkTarget → firstStep) — без капа это вечная петля. Инцидент: Приёмщик с
// легитимно пустым required-списком (см. миграцию 0050) крутился BACKLOG→BACKLOG
// прогоном LLM каждые ~40 секунд.
async function priorMissingOutputsStreak(c, taskId, roleCode, excludeRunId, limit) {
  if (limit <= 0) return 0;
  const r = await c.query(
    `SELECT ar.output_json->>'reason' AS reason
       FROM agent_runs ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.task_id = $1 AND r.code = $2 AND ar.finished_at IS NOT NULL
        AND ($3::uuid IS NULL OR ar.id <> $3)
      ORDER BY ar.started_at DESC LIMIT $4`,
    [taskId, roleCode, excludeRunId ?? null, limit],
  );
  let n = 0;
  for (const row of r.rows) {
    if (String(row.reason ?? '').startsWith('missing_outputs')) n += 1;
    else break;
  }
  return n;
}

// INTAKE-INTEGRATIONS-001 / INTAKE-CATEGORY-VALIDATION-001 — собрать компактный блок
// обращения (intakeReport) для контекста роли. Чистая функция (без БД). Блок
// формируется ТОЛЬКО для задач-обращений (isIntakeTask, т.е. intake_integration_id
// IS NOT NULL) и ТОЛЬКО под ролью Приёмщика (TASK_INTAKE_OFFICER) — иначе null.
// Размер капим, чтобы не раздувать вход роли: jsErrors — первые 10 строк, каждая
// с капом длины; url/userAgent/screenshotUrl тоже обрезаем по длине.
export function buildIntakeReportContext(dataCard, { roleCode, isIntakeTask } = {}) {
  if (!isIntakeTask || roleCode !== 'TASK_INTAKE_OFFICER') return null;
  const card = dataCard && typeof dataCard === 'object' && !Array.isArray(dataCard) ? dataCard : {};
  const clip = (v, max) => {
    const s = v == null ? null : String(v);
    if (s == null) return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const ac = card.autocontext && typeof card.autocontext === 'object' && !Array.isArray(card.autocontext)
    ? card.autocontext : {};
  const jsErrors = Array.isArray(ac.jsErrors)
    ? ac.jsErrors.slice(0, 10).map((e) => clip(e, 300)).filter((e) => e != null)
    : [];
  return {
    reportNumber: card.reportNumber ?? null,
    // Номер тикета в подсистеме-источнике — пользователь ссылается на него.
    sourceTicketNo: card.sourceTicketNo ?? null,
    integration: card.integration ?? null,
    reporterUser: card.reporterUser ?? null,
    reporterService: card.reporterService ?? null,
    reporterForm: card.reporterForm ?? null,
    // Категория из виджета — подсказка пользователя (user_category), не истина.
    category: card.category ?? null,
    autocontext: {
      url: clip(ac.url, 500),
      buildVersion: clip(ac.buildVersion, 100),
      userAgent: clip(ac.userAgent, 300),
      timestamp: clip(ac.timestamp, 60),
      jsErrors,
      lastFailedApiRequestId: clip(ac.lastFailedApiRequestId, 200),
    },
    screenshotUrl: clip(card.screenshotUrl, 500),
  };
}

// Собрать компактный контекст задачи для промта роли.
async function buildRoleContext(c, claimed, { engine = null } = {}) {
  const ev = await c.query(
    `SELECT event_type, from_status::text AS from_status, to_status::text AS to_status, payload_json
       FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [claimed.id],
  );
  const scan = ev.rows.find((r) => r.payload_json && (r.payload_json.changedFiles || r.payload_json.result));
  // INTAKE-INTEGRATIONS-001: LEFT JOIN — беспроектное обращение из интеграций
  // (project_id IS NULL) не должно давать пустую строку (INNER JOIN скрыл бы её).
  const meta = await c.query(
    `SELECT p.id AS project_id, p.code AS project, p.root_path, p.docs_path, s.service_code AS service,
            t.intake_integration_id, t.data_card
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN services s ON s.id = t.service_id WHERE t.id = $1`,
    [claimed.id],
  );
  // Реальные сервисы проекта (DATA-DISCIPLINE-001): роль классифицирует задачу по
  // фактическому списку сервисов проекта, а не выдумывает названия.
  const projectId = meta.rows[0]?.project_id ?? null;
  const svc = projectId
    ? await c.query('SELECT service_code FROM services WHERE project_id = $1 ORDER BY service_code', [projectId])
    : { rows: [] };
  const prior = await fetchPriorOutputs(c, claimed.id);

  // FA-MISSING-ARTIFACT-001: Аналитику сбоя подаём артефакт последнего провального
  // прогона host-роли (PIPELINE_SERVICE/GIT_INTEGRATOR) — error.code/message,
  // failedStage, упавшая команда с exit code и хвост лога. Без него FA не видит
  // причину (fetchPriorOutputs берёт только SUCCESS-прогоны) и просит «реальный лог»
  // раунд за раундом. Только для FA — прочим ролям артефакт провала не нужен (null).
  const failureArtifact = claimed.role_code === 'FAILURE_ANALYST'
    ? await fetchFailureArtifact(c, claimed.id)
    : null;

  // REVIEW-DELTA-VISIBILITY-001: ролям-ревьюерам/гейтам подаём ветку+коммит доставки
  // Программиста (тот же источник, что видит Git Integrator — resolveHostTaskContext по
  // цепочке предков), чтобы ревьюер смотрел РЕАЛЬНУЮ дельту в изолированной ветке, а не
  // «пустое» рабочее дерево (main). Без него ревьюер отбивал корректные сдачи как
  // NEEDS_FIX «реализация отсутствует». Нет ветки/коммита → null (прежнее поведение).
  let reviewDelta = null;
  if (REVIEW_DELTA_ROLES.has(claimed.role_code)) {
    const host = await resolveHostTaskContext(c, claimed.id).catch(() => null);
    const branch = host?.scan?.payload_json?.worktreeBranch ?? null;
    const commit = host?.scan?.payload_json?.deliveredCommit ?? null;
    if (branch || commit) reviewDelta = { branch, commit };
  }

  // DECOMP-CONTRACT-001: если это задача-на-сервис (kind='service' с подзадачами),
  // её реальные результаты лежат на детях-подзадачах. Соберём их, чтобы Task
  // Reviewer видел весь сервис целиком, а не пустой programmerResult.
  const kids = await c.query(
    `SELECT t.id, t.title, t.status::text AS status,
            (SELECT e.payload_json FROM task_events e
              WHERE e.task_id = t.id
                AND (e.payload_json ? 'result' OR e.payload_json ? 'changedFiles')
              ORDER BY e.created_at DESC LIMIT 1) AS done_payload
       FROM tasks t
      WHERE t.parent_task_id = $1 AND t.task_kind = 'subtask'
      ORDER BY t.created_at`,
    [claimed.id],
  );
  const subtaskResults = kids.rows.map((k) => ({
    taskId: k.id,
    title: k.title,
    status: k.status,
    result: k.done_payload?.result ?? '',
    changedFiles: Array.isArray(k.done_payload?.changedFiles) ? k.done_payload.changedFiles : [],
  }));
  const aggregatedChanged = subtaskResults.flatMap((r) => r.changedFiles);
  const hasChildren = subtaskResults.length > 0;

  // RESEARCH-BUDGET-001: исследующим ролям (Архитектор/Декомпозитор и пр.) подаём
  // карту проекта и карту микросервиса инлайн — чтобы они не переоткрывали
  // структуру широкими Grep-свипами. Карты кэшируются на час (projectMap.js).
  // DECOMPOSER-REMOVE-001: карту подаём по MAP_ROLES (исследующие роли + Приёмщик).
  const { MAP_ROLES } = await import('./roles.js');
  let projectMaps = null;
  if (MAP_ROLES.has(claimed.role_code)) {
    const { loadProjectMaps } = await import('./projectMap.js');
    // PROMPT-CACHE-001: codex (нет prompt-кэша, карта шлётся каждый вызов) получает
    // СОКРАЩЁННУЮ карту; claude_code/deepseek — полную (у claude она кэшируется).
    const variant = String(engine || '').toLowerCase() === 'codex' ? 'short' : 'full';
    projectMaps = await loadProjectMaps(meta.rows[0]?.root_path ?? '', {
      service: meta.rows[0]?.service ?? '',
      docsPath: meta.rows[0]?.docs_path ?? '',
      variant,
    }).catch(() => null);
  }

  // INTAKE-INTEGRATIONS-001: беспроектное обращение из интеграций — подаём Приёмщику
  // каталог ВСЕХ зарегистрированных проектов (код/имя/папки/сервисы), чтобы он
  // определил проект по подсказкам обращения (микросервис-источник и форма). Для
  // задач с проектом — null (проект уже известен).
  let projectCatalog = null;
  if (!projectId && claimed.role_code === 'TASK_INTAKE_OFFICER') {
    const cat = await c.query(
      `SELECT p.code, p.name, p.root_path, p.docs_path,
              COALESCE(
                array_agg(s.service_code ORDER BY s.service_code)
                  FILTER (WHERE s.service_code IS NOT NULL), '{}'
              ) AS services
         FROM projects p
         LEFT JOIN services s ON s.project_id = p.id
        WHERE p.status <> 'paused'
        GROUP BY p.id, p.code, p.name, p.root_path, p.docs_path
        ORDER BY p.code`,
    );
    projectCatalog = cat.rows.map((r) => ({
      code: r.code, name: r.name, rootPath: r.root_path, docsPath: r.docs_path,
      services: Array.isArray(r.services) ? r.services : [],
    }));
  }

  // INTAKE-INTEGRATIONS-001 / INTAKE-CATEGORY-VALIDATION-001: поля обращения из
  // канала интеграций (reporterService/reporterForm/autocontext/screenshotUrl/
  // category) в контекст Приёмщика. Только для задач-обращений и только Приёмщику.
  const intakeReport = buildIntakeReportContext(meta.rows[0]?.data_card, {
    roleCode: claimed.role_code,
    isIntakeTask: Boolean(meta.rows[0]?.intake_integration_id),
  });

  return {
    taskId: claimed.id,
    title: claimed.title,
    description: claimed.description ?? '',
    status: claimed.status,
    role: claimed.role_code,
    project: meta.rows[0]?.project ?? '',
    service: meta.rows[0]?.service ?? '',
    // Реальные координаты проекта — источник истины для ролей (не выдумывать пути).
    projectPath: meta.rows[0]?.root_path ?? '',
    docsPath: meta.rows[0]?.docs_path ?? '',
    // Карта проекта/сервиса инлайн (только для исследующих ролей; иначе null).
    projectMaps,
    // Каталог всех проектов для беспроектного обращения из интеграций (иначе null).
    projectCatalog,
    // Поля обращения из канала интеграций (только у задач-обращений под Приёмщиком).
    intakeReport,
    projectServices: svc.rows.map((r) => r.service_code),
    // Для задачи-на-сервис берём агрегат результатов подзадач; иначе — как раньше.
    programmerResult: hasChildren
      ? subtaskResults.map((r) => `• ${r.title}: ${r.result}`).join('\n')
      : (scan?.payload_json?.result ?? ''),
    changedFiles: hasChildren ? aggregatedChanged : (scan?.payload_json?.changedFiles ?? []),
    subtaskResults,
    priorRoleOutputs: prior.priorRoleOutputs,
    lastReview: prior.lastReview,
    // FA-MISSING-ARTIFACT-001: артефакт последнего провала host-роли (только для FA).
    failureArtifact,
    // REVIEW-DELTA-VISIBILITY-001: ветка/коммит доставки для ролей-ревьюеров (иначе null).
    // buildUserPayload вынет его в markdown-блок renderReviewDelta (в JSON не кладём).
    reviewDelta,
    recentEvents: ev.rows.slice(0, 8).map((r) => ({ type: r.event_type, from: r.from_status, to: r.to_status })),
  };
}

// Прогон одной захваченной роли: вызов ИИ (вне транзакции) → финализация.
// PIPELINE-DYNAMIC-ROUTE-001 + ROLE-FIELD-CONTRACT-001:
//   * маршрут и статус следующей роли берём из этапов проекта;
//   * входной гейт: нет обязательного входящего поля в карточке → BLOCKED (роль
//     не запускаем, токены не тратим);
//   * выходной гейт: роль не заполнила обязательное исходящее поле → REWORK;
//   * заполненные исходящие поля пишем в кумулятивную карточку задачи.
// TESTS-GREEN-SKIP-FA-001 — у задачи есть АКТУАЛЬНЫЙ провал тестов? Аналитик сбоя
// (FAILURE_ANALYST) существует, чтобы диагностировать ПАДЕНИЕ пайплайна. Если
// последний прогон тестов успешен (или тестов не было) — анализировать нечего.
// Чистая функция (статус последнего pipeline_run → bool) — покрыта юнит-тестом.
export function failureAnalysisHasRealFailure(lastPipelineStatus) {
  return String(lastPipelineStatus ?? '').trim().toUpperCase() === 'FAILED';
}

// Статус последнего прогона тестов задачи (или null, если прогонов не было).
async function latestPipelineStatus(c, taskId) {
  const r = await c.query(
    `SELECT status::text AS status FROM pipeline_runs
      WHERE task_id = $1 ORDER BY finished_at DESC NULLS LAST, started_at DESC LIMIT 1`,
    [taskId],
  );
  return r.rows[0]?.status ?? null;
}

// TESTS-GREEN-SKIP-FA-001 — пропустить этап «Анализ сбоя» для задачи с зелёными
// тестами: продвигаем её ВПЕРЁД по маршруту (мимо аналитика) со статусом успеха,
// НЕ запуская модель. Это и реализует правило «тесты пройдены → этап пропускаем»,
// и разгребает завал задач, осевших в FAILURE_ANALYSIS при зелёном пайплайне
// (напр. после реджекта ревьюера или таймаутов аналитика). Возвращает результат
// finalizeRole, либо null — если у задачи РЕАЛЬНЫЙ провал тестов и аналитик нужен.
async function maybeSkipFailureAnalyst(c, claimed, route) {
  const last = await latestPipelineStatus(c, claimed.id);
  if (failureAnalysisHasRealFailure(last)) return null;
  const verdict = {
    ok: true, status: 'SKIPPED', findings: [], fields: {},
    summary: 'Тесты пройдены — анализ сбоя не требуется, этап пропущен.',
  };
  const decision = { outcome: 'FORWARD', agentRunStatus: 'SUCCESS', reason: 'tests_passed_skip' };
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    });
  return finalizeRole(c, claimed, {
    verdict, response: '', exchangeId: null, durationMs: 0, decision, resolved, cardValues: {}, kpi: null,
  });
}

// DB-FINALIZE-RETRY-001 — устойчивость финализации прогона к транзиентным обрывам БД.
//
// Проблема: финализация прогона рассуждающей роли (запись вердикта/перехода/agent_run
// ПОСЛЕ LLM-вызова) выполняется отдельной транзакцией BEGIN..COMMIT на claim-соединении.
// Если соединение рвётся в этот момент (короткий шторм «Connection terminated» при
// рестарте/failover pgbouncer/Patroni), финализация падает, ошибка глохла в
// advanceAutomatedTasks (.catch(()=>null)), а прогон оставался в RUNNING и держал слот
// роли до таймаута — так копились сотни FAILED/TIMEOUT.
//
// Решение: ограниченный ретрай ТОЛЬКО пост-LLM записи результата. LLM НЕ повторяем —
// повторяем лишь финализирующую транзакцию, причём на СВЕЖЕМ соединении из пула (claim
// уже закоммичен отдельной транзакцией claimLlmRoleTask, поэтому финализацию безопасно
// повторить на другом соединении — с claim-локом не конфликтует). Идемпотентность
// повторной записи обеспечивается на уровне транзакции (isRunAlreadyFinalized): если
// первая попытка уже закоммитила результат, но ack COMMIT потерялся из-за обрыва, ретрай
// увидит agent_run уже не в RUNNING и выйдет без повторной вставки событий/переходов.
const FINALIZE_RETRY_BACKOFF_MS = [100, 200, 400];

function sleepMs(ms) {
  return new Promise((res) => { setTimeout(res, ms); });
}

// Идемпотентный гейт финализации: блокируем строку agent_run (FOR UPDATE) и смотрим её
// статус. Прогон уже не RUNNING → он финализирован (в т.ч. предыдущей попыткой, чей ack
// COMMIT потерялся) → true: вызывающий обязан ROLLBACK и выйти без повторной записи.
// Нет строки прогона → false (не мешаем прежнему поведению; напр. фейковый клиент в
// тестах, где строки agent_runs нет). Вызывать ВНУТРИ транзакции финализации.
async function isRunAlreadyFinalized(c, agentRunId) {
  if (!agentRunId) return false;
  const r = await c.query(
    `SELECT status::text AS status FROM agent_runs WHERE id = $1 FOR UPDATE`,
    [agentRunId],
  );
  if (!r.rowCount) return false;
  return r.rows[0].status !== 'RUNNING';
}

// Выполнить пост-LLM запись результата прогона с ограниченным ретраем при ТРАНЗИЕНТНОМ
// обрыве соединения. Первая попытка — на исходном claim-соединении `client`; повторы —
// на СВЕЖЕМ соединении (withClient(cfg, ...)), с экспоненциальной задержкой backoff.
// Небизнес-ошибки (не обрыв соединения — isDbConnectionError) пробрасываются сразу, без
// ретраев. Если открывать свежее соединение некуда (cfg не передан и нет deps.withFresh)
// — прежнее поведение: ошибка всплывает наверх. deps — инъекции для тестов.
async function finalizeWithConnRetry(finalize, client, cfg, deps = {}) {
  const withFresh = deps.withFresh ?? (cfg ? (fn) => withClient(cfg, fn) : null);
  const sleep = deps.sleep ?? sleepMs;
  const backoff = deps.backoff ?? FINALIZE_RETRY_BACKOFF_MS;
  try {
    return await finalize(client);
  } catch (error) {
    if (!withFresh || !isDbConnectionError(error)) throw error;
    let lastError = error;
    for (const delayMs of backoff) {
      await sleep(delayMs);
      try {
        return await withFresh(finalize);
      } catch (retryError) {
        lastError = retryError;
        if (!isDbConnectionError(retryError)) throw retryError;
      }
    }
    throw lastError; // ретраи исчерпаны — ошибка всплывает наверх (не глушим молча)
  }
}

// DB-FINALIZE-RETRY-001 (тестовый экспорт): доступ к чистым частям механизма ретрая/
// идемпотентности без сетевого withClient (см. finalizeRetry.test.js).
export const __finalizeRetryInternals = {
  FINALIZE_RETRY_BACKOFF_MS, isRunAlreadyFinalized, finalizeWithConnRetry,
};

async function processClaimedRole(c, claimed, cfg) {
  const route = await loadProjectRoute(c, claimed.project_id);
  // TESTS-GREEN-SKIP-FA-001: аналитик сбоя на задаче с зелёными тестами — пропуск
  // вперёд без вызова модели (см. maybeSkipFailureAnalyst). Делаем это ДО гейта
  // входных полей и тяжёлого tool-loop: пропускаемой задаче они не нужны.
  if (claimed.role_code === 'FAILURE_ANALYST') {
    const skipped = await maybeSkipFailureAnalyst(c, claimed, route);
    if (skipped) return skipped;
  }
  const contract = await loadRoleContract(c, claimed.role_code);
  const card = parseDataCard(claimed);

  const missingIn = missingRequiredInputs(card, contract.inputs);
  if (missingIn.length) {
    return blockClaimedForFields(c, claimed, missingIn);
  }

  const context = await buildRoleContext(c, claimed);

  // Инструменты роли (TOOLS-REGISTRY-001): builtin по разрешённым уровням доступа.
  // Исполняются микросервисом tools-service в корне реального проекта задачи —
  // чтобы роль РЕАЛЬНО читала/меняла проект, а не выдумывала.
  const { getToolsForRole, BUILTIN_TOOL_SCHEMAS } = await import('./tools.js');
  const { executeTool } = await import('./toolsClient.js');
  const roleTools = await getToolsForRole(c, claimed.role_code);
  const projectRoot = String(context.projectPath || context.docsPath || '').trim();
  const toolSchemas = projectRoot
    ? roleTools.builtin.map((name) => BUILTIN_TOOL_SCHEMAS[name]).filter(Boolean)
    : [];
  const runTool = (name, args) => executeTool(name, args, { root: projectRoot });

  let result;
  try {
    result = await runReasoningRole(c, {
      roleCode: claimed.role_code,
      context,
      outputFields: contract.outputs,
      toolSchemas,
      executeTool: runTool,
    });
  } catch (error) {
    // DB-FINALIZE-RETRY-001: LLM-вызов НЕ повторяем — но запись FAILED-исхода тоже
    // должна пережить транзиентный обрыв соединения (иначе прогон завис бы в RUNNING).
    return finalizeWithConnRetry((fc) => failRoleRun(fc, claimed, error), c, cfg);
  }

  // SILENT-FAIL-GUARD-001 (B): модель ответила, но без распознаваемого JSON-вердикта
  // (напр. DeepSeek прислал tool-call разметку вместо финального JSON, либо упёрся в
  // инструменты). НЕ считаем это успехом и НЕ продвигаем задачу вперёд — помечаем
  // «не выполнен» (FAILED) с логированием причины, чтобы быстро находить поломку.
  // DB-FINALIZE-RETRY-001: запись исхода — под ретрай (LLM уже отработал, не повторяем).
  if (result.parsed === null) {
    return finalizeWithConnRetry((fc) => failRoleUnparsed(fc, claimed, result), c, cfg);
  }

  // DB-FINALIZE-RETRY-001: запись вердикта/перехода/agent_run — под ретрай на свежем
  // соединении. LLM-результат (result) уже получен и в ретрае переиспользуется как есть.
  return finalizeWithConnRetry((fc) => applyReasoningVerdict(fc, claimed, {
    route,
    contract,
    verdict: result.verdict,
    response: result.response,
    exchangeId: result.exchangeId,
    durationMs: result.durationMs,
    // OBSERVABILITY-REASONING-001: токены/ходы in-process DeepSeek-пути в KPI.
    kpi: normalizeRunKpi({
      tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      turns: result.turns, outcome: 'success',
    }),
  }), c, cfg);
}

// Хвост рассуждающей роли: распознанный вердикт → выходной гейт полей → решение
// перехода (абстрактный исход + маршрут проекта) → финализация. Вынесен из
// processClaimedRole, чтобы codex-мост (CODEX-REASONING-001) переиспользовал ту же
// логику переходов, что и внутренний DeepSeek-путь — отличается только источник
// вердикта (внешний `codex exec` против сетевого вызова коннектора).
// OBSERVABILITY-REASONING-001 — нормализовать KPI прогона из тела сдачи раннера
// (reasoning-completed). Числа округляем; нечисловые → null (COALESCE сохранит старое).
export function normalizeRunKpi(input) {
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    tokenInput: int(input?.tokensIn),
    tokenOutput: int(input?.tokensOut),
    // TOKEN-SPLIT-001: разбивка входа (чтение/запись prompt-кэша). null → COALESCE
    // сохранит уже записанное (движки без кэша не затирают детализацию).
    tokenCacheRead: int(input?.tokensCacheRead),
    tokenCacheCreation: int(input?.tokensCacheCreation),
    cost: num(input?.costUsd),
    coldStartMs: int(input?.coldStartMs),
    turns: int(input?.turns),
    outcome: typeof input?.outcome === 'string' ? input.outcome : null,
    // VERSION-KPI-TRACKING-001: метки версии кода раннера и модели из тела сдачи.
    codeVersion: str(input?.codeVersion, 80),
    model: str(input?.model, 120),
  };
}

// Фрагмент SET для дописывания KPI прогона к UPDATE agent_runs после фиксированных
// $1..$base параметров. Токены/стоимость/code_version/model через COALESCE (не
// затираем уже записанное значением NULL при повторной/частичной сдаче).
export function runKpiSet(kpi, base) {
  if (!kpi) return { sql: '', params: [] };
  return {
    sql: `, token_input = COALESCE($${base + 1}, token_input), token_output = COALESCE($${base + 2}, token_output)`
       + `, cost = COALESCE($${base + 3}, cost), cold_start_ms = $${base + 4}, turns = $${base + 5}, outcome = $${base + 6}`
       + `, code_version = COALESCE($${base + 7}, code_version), model = COALESCE($${base + 8}, model)`
       // TOKEN-SPLIT-001: детализация входа (COALESCE — null не затирает записанное).
       + `, token_cache_read = COALESCE($${base + 9}, token_cache_read)`
       + `, token_cache_creation = COALESCE($${base + 10}, token_cache_creation)`,
    params: [kpi.tokenInput, kpi.tokenOutput, kpi.cost, kpi.coldStartMs, kpi.turns, kpi.outcome,
      kpi.codeVersion, kpi.model, kpi.tokenCacheRead, kpi.tokenCacheCreation],
  };
}

// Экспортируется для тестов (SERVICE-REPO-PATH-PREFLIGHT-001): проверяем ранний
// preflight repository_path на split-ветке Архитектора без поднятия всей БД.
// ANTI-REGRESSION-ADVISORY-001 — роли, предлагающие ПОДХОД (план/декомпозиция/фикс),
// чью формулировку имеет смысл сверять с реестром ранее ОТВЕРГНУТЫХ решений.
const ANTI_REGRESSION_ROLES = new Set(['ARCHITECT', 'MINI_ARCHITECT', 'FAILURE_ANALYST']);

// Собрать текст «предложенного подхода» из вердикта роли (summary + findings + ключевые
// структурированные поля). Массивы строк схлопываем в текст.
function approachTextFromVerdict(verdict) {
  const parts = [];
  if (verdict?.summary) parts.push(String(verdict.summary));
  if (Array.isArray(verdict?.findings)) parts.push(verdict.findings.filter((x) => typeof x === 'string').join(' '));
  const f = verdict?.fields || {};
  for (const key of ['root_cause', 'fix_task', 'plan', 'approach', 'scope_limits', 'risk_notes']) {
    const v = f[key];
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ').trim();
}

// Observe-only анти-регрессия: если предложенный подход похож на ранее отвергнутое
// решение — залогировать предупреждение. НЕ влияет на вердикт/маршрутизацию,
// fire-and-forget (checkApproach best-effort и по контракту не бросает).
function maybeCheckApproachRegression(claimed, verdict) {
  try {
    if (!ANTI_REGRESSION_ROLES.has(claimed?.role_code)) return;
    const text = approachTextFromVerdict(verdict);
    if (text.length < 24) return; // слишком коротко — нечего сверять
    void checkApproach({ text })
      .then((res) => {
        if (res?.flagged && res.matches?.length) {
          log.warn('Анти-регрессия: предложенный подход похож на ранее отвергнутые решения', {
            event_code: 'ANTI_REGRESSION_MATCH',
            operation: 'anti_regression.check',
            attributes: {
              taskId: claimed?.id,
              roleCode: claimed?.role_code,
              matches: res.matches.map((m) => ({ decision_id: m.decision_id, status: m.status, score: m.score })),
            },
          });
        }
      })
      .catch(() => {});
  } catch {
    // Advisory-контур: сбой проверки никогда не влияет на обработку вердикта.
  }
}

export async function applyReasoningVerdict(c, claimed, { route, contract, verdict, response, exchangeId, durationMs, kpi = null }) {
  // Advisory (observe-only), до любой маршрутизации: fire-and-forget, ничего не блокирует.
  maybeCheckApproachRegression(claimed, verdict);
  const { values: cardValues, missingRequired: missingOut } = extractOutputs(verdict.fields, contract.outputs);
  // FA-MISSING-ARTIFACT-001 (анти-петля): если Аналитик сбоя СНОВА жалуется на
  // отсутствие артефакта провала — проверяем, была ли та же жалоба в его прошлом
  // прогоне. Две подряд по одному провалу → decideOutcome эскалирует в BLOCKED
  // (missing_artifact), не гоняя Programmer/Reviewer/Pipeline ещё круг вхолостую.
  // Запрос делаем ТОЛЬКО когда текущий вердикт — жалоба (короткое замыкание &&).
  const priorMissingArtifact = claimed.role_code === 'FAILURE_ANALYST'
    && isMissingArtifactComplaint(verdict)
    && await priorFailureAnalystMissedArtifact(c, claimed.id, claimed.agentRunId);
  const reviewerReworkCount = claimed.role_code === 'TASK_REVIEWER'
    ? await countTaskReviewerReworks(c, claimed.id)
    : 0;
  let decision = decideOutcome(claimed.role_code, verdict, {
    reworkCount: claimed.reworkCount,
    maxRework: MAX_REWORK,
    priorMissingArtifact,
    reviewerReworkCount,
  });
  if (missingOut.length && decision.outcome !== 'BLOCK') {
    // MISSING-OUTPUTS-CAP-001: недобор обязательных выходов → REWORK, но КАПЛЕННЫЙ.
    // После MAX_REWORK одинаковых недоборов подряд — BLOCKED на ручной разбор:
    // контракт полей роли расходится с её фактическим выходом, и ещё прогон той же
    // модели по тому же промту нового результата не даст.
    const streak = await priorMissingOutputsStreak(c, claimed.id, claimed.role_code, claimed.agentRunId, MAX_REWORK);
    decision = streak >= MAX_REWORK
      ? { outcome: 'BLOCK', blockStatus: 'BLOCKED', agentRunStatus: 'FAILED', reason: 'missing_outputs_exceeded' }
      : { outcome: 'REWORK', agentRunStatus: 'SUCCESS', reason: `missing_outputs:${missingOut.join(',')}` };
  }
  // INTAKE-INTEGRATIONS-001: беспроектное обращение из канала «интеграции в
  // приложения». Приёмщик определил проект (verdict.fields.project) по каталогу
  // проектов — резолвим его, проставляем project_id (+ service) и входим в Architect.
  // Проект не разрешился → BLOCKED с диагностикой (обращение не теряется).
  if (claimed.role_code === 'TASK_INTAKE_OFFICER' && !claimed.project_id && decision.outcome === 'FORWARD') {
    return routeIntakeToProject(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, kpi });
  }
  // DECOMP-CONTRACT-001: успешный Декомпозитор не просто «forward» — он
  // МАТЕРИАЛИЗУЕТ из карточки задачи-на-сервис (L1) и подзадачи-на-файл (L2),
  // а сам эпик паркует в WAITING_FOR_CHILDREN. Только в линейном маршруте (в
  // граф-режиме fork/join расщепление делают узлы графа, не Декомпозитор).
  if (claimed.role_code === 'DECOMPOSER' && decision.outcome === 'FORWARD' && !claimed.current_stage_key) {
    return materializeDecomposition(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi });
  }

  // DECOMPOSER-REMOVE-001: Архитектор — последняя проектная роль перед Программистом.
  // Декомпозитор больше не материализует подзадачи с service_id, поэтому Архитектор при
  // форварде ГАРАНТИРУЕТ, что у задачи есть service_id (иначе claim_next_claude_task её
  // не выдаст — тихий висяк в CODING). Резолвим главный сервис из вердикта; если у задачи
  // service_id ещё нет и резолв не удался — BLOCKED с диагностикой, а не молчаливый висяк.
  // Объявлены здесь (не ниже), чтобы ветка MINI_ARCHITECT могла задать description work item.
  let setServiceId;
  let setDescription;
  let setTitle;
  let setPriority;
  if (claimed.role_code === 'ARCHITECT' && decision.outcome === 'FORWARD') {
    // ARCH-SERVICE-SPLIT-001: если разбивка Архитектора (normalizeWorkItems из
    // data_card + поля вердикта) затрагивает ДВА И БОЛЕЕ разных зарегистрированных
    // сервиса проекта — материализуем НЕЗАВИСИМЫЕ задачи по одной на сервис (каждая
    // идёт по конвейеру отдельно), а эпик паркуем в WAITING_FOR_CHILDREN. Иначе —
    // прежнее поведение: одна задача (ensureArchitectService; 0 сервисов → BLOCKED).
    const split = await resolveArchitectSplit(c, claimed, verdict.fields, cardValues);
    // ARCH-SPLIT-NO-RECURSION-001: расщепляем на независимые per-service задачи ТОЛЬКО
    // задачу верхнего уровня (parent_task_id IS NULL). Split-ребёнок (parent задан, создан
    // прежним расщеплением со своим service_id) при возврате к Архитектору по REWORK снова
    // выглядит «мультисервисным» — его карточка/описание всё ещё упоминают соседние сервисы,
    // — и прежде порождал новый эпик с детьми, те по REWORK расщеплялись опять: бесконечная
    // цепочка эпик→эпик→эпик (WAITING_FOR_CHILDREN, ничего не доходит до листа; инцидент
    // 10.07 — кластер quick_reply_id в PROJECT_2, ~17 вложенных эпиков). Такой ребёнок уже
    // сфокусирован на ОДНОМ сервисе — ведём его дальше одиночным путём (ensureArchitectService
    // резолвит его же service_id и форвардит к Programmer), а не расщепляем повторно.
    // ARCH-SIZE-ESCALATION-001: task_size — лишь ПОДСКАЗКА Приёмщика, а НЕ вето на
    // расщепление. Архитектор видит технический контекст глубже: если его разбивка
    // затронула ≥2 РАЗНЫХ зарегистрированных сервиса, расщепляем НЕЗАВИСИМО от
    // task_size (в т.ч. ошибочного small) — иначе неверный small от Приёмщика молча
    // склеил бы мультисервисную работу в одну задачу и часть сервисов осталась бы
    // нетронутой. Эскалацию фиксируем в карточке эпика (size_escalation: small →
    // large by architect) ради traceability. medium/large — прежнее поведение.
    const taskSize = taskSizeFromCard(claimed.data_card);
    if (split.services.length >= 2 && !claimed.parent_task_id) {
      if (taskSize === 'small') {
        cardValues.task_size = 'large';
        cardValues.size_escalation = {
          from: 'small', to: 'large', by: 'architect',
          reason: 'multi_service_scope', services: split.services.length,
          at: new Date().toISOString(),
        };
      }
      // SERVICE-REPO-PATH-PREFLIGHT-001: ту же проверку repository_path, что и на
      // одиночном пути (ensureArchitectService ниже), прогоняем по КАЖДОМУ сервису
      // split ДО материализации детей. Дочерние service-задачи создаются сразу в
      // статусе/роли следующего этапа (CODING/PROGRAMMER), поэтому без раннего
      // диагноза хотя бы один сервис без валидного пути дошёл бы до Pipeline лишь
      // ради «repository_path не задан/не найден», впустую заняв слоты Programmer.
      // Провал хотя бы одного сервиса → блокируем ЭПИК (детей НЕ создаём) с кодом
      // missing_repository_path и перечнем проблемных сервисов.
      const failed = [];
      const allowProjectRoot = isProjectScopeTask(parseDataCard(claimed));
      for (const svc of split.services) {
        const pf = await preflightServiceRepoPath(c, svc.serviceId, { allowProjectRoot });
        if (!pf.ok) failed.push({ code: svc.serviceCode, message: pf.message });
      }
      if (failed.length) {
        return blockClaimedReason(
          c, claimed,
          `missing_repository_path:${failed.map((f) => f.code).join(',')}`,
          {
            verdict, cardValues, kpi, event: 'missing_repository_path',
            detail: failed.map((f) => f.message).join('; '),
          },
        );
      }
      return materializeArchitectSplit(c, claimed, {
        verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi, split,
      });
    }
    const ensured = await ensureArchitectService(c, claimed, verdict.fields, cardValues);
    if (ensured.blocked) {
      return blockClaimedReason(c, claimed, ensured.reason, { verdict, cardValues, kpi, event: 'architect_no_service' });
    }
    // SERVICE-REPO-PATH-PREFLIGHT-001: repository_path эффективного сервиса ОБЯЗАН
    // быть задан и указывать на существующий каталог ДО перехода в CODING. Раньше это
    // ловил только claim PIPELINE_SERVICE — задачу успевали прогнать через Architect и
    // Programmer, и она падала лишь на Pipeline с тем же диагнозом, впустую тратя слоты.
    // Сервис без пути/с несуществующим каталогом → BLOCKED c кодом missing_repository_path.
    // PROJECT-SCOPE-TASK-001: read-only/audit — не блокируем, исполнится из корня проекта.
    const preflight = await preflightServiceRepoPath(c, ensured.resolvedServiceId,
      { allowProjectRoot: isProjectScopeTask(parseDataCard(claimed)) });
    if (!preflight.ok) {
      return blockClaimedReason(c, claimed, preflight.reason, {
        verdict, cardValues, kpi, event: 'missing_repository_path', detail: preflight.message,
      });
    }
    setServiceId = ensured.serviceId; // uuid, либо undefined если service_id уже задан
    // TASK-ROUTER-001 (item 7): доливаем структурированные артефакты Архитектора
    // (критерии приёмки/границы/план/риски) в ХВОСТ описания задачи — Программист/Ревьюер
    // получают конкретику через «## Task Description», не только summary. Пусто → не трогаем.
    const archArtifacts = renderWorkArtifactSections(verdict.fields);
    if (archArtifacts) {
      const base = String(claimed.description ?? '').trim();
      setDescription = (base ? `${base}\n\n${archArtifacts}` : archArtifacts).slice(0, 20000);
    }
  }

  // TASK-ROUTER-001: Task Router кладёт выбранный контур в карточку. route — ГЛАВНОЕ
  // решение (small|medium|large); синхронно проставляем task_size = route, чтобы guard
  // пропуска Reviewer (shouldSkipReviewerForSmallTask) и эскалация Архитектора читали
  // единый сигнал. Условную развилку (small → MINI_ARCHITECT, иначе → ARCHITECT) уже
  // несёт decision.branchLabel (метка ветки графа, см. decideOutcome/graphRoute).
  if (claimed.role_code === 'TASK_ROUTER' && decision.outcome === 'FORWARD') {
    const route = normalizeTaskRoute(verdict.fields?.route ?? cardValues?.route);
    cardValues.route = route;
    cardValues.task_size = route; // route ↔ task_size 1:1 (единый домен small|medium|large)
    const conf = verdict.fields?.route_confidence ?? cardValues?.route_confidence;
    const confStr = typeof conf === 'string' && conf.trim() ? conf.trim().slice(0, 40) : null;
    if (confStr) cardValues.route_confidence = confStr;
    const rreason = verdict.fields?.route_reason ?? cardValues?.route_reason;
    if (typeof rreason === 'string' && rreason.trim()) cardValues.route_reason = rreason.trim().slice(0, 2000);
    cardValues.route_decision = { route, confidence: confStr, by: 'task_router', at: new Date().toISOString() };
  }

  // TASK-ROUTER-001: MINI_ARCHITECT — облегчённый архитектор small-контура. Как и полный
  // Архитектор, он ОБЯЗАН гарантировать service_id перед CODING (иначе claim_next_claude_task
  // не выдаст задачу — тихий висяк), НО он НЕ расщепляет (small = один сервис). Резолвим
  // сервис тем же ensureArchitectService; если у задачи ещё нет service_id, подсказываем его
  // из target_service вердикта (или service-классификации Приёмщика) work_items-хинтом.
  if (claimed.role_code === 'MINI_ARCHITECT' && decision.outcome === 'FORWARD') {
    const svcHint = [verdict.fields?.target_service, cardValues?.target_service, cardValues?.service]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v && !/^unknown$/i.test(v)) || '';
    const fieldsForService = { ...asObject(verdict.fields) };
    if (svcHint && !Array.isArray(fieldsForService.work_items)) {
      fieldsForService.work_items = [{ serviceCode: svcHint, title: 'small task', files: [] }];
    }
    const ensured = await ensureArchitectService(c, claimed, fieldsForService, cardValues);
    if (ensured.blocked) {
      return blockClaimedReason(c, claimed, ensured.reason, { verdict, cardValues, kpi, event: 'mini_architect_no_service' });
    }
    const preflight = await preflightServiceRepoPath(c, ensured.resolvedServiceId,
      { allowProjectRoot: isProjectScopeTask(parseDataCard(claimed)) });
    if (!preflight.ok) {
      return blockClaimedReason(c, claimed, preflight.reason, {
        verdict, cardValues, kpi, event: 'missing_repository_path', detail: preflight.message,
      });
    }
    setServiceId = ensured.serviceId; // uuid, либо undefined если service_id уже задан
    // TASK-ROUTER-001 (item 7): даём Программисту сфокусированный work item в описании
    // задачи (task.description → «## Task Description» в промте раннера), а не только
    // summary в priorRoleOutputs. Не раздуваем: work_item + область + критерии + границы.
    const workItem = typeof verdict.fields?.work_item === 'string' ? verdict.fields.work_item.trim() : '';
    if (workItem) {
      const area = typeof verdict.fields?.target_area === 'string' ? verdict.fields.target_area.trim() : '';
      const parts = [workItem];
      if (area) parts.push(`## Область\n${area}`);
      const artifacts = renderWorkArtifactSections(verdict.fields);
      if (artifacts) parts.push(artifacts);
      setDescription = parts.join('\n\n').slice(0, 20000);
    }
  }

  // DECOMPOSER-REMOVE-001: Приёмщик кладёт развёрнутое описание (structured_description)
  // в tasks.description — чтобы Архитектор и карточка задачи видели полный контекст, а не
  // только заголовок, пришедший при создании задачи.
  // TASK-INTAKE-COMMIT-001: он же кладёт человекочитаемое название (short_title →
  // task_title) в tasks.title — чтобы весь конвейер, карточка задачи и коммит
  // Git Integrator использовали название, придуманное Приёмщиком, а не сырой заголовок.
  // TASK-PRIORITY-SCALE-001: Приёмщик выставляет пользовательский приоритет (fields.priority
  // 1..3). Форс сервера: проект оркестратора → всегда 0 (роль/значение игнорируем); иначе
  // применяем нормализованный fields.priority, а если роль его не задала — не трогаем.
  // (setDescription/setTitle/setPriority объявлены выше — их задают MINI_ARCHITECT и Приёмщик.)
  if (claimed.role_code === 'TASK_INTAKE_OFFICER') {
    // TASK-SIZE-TRIAGE-001: нормализуем размер задачи (Приёмщик оценил fields.task_size);
    // отсутствие/мусор → medium. Пишем в кумулятивную карточку — по нему триаж пропускает
    // Reviewer для small (acceptScannerCompletionTx) и подавляет расщепление Архитектора.
    cardValues.task_size = normalizeTaskSize(verdict.fields?.task_size ?? cardValues?.task_size);
    const dd = verdict.fields?.structured_description ?? cardValues?.structured_description;
    if (typeof dd === 'string' && dd.trim()) setDescription = dd.trim().slice(0, 20000);
    const tt = verdict.fields?.short_title ?? cardValues?.short_title
      ?? verdict.fields?.task_title ?? cardValues?.task_title;
    if (typeof tt === 'string' && tt.trim()) setTitle = tt.trim().slice(0, 300);
    if (claimed.project_id) {
      const projRow = await c.query('SELECT code, root_path FROM projects WHERE id = $1', [claimed.project_id]);
      const proj = projRow.rows[0] ?? null;
      if (isOrchestratorProject(proj)) {
        setPriority = 0;
      } else {
        const reqPr = verdict.fields?.priority ?? cardValues?.priority;
        if (reqPr !== null && reqPr !== undefined && reqPr !== '') setPriority = normalizeClientPriority(reqPr);
      }
    }
  }

  // DOCS-DEBT-001: фиксация документационного долга ради наблюдаемости. При
  // BLOCKED-вердикте DOCUMENTATION_AUDITOR/KEEPER decideOutcome сознательно НЕ
  // блокирует основной поток (docForward, reason='docs_blocked_forwarded' — ветка
  // документации мягко идёт к join, чтобы не держать родителя, см. roleEngine.js).
  // Поток и маршрутизацию НЕ меняем — только помечаем долг в data_card: открываем
  // его при мягком проходе и гасим (resolved) при обычном успешном FORWARD той же
  // роли (документацию довели позже). Флаг мёржится существующим UPDATE tasks
  // (data_card = data_card || $4::jsonb) в finalizeRole.
  if ((claimed.role_code === 'DOCUMENTATION_AUDITOR' || claimed.role_code === 'DOCUMENTATION_KEEPER')
    && decision.outcome === 'FORWARD') {
    cardValues.docs_debt = {
      role: claimed.role_code,
      reason: verdict.summary || decision.reason,
      status: decision.reason === 'docs_blocked_forwarded' ? 'open' : 'resolved',
      at: new Date().toISOString(),
    };
  }

  // FORK-JOIN-001: задача с current_stage_key идёт ПО РЁБРАМ графа (граф-режим);
  // без него — прежняя позиционная маршрутизация (линейные схемы не затронуты).
  const resolved = claimed.current_stage_key
    ? await resolveGraphTransition(c, claimed, decision)
    : resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    });
  return finalizeRole(c, claimed, {
    verdict, response, exchangeId, durationMs, decision, resolved, cardValues, kpi, setServiceId, setDescription, setTitle, setPriority,
  });
}

// INTAKE-INTEGRATIONS-001 — маршрутизация беспроектного обращения после Приёмщика.
// Приёмщик определил проект (verdict.fields.project) по каталогу проектов. Резолвим
// его в зарегистрированный проект, проставляем project_id (+ service_id, если сервис
// назван и существует) и входим в Architect (ARCHITECTURE), кладём карточку интейка,
// развёрнутое описание и человекочитаемое название. Проект не разрешился → BLOCKED с
// диагностикой (обращение остаётся под Приёмщиком, видно причину — не теряется).
async function routeIntakeToProject(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, kpi = null }) {
  const pick = (...vals) => {
    for (const v of vals) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t && !/^unknown$/i.test(t)) return t;
    }
    return '';
  };
  const projectRef = pick(verdict.fields?.project, cardValues?.project);
  const project = projectRef ? await findProject(c, projectRef) : null;
  if (!project) {
    return blockClaimedReason(c, claimed, `intake_project_unresolved:${projectRef || 'empty'}`,
      { verdict, cardValues, kpi, event: 'intake_project_unresolved' });
  }

  // Вход в Architect (или безопасный откат к штатному входу, если этапа Architect нет).
  const entry = await computeEntry(c, project.id, 'ARCHITECT');

  // Сервис — опционально: если Приёмщик назвал зарегистрированный сервис проекта.
  let serviceId = null;
  const svcRef = pick(verdict.fields?.service, cardValues?.service);
  if (svcRef) {
    const svc = await c.query(
      'SELECT id FROM services WHERE project_id = $1 AND lower(service_code) = lower($2) LIMIT 1',
      [project.id, svcRef],
    );
    serviceId = svc.rows[0]?.id ?? null;
  }

  // Развёрнутое описание/название от Приёмщика — как в обычном форварде Приёмщика.
  const dd = verdict.fields?.structured_description ?? cardValues?.structured_description;
  const setDescription = typeof dd === 'string' && dd.trim() ? dd.trim().slice(0, 20000) : null;
  const tt = verdict.fields?.short_title ?? cardValues?.short_title
    ?? verdict.fields?.task_title ?? cardValues?.task_title;
  const setTitle = typeof tt === 'string' && tt.trim() ? tt.trim().slice(0, 300) : null;
  // TASK-PRIORITY-SCALE-001: приоритет форсим/нормализуем СЕРВЕРОМ по разрешённому
  // проекту (оркестратор → 0; иначе fields.priority 1..3 или дефолт 2).
  const newPriority = computeTaskPriority(project, verdict.fields?.priority ?? cardValues?.priority);

  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) { await c.query('ROLLBACK'); return null; }
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: cur.rows[0].status, alreadyFinalized: true };
    }

    // TASK-SIZE-TRIAGE-001: нормализуем размер и для беспроектного интейка (тот же
    // триаж, что и в обычном форварде Приёмщика) — small пропустит Reviewer ниже по маршруту.
    const mergedCard = {
      ...(cardValues || {}), project: project.code, projectPath: project.root_path,
      task_size: normalizeTaskSize(verdict.fields?.task_size ?? cardValues?.task_size),
    };
    const sets = [
      'project_id = $2', 'status = $3::task_status', 'current_role_id = $4',
      'current_stage_key = $5::uuid', 'assigned_agent_id = NULL', 'data_card = data_card || $6::jsonb',
    ];
    const params = [claimed.id, project.id, entry.status, entry.role.id, entry.entryStageKey ?? null,
      JSON.stringify(mergedCard)];
    params.push(newPriority); sets.push(`priority = $${params.length}::smallint`);
    if (serviceId) { params.push(serviceId); sets.push(`service_id = $${params.length}::uuid`); }
    if (setDescription) { params.push(setDescription); sets.push(`description = $${params.length}`); }
    if (setTitle) { params.push(setTitle); sets.push(`title = $${params.length}`); }
    await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);

    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, outcome: 'FORWARD',
        reason: 'intake_project_resolved', project: project.code, fields: cardValues,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, $3::task_status, $4, $5::jsonb)`,
      [claimed.id, claimed.status, entry.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, source: 'intake-integration',
        project: project.code, nextRole: entry.role.code, outcome: 'FORWARD', exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: entry.status, nextRole: entry.role.code, project: project.code,
      verdict: verdict.status, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// DECOMPOSER-REMOVE-001 — гарантировать service_id у задачи Архитектора перед CODING.
// service_id уже задан (напр. при создании/форке) → { serviceId: undefined } (форвардим как
// есть). Иначе резолвим ГЛАВНЫЙ сервис из вердикта Архитектора (affected_services/work_items →
// первый зарегистрированный сервис проекта). Не удалось → { blocked, reason }.
async function ensureArchitectService(c, claimed, verdictFields, cardValues) {
  const cur = await c.query('SELECT service_id FROM tasks WHERE id = $1', [claimed.id]);
  // resolvedServiceId — ЭФФЕКТИВНЫЙ сервис задачи (уже заданный ИЛИ вновь резолвнутый),
  // нужен для раннего preflight repository_path (SERVICE-REPO-PATH-PREFLIGHT-001);
  // serviceId остаётся undefined, когда обновлять service_id в finalizeRole не нужно.
  if (cur.rows[0]?.service_id) return { serviceId: undefined, resolvedServiceId: cur.rows[0].service_id };

  const card = {
    ...(parseDataCard(claimed)),
    ...(asObject(verdictFields)),
    ...(cardValues || {}),
  };
  const plan = normalizeWorkItems(card); // [{ serviceCode, ... }] из work_items/affected_files
  const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
  const byCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
  for (const item of plan) {
    const sid = byCode.get(String(item.serviceCode).toLowerCase());
    if (sid) return { serviceId: sid, resolvedServiceId: sid };
  }
  const attempted = plan.map((p) => p.serviceCode).filter(Boolean);
  return { blocked: true, reason: `architect_no_service:${attempted.join(',') || 'empty'}` };
}

// SERVICE-REPO-PATH-PREFLIGHT-001 — ранний диагноз отсутствующего/невалидного
// repository_path сервиса. Та же проверка, что и в claim PIPELINE_SERVICE
// (resolveServiceRepoPath), но выполняется на финализации Архитектора — ДО того как
// задача займёт слоты Programmer и дойдёт до Pipeline лишь ради того же диагноза.
// Инцидент: PIPELINE_SERVICE падал поздно с «repository_path не задан/не найден»
// (CHAT, auth-registration), успев прогнать задачу через Architect и Programmer.
// Читает repository_path/код сервиса и корень проекта, прогоняет через
// resolveServiceRepoPath (логику НЕ дублируем — переиспользуем). Ветка
// CONTAINER-FS-DEGRADE-001 сохранена: безопасный непустой путь доверяем (реальную
// проверку сделает host-runner на хосте), пустой/NULL/небезопасный — провал.
// ВАЖНО: claim на хосте при пустом/невалидном сохранённом пути делает бэкфилл
// каталога по КОДУ сервиса (findServiceDirByCode) и продолжает — resolveServiceRepoPath
// в этом случае возвращает { ok:true, changed:true }. Для РАННЕГО диагноза такой
// бэкфилл — это как раз missing_repository_path: в реестре путь фактически не задан,
// а угадывание по коду каталога маскирует проблему (подтверждённый провал ревью:
// repository_path=NULL + рядом каталог с именем=service_code проходил как ok). Поэтому
// принимаем ТОЛЬКО валидный сохранённый путь (changed:false); бэкфилл (changed:true)
// трактуем как провал. Возвращает { ok: true } либо { ok: false, code, reason, message }.
// Только чтение.
// PROJECT-SCOPE-TASK-001 — задача уровня проекта (read-only/аудит) исполняется из
// КОРНЯ проекта: отдельный каталог сервиса ей не нужен (программист и так работает из
// projects.root_path через repoResolver, а пустой repository_path в
// buildPipelineClaimContract даёт workingDirectory=projectRoot). Признаём по ЯВНЫМ
// маркерам карточки — read_only=true / scope='project' / task_type содержит 'audit'
// (значения 'audit' нет в штатном словаре task_type → это осознанный маркер аудита).
export function isProjectScopeTask(card) {
  const c = asObject(card);
  if (c.read_only === true || c.readOnly === true) return true;
  if (typeof c.scope === 'string' && c.scope.trim().toLowerCase() === 'project') return true;
  const tt = c.task_type;
  const types = Array.isArray(tt) ? tt : (typeof tt === 'string' ? [tt] : []);
  return types.some((t) => String(t).trim().toLowerCase() === 'audit');
}

export async function preflightServiceRepoPath(c, serviceId, opts = {}) {
  if (!serviceId) return { ok: true };
  const row = await c.query(
    `SELECT s.service_code, s.repository_path, p.root_path
       FROM services s JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1`,
    [serviceId],
  );
  const svc = row.rows[0];
  if (!svc) return { ok: true }; // сервис не найден — не наша ветка диагноза
  const resolved = resolveServiceRepoPath(svc.root_path, svc.service_code, svc.repository_path);
  if (resolved.ok && !resolved.changed) return { ok: true };
  // PROJECT-SCOPE-TASK-001: read-only/audit задача уровня проекта исполняется из корня
  // проекта — отсутствующий/неразрешённый repository_path сервиса её не блокирует.
  if (opts.allowProjectRoot) return { ok: true, projectRoot: true };
  const code = String(svc.service_code ?? '').trim() || '(без кода)';
  return {
    ok: false,
    code: 'missing_repository_path',
    reason: `missing_repository_path:${code}`,
    message: `сервис ${code}: repository_path не задан или каталог сервиса не найден — `
      + 'укажите корректный repository_path сервиса в реестре сервисов проекта и верните задачу в работу',
  };
}

// ARCH-SERVICE-SPLIT-001 — резолвим разбивку Архитектора в РАЗНЫЕ зарегистрированные
// сервисы проекта (регистронезависимо). Источник карточки — data_card задачи + поля
// вердикта Архитектора + cardValues (как в ensureArchitectService). Возвращает
// { card, services:[{ serviceId, serviceCode, title, files }], unresolved:[serviceCode],
// byCode }. services дедуплицированы по serviceId — несколько work_items одного сервиса
// сливаются (файлы объединяются, заголовок берём первый). Только чтение services.
export async function resolveArchitectSplit(c, claimed, verdictFields, cardValues) {
  const card = {
    ...(parseDataCard(claimed)),
    ...(asObject(verdictFields)),
    ...(cardValues || {}),
  };
  const plan = normalizeWorkItems(card);
  const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
  const byCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
  const byId = new Map();
  const unresolved = [];
  for (const item of plan) {
    const sid = byCode.get(String(item.serviceCode).toLowerCase());
    if (!sid) { unresolved.push(item.serviceCode); continue; }
    if (byId.has(sid)) byId.get(sid).files.push(...item.files);
    else byId.set(sid, { serviceId: sid, serviceCode: item.serviceCode, title: item.title, files: [...item.files] });
  }
  return { card, services: Array.from(byId.values()), unresolved, byCode };
}

// ARCH-SERVICE-SPLIT-001 — карточка дочерней задачи: карточка родителя, но work_items
// и affected_files оставлены ТОЛЬКО для указанного сервиса (код резолвится по byCode
// регистронезависимо к serviceId ребёнка). Прочие поля карточки сохраняются как есть.
function filterCardForService(card, byCode, serviceId) {
  const belongs = (code) => byCode.get(String(code ?? '').trim().toLowerCase()) === serviceId;
  const workItems = jsonArray(card?.work_items).filter((it) => belongs(it?.serviceCode ?? it?.service));
  const affectedFiles = jsonArray(card?.affected_files).filter((f) => belongs(f?.serviceCode ?? f?.service));
  return { ...card, work_items: workItems, affected_files: affectedFiles };
}

// DECOMPOSER-REMOVE-001 — заблокировать задачу с понятной причиной, СОХРАНИВ роль
// (current_role_id не обнуляем — задача остаётся видимой под своей ролью как BLOCKED).
// Прогон роли помечаем SUCCESS (роль отработала; блок — из-за нерезолвимых данных).
async function blockClaimedReason(c, claimed, reason, { verdict, cardValues, kpi = null, event = 'blocked', detail = null } = {}) {
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason, alreadyFinalized: true };
    }
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict?.status, summary: verdict?.summary, reason, outcome: 'BLOCK', fields: cardValues,
        ...(detail ? { detail } : {}),
      }), ...kpiSet.params],
    );
    await c.query(
      `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, reason, event,
        ...(detail ? { detail } : {}),
      })],
    );
    await c.query('COMMIT');
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// DECOMP-CONTRACT-001 — нормализовать разбивку работы из карточки к виду
// [{ serviceCode, title, files: [{ path, what }] }]. Источник: work_items (если
// заполнил Архитектор/Декомпозитор), иначе группировка affected_files по сервису.
// Поля контракта с valueType=json модель по инструкции возвращает JSON-СТРОКОЙ
// (fieldJsonSchema/buildVerdictInstruction: «JSON serialized as a string»), поэтому
// принимаем и готовый массив, и его строковую сериализацию.
export function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeWorkItems(card) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const items = jsonArray(card?.work_items);
  const norm = [];
  for (const it of items) {
    const serviceCode = str(it?.serviceCode || it?.service);
    if (!serviceCode) continue;
    const files = jsonArray(it?.files)
      .map((f) => ({ path: str(f?.path), what: str(f?.what || f?.instruction) }))
      .filter((f) => f.path);
    norm.push({ serviceCode, title: str(it?.title) || `Изменения в ${serviceCode}`, files });
  }
  if (norm.length) return norm;
  // Фолбэк: собрать work_items из affected_files (плоский список) по serviceCode.
  const files = jsonArray(card?.affected_files);
  const byService = new Map();
  for (const f of files) {
    const serviceCode = str(f?.serviceCode || f?.service);
    const path = str(f?.path);
    if (!serviceCode || !path) continue;
    if (!byService.has(serviceCode)) byService.set(serviceCode, []);
    byService.get(serviceCode).push({ path, what: str(f?.what || f?.instruction) });
  }
  return Array.from(byService.entries()).map(([serviceCode, fs]) => ({
    serviceCode, title: `Изменения в ${serviceCode}`, files: fs,
  }));
}

// JOIN-PLANNED-COVERAGE-001 — целевой список сервисов эпика (декларированный scope
// Архитектора). Источник — affected_services вердикта Архитектора, ОБЪЕДИНЁННЫЙ с
// serviceCode из work_items. Это устойчиво к усечению work_items капами/таймаутами,
// из-за которого терялись заявленные фронты (B1: Smeta/FastTable). Коды резолвим к
// каноническим service_code зарегистрированных сервисов проекта (регистронезависимо,
// canonicalByCode: lower(code)→service_code), дедуплицируем. Незарегистрированные
// коды отбрасываем — сверять покрытие можно только по реально существующим сервисам.
export function computePlannedServices(card, canonicalByCode) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const codes = [];
  for (const it of jsonArray(card?.affected_services)) {
    const code = typeof it === 'string' ? str(it) : str(it?.serviceCode || it?.service);
    if (code) codes.push(code);
  }
  for (const it of normalizeWorkItems(card)) {
    if (it.serviceCode) codes.push(it.serviceCode);
  }
  const out = [];
  const seen = new Set();
  for (const code of codes) {
    const canonical = canonicalByCode.get(code.toLowerCase());
    if (!canonical) continue;
    const key = String(canonical).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

// PROGRAMMER-CONTRACT-BARRIER-001 — очерёдность «общий контракт раньше потребителей».
// Если ровно ОДИН сервис декомпозиции владеет общим контрактом (proto), сервисы-
// потребители ждут его интеграции: их L2-подзадачи получают зависимость от L1
// владельца (task_dependencies), а гейт claim (claimNextClaudeTaskTx) не выдаёт
// подзадачу с активной зависимостью. Иначе гонка: потребитель правит по СТАРОМУ
// сгенерированному коду, пока владелец регенерирует контракт (инцидент 23.07
// «партнёр в чате»: agent_reported_failure «незавершённая регенерация
// proto-contracts/chat»). Клапан: PROGRAMMER_CONTRACT_BARRIER=0/false/off.
const CONTRACT_BARRIER_ENABLED = !/^(0|false|off)$/i.test(String(process.env.PROGRAMMER_CONTRACT_BARRIER ?? '').trim());

// Путь ИСХОДНИКА общего контракта (proto-файл / его каталог). Сгенерированный код
// (`*.pb.go` и т.п.) намеренно НЕ считаем: владельца определяет правка исходника
// контракта, а сгенерированный код правит и потребитель. Нормализуем слэши/регистр.
export function isContractPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').toLowerCase();
  if (!s) return false;
  return s.endsWith('.proto')
    || s.includes('proto-contracts/')
    || /(^|\/)proto\//.test(s);
}

// Индекс ЕДИНСТВЕННОГО элемента-владельца контракта среди work-items декомпозиции.
// 0 совпадений → контракта нет; ≥2 → неоднозначно (не рискуем неверной очерёдностью,
// барьер не ставим); ровно 1 → его индекс. items[i].files = [{ path, what }].
export function detectContractOwnerIndex(items) {
  const list = Array.isArray(items) ? items : [];
  const owners = [];
  for (let i = 0; i < list.length; i += 1) {
    const files = Array.isArray(list[i]?.files) ? list[i].files : [];
    if (files.some((f) => isContractPath(f?.path))) owners.push(i);
  }
  return owners.length === 1 ? owners[0] : -1;
}

// PATH-INTERSECTION-BARRIER-001 — обобщение proto-барьера на НЕПРЯМЫЕ пересечения:
// две подзадачи РАЗНЫХ сервисов одного эпика, правящие ОДИН И ТОТ ЖЕ не-контрактный
// файл (монорепо-библиотеки packages/*, platform/* и т.п.), нельзя писать
// параллельно — иначе те же гонки cherry_pick_failed, что proto-барьер чинит только
// для контракта. Сериализуем их цепочкой task_dependencies; тот же гейт claim их
// соблюдает, а BLOCKED/терминал предшественника отпускает следующего — без дедлока.
//
// По умолчанию ВЫКЛЮЧЕНО: механизм не обкатан на живом многосервисном пакете, а это
// правка живого планировщика. Включение — PROGRAMMER_PATH_BARRIER=1/true/on (опт-ин
// поверх уже включённого по умолчанию proto-барьера). Проверяется на КАЖДЫЙ вызов
// (не модульная константа), чтобы клапан можно было менять без перезапуска демона.
export function pathIntersectionBarrierEnabled() {
  return /^(1|true|on)$/i.test(String(process.env.PROGRAMMER_PATH_BARRIER ?? '').trim());
}

// Ключ пути для сравнения пересечений: нормализуем слэши/регистр/пробелы, срезаем
// ведущее `./` и хвостовой `/`. Контрактные и пустые пути обрабатываются отдельно.
export function normalizePathKey(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// По списку подзадач [{ id, path }] вернуть рёбра сериализации: для каждой группы
// подзадач с ОДНИМ И ТЕМ ЖЕ не-контрактным непустым путём — цепочка по порядку
// поступления (строгая сериализация A→B→C, а НЕ звезда: иначе B и C всё равно
// гоняются за файл). Контрактные пути пропускаем (их держит proto-барьер), пустые
// (подзадача-на-весь-сервис, нет файловой гранулярности) — тоже. Рёбра всегда идут
// от большего индекса к меньшему ⇒ это DAG без циклов. Возврат: [{ taskId, dependsOn }].
export function computePathIntersectionDeps(items) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const key = normalizePathKey(list[i]?.path);
    if (!key || isContractPath(key)) continue;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  const edges = [];
  for (const idxs of groups.values()) {
    for (let k = 1; k < idxs.length; k += 1) {
      const cur = list[idxs[k]];
      const prev = list[idxs[k - 1]];
      if (cur?.id && prev?.id && cur.id !== prev.id) {
        edges.push({ taskId: cur.id, dependsOn: prev.id });
      }
    }
  }
  return edges;
}

// DECOMP-CONTRACT-001 — материализация декомпозиции эпика в задачи-на-сервис (L1)
// и подзадачи-на-файл (L2). Один txn. Идемпотентно: если у эпика уже есть дети,
// повторно не создаём. Эпик паркуется в WAITING_FOR_CHILDREN. Если из карточки не
// удалось получить ни одного зарегистрированного сервиса — эпик уходит в BLOCKED с
// диагностикой (не молча зависает).
export async function materializeDecomposition(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi = null }) {
  const card = { ...(parseDataCard(claimed)), ...(cardValues || {}) };
  const plan = normalizeWorkItems(card);

  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении
    // (ack COMMIT предыдущей попытки мог потеряться при обрыве) — прогон уже не RUNNING.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_finalized', durationMs };
    }
    // Идемпотентность: эпик уже расщеплён — финализируем прогон без дублей.
    const hasChildren = await c.query('SELECT 1 FROM tasks WHERE parent_task_id = $1 LIMIT 1', [claimed.id]);
    if (hasChildren.rowCount) {
      const kpiSet0 = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet0.sql} WHERE id = $1`,
        [claimed.agentRunId, JSON.stringify({ status: verdict.status, summary: verdict.summary, reason: 'already_decomposed' }), ...kpiSet0.params],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_decomposed', durationMs };
    }

    // Резолвим коды сервисов проекта (нечувствительно к регистру).
    const svcRows = await c.query('SELECT id, service_code FROM services WHERE project_id = $1', [claimed.project_id]);
    const svcByCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.id]));
    const resolved = [];
    const unresolved = [];
    for (const item of plan) {
      const sid = svcByCode.get(item.serviceCode.toLowerCase());
      if (sid) resolved.push({ ...item, serviceId: sid });
      else unresolved.push(item.serviceCode);
    }

    // Нет ни одного зарегистрированного сервиса → BLOCKED с диагностикой.
    if (!resolved.length) {
      const kpiSetF = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2${kpiSetF.sql} WHERE id = $1`,
        [claimed.agentRunId, `decomposition_no_services: ${unresolved.join(', ') || 'пустая разбивка'}`, ...kpiSetF.params],
      );
      await c.query(
        `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
        [claimed.id],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
          runner: true, ai: true, role: 'DECOMPOSER', reason: 'decomposition_no_services', unresolved,
        })],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason: 'decomposition_no_services' };
    }

    const programmerRole = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
    const programmerRoleId = programmerRole.rows[0]?.id ?? null;
    const baseCard = JSON.stringify(card);
    let serviceCount = 0;
    let subtaskCount = 0;
    const createdServices = [];
    // Плоский список ВСЕХ созданных подзадач с путями — для path-барьера (сериализация
    // подзадач разных сервисов, правящих один и тот же не-контрактный файл).
    const allSubtasks = [];

    for (const item of resolved) {
      // L1 — задача-на-сервис: единица приёмки. Пока есть подзадачи — ждёт их.
      const l1 = await c.query(
        `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                            status, current_role_id, created_by, data_card)
         VALUES ($1, $2, $3, 'service', $4, $5, 'WAITING_FOR_CHILDREN', $6, 'decomposer', $7::jsonb)
         RETURNING id`,
        [claimed.project_id, item.serviceId, claimed.id, item.title, claimed.description ?? '',
         programmerRoleId, baseCard],
      );
      const l1Id = l1.rows[0].id;
      serviceCount += 1;
      const subtaskIds = [];
      await c.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [claimed.id, l1Id],
      );

      // L2 — подзадачи-на-файл (по одной клеймит программист). Без файлов — одна
      // подзадача на весь сервис (чтобы программисту было что взять).
      const files = item.files.length ? item.files : [{ path: '', what: item.title }];
      for (const f of files) {
        const childCard = JSON.stringify({ ...card, service: item.serviceCode, file: f.path, instruction: f.what });
        const subTitle = f.path ? `${item.serviceCode}: ${f.path}` : item.title;
        const sub = await c.query(
          `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                              status, current_role_id, created_by, data_card)
           VALUES ($1, $2, $3, 'subtask', $4, $5, 'CODING', $6, 'decomposer', $7::jsonb)
           RETURNING id`,
          [claimed.project_id, item.serviceId, l1Id, subTitle, f.what || item.title,
           programmerRoleId, childCard],
        );
        subtaskIds.push(sub.rows[0].id);
        allSubtasks.push({ id: sub.rows[0].id, path: f.path });
        subtaskCount += 1;
      }
      // Параллельно resolved: индекс createdServices == индекс resolved (для барьера).
      createdServices.push({ id: l1Id, serviceCode: item.serviceCode, subtaskIds });
    }

    // PROGRAMMER-CONTRACT-BARRIER-001: ровно один сервис владеет общим контрактом
    // (proto) → его L1 становится зависимостью для L2-подзадач сервисов-потребителей.
    // Гейт claim (claimNextClaudeTaskTx) не выдаёт подзадачу с активной зависимостью,
    // пока контракт не интегрирован (L1 владельца → терминал/BLOCKED). Барьер-
    // зависимости ставятся ТОЛЬКО на subtask'и — fork/epic-связи их не затрагивают.
    let contractBarrier = null;
    if (CONTRACT_BARRIER_ENABLED && createdServices.length > 1) {
      const ownerIdx = detectContractOwnerIndex(resolved);
      if (ownerIdx >= 0) {
        const ownerL1 = createdServices[ownerIdx].id;
        let deps = 0;
        for (let i = 0; i < createdServices.length; i += 1) {
          if (i === ownerIdx) continue;
          for (const subId of createdServices[i].subtaskIds) {
            await c.query(
              `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
               ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
              [subId, ownerL1],
            );
            deps += 1;
          }
        }
        if (deps > 0) {
          contractBarrier = { ownerService: createdServices[ownerIdx].serviceCode, ownerTaskId: ownerL1, deps };
        }
      }
    }

    // PATH-INTERSECTION-BARRIER-001 (опт-ин): сериализуем подзадачи, правящие один и
    // тот же не-контрактный файл (монорепо-библиотеки), цепочкой task_dependencies.
    // Дополняет proto-барьер (тот покрывает только контракт). По умолчанию выключено.
    let pathBarrier = null;
    if (pathIntersectionBarrierEnabled() && allSubtasks.length > 1) {
      const edges = computePathIntersectionDeps(allSubtasks);
      let added = 0;
      for (const e of edges) {
        await c.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
           ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
          [e.taskId, e.dependsOn],
        );
        added += 1;
      }
      if (added > 0) pathBarrier = { sharedPathDeps: added };
    }

    // JOIN-PLANNED-COVERAGE-001: фиксируем целевой список сервисов эпика в data_card,
    // чтобы роллап (advanceDecompositionParents) сверял фактических детей с заявленным
    // scope и не закрывал эпик DONE при потерянных фронтах.
    const canonicalByCode = new Map(svcRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.service_code]));
    const plannedServices = computePlannedServices(card, canonicalByCode);
    // Эпик: помечаем видом, паркуем на детях, доливаем карточку Декомпозитора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify({
        ...(cardValues || {}), planned_services: plannedServices,
        ...(contractBarrier ? { contract_barrier: contractBarrier } : {}),
        ...(pathBarrier ? { path_barrier: pathBarrier } : {}),
      })],
    );
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: 'decomposed', outcome: decision.outcome, fields: cardValues,
        services: serviceCount, subtasks: subtaskCount, unresolved,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: 'DECOMPOSER', reason: 'decomposed', verdictStatus: verdict.status,
        summary: verdict.summary, services: createdServices, subtasks: subtaskCount, unresolved, exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: 'WAITING_FOR_CHILDREN', nextRole: 'PROGRAMMER', verdict: verdict.status,
      services: serviceCount, subtasks: subtaskCount, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// ARCH-SERVICE-SPLIT-001 — расщепление мультисервисной задачи Архитектора на
// НЕЗАВИСИМЫЕ задачи по сервисам. Вызывается из applyReasoningVerdict (ветка
// ARCHITECT + FORWARD), когда разбивка Архитектора затрагивает ≥2 РАЗНЫХ
// зарегистрированных сервиса. Один txn (по образцу materializeDecomposition). Для
// каждого сервиса создаётся самостоятельная задача-на-сервис (task_kind='service',
// parent = исходная задача, свой service_id, свой раздел описания и отфильтрованная
// карточка), которая входит в маршрут FORWARD-переходом Архитектора и идёт по
// конвейеру ОТДЕЛЬНО (дети друг от друга не зависят). Исходная задача становится
// эпиком (WAITING_FOR_CHILDREN) и закрывается роллапом advanceDecompositionParents
// после завершения всех детей. Идемпотентно: есть дети → финал прогона
// reason='already_decomposed'. Нерезолвленные serviceCode уходят в unresolved
// события — задач по ним не создаём.
export async function materializeArchitectSplit(c, claimed, { verdict, response, exchangeId, durationMs, decision, cardValues, route, kpi = null, split = null }) {
  const { card, services, unresolved, byCode } = split ?? await resolveArchitectSplit(c, claimed, verdict.fields, cardValues);

  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении
    // (ack COMMIT предыдущей попытки мог потеряться при обрыве) — прогон уже не RUNNING.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_finalized', durationMs };
    }
    // Идемпотентность: задача уже расщеплена (элементы стека работ ИЛИ дети) —
    // финализируем прогон без дублей.
    const already = await c.query(
      `SELECT EXISTS (SELECT 1 FROM work_stack WHERE epic_task_id = $1)
           OR EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = $1) AS dup`,
      [claimed.id],
    );
    if (already.rows[0].dup) {
      const kpiSet0 = runKpiSet(kpi, 2);
      await c.query(
        `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet0.sql} WHERE id = $1`,
        [claimed.agentRunId, JSON.stringify({ status: verdict.status, summary: verdict.summary, reason: 'already_decomposed' }), ...kpiSet0.params],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: claimed.status, reason: 'already_decomposed', durationMs };
    }

    // Вход детей в маршрут = FORWARD-переход Архитектора по маршруту проекта. Граф-
    // режим (есть current_stage_key) → целевой узел Programmer (resolveGraphTransition
    // даёт nextStageKey/статус/роль); линейный — resolveTransition (обычно CODING/
    // PROGRAMMER). Дети наследуют этот целевой этап/статус/роль.
    const resolved = claimed.current_stage_key
      ? await resolveGraphTransition(c, claimed, decision)
      : resolveTransition(route, claimed.role_code, decision, {
        currentStatus: claimed.status,
        currentStageKey: claimed.current_stage_key,
      });
    const childRoleId = resolved.nextRole
      ? await roleIdByCode(c, resolved.nextRole)
      : null;
    const childStageKey = resolved.nextStageKey ?? null;

    // WORK-STACK-001: вместо материализации детей прямо в tasks кладём разбивку в
    // очередь work_stack (по одному элементу на сервис, статус PENDING). Дочерние
    // CODING-задачи заводит ленивый промоутер advanceWorkStack по одному на свободный
    // микросервис. Элемент стека — НЕ задача: его нельзя ни задедупить с эпиком, ни
    // вернуть Архитектору на повторное расщепление, поэтому split-time дедуп по
    // fingerprint здесь больше не нужен (он и был источником bogus-дедупа ребёнка).
    let serviceCount = 0;
    const createdServices = [];
    let seq = 0;
    for (const svc of services) {
      // Карточка элемента — карточка эпика (+ поля вердикта Архитектора), отфильтрованная
      // по ЭТОМУ сервису. messageFingerprint НЕ проставляем: будущая дочерняя задача не
      // должна попадать в дедуп по отпечатку (WORK-STACK-001).
      const itemCard = filterCardForService(card, byCode, svc.serviceId);
      delete itemCard.messageFingerprint;
      const filesText = svc.files
        .map((f) => (f.path ? `- ${f.path}${f.what ? ` — ${f.what}` : ''}` : (f.what ? `- ${f.what}` : '')))
        .filter(Boolean)
        .join('\n');
      const itemDescription = `${claimed.description ?? ''}\n\n## Задание для сервиса ${svc.serviceCode}\n${filesText || svc.title}`
        .trim()
        .slice(0, 20000);
      await c.query(
        `INSERT INTO work_stack (epic_task_id, project_id, service_id, service_code, seq,
                                 title, description, data_card, target_status, target_role_id, target_stage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [claimed.id, claimed.project_id, svc.serviceId, svc.serviceCode, seq,
         svc.title, itemDescription, JSON.stringify(itemCard),
         resolved.toStatus, childRoleId, childStageKey],
      );
      seq += 1;
      serviceCount += 1;
      createdServices.push({ serviceCode: svc.serviceCode, service_id: svc.serviceId });
    }

    // JOIN-PLANNED-COVERAGE-001: фиксируем целевой список сервисов эпика в data_card —
    // роллап сверит фактических детей с заявленным Архитектором scope и не закроет
    // эпик DONE, если часть заявленных сервисов не материализовалась в детей.
    const canonicalRows = await c.query('SELECT service_code FROM services WHERE project_id = $1', [claimed.project_id]);
    const canonicalByCode = new Map(canonicalRows.rows.map((r) => [String(r.service_code).toLowerCase(), r.service_code]));
    const plannedServices = computePlannedServices(card, canonicalByCode);
    // PROGRAMMER-CONTRACT-BARRIER-001: если ровно один сервис сплита владеет общим
    // контрактом (proto), фиксируем его в data_card эпика. Промоутер work_stack
    // (advanceWorkStack) не выпустит сервисы-потребители в CODING, пока владелец не
    // завершён — иначе гонка по сгенерированному коду (инцидент 23.07 «партнёр в чате»).
    let contractBarrier = null;
    if (CONTRACT_BARRIER_ENABLED && services.length > 1) {
      const ownerIdx = detectContractOwnerIndex(services);
      if (ownerIdx >= 0) {
        contractBarrier = {
          ownerService: services[ownerIdx].serviceCode,
          ownerServiceId: String(services[ownerIdx].serviceId),
        };
      }
    }
    // Эпик: помечаем видом, паркуем на детях, доливаем поля вердикта Архитектора.
    await c.query(
      `UPDATE tasks SET task_kind = 'epic', status = 'WAITING_FOR_CHILDREN', assigned_agent_id = NULL,
              data_card = data_card || $2::jsonb WHERE id = $1`,
      [claimed.id, JSON.stringify({
        ...(cardValues || {}), planned_services: plannedServices,
        ...(contractBarrier ? { contract_barrier: contractBarrier } : {}),
      })],
    );
    const kpiSet = runKpiSet(kpi, 2);
    await c.query(
      `UPDATE agent_runs SET status = 'SUCCESS', finished_at = now(), output_json = $2::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: 'architect_service_split', outcome: decision.outcome, fields: cardValues,
        services: serviceCount, unresolved,
      }), ...kpiSet.params],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, role: claimed.role_code, reason: 'architect_service_split',
        verdictStatus: verdict.status, summary: verdict.summary, services: createdServices, unresolved, exchangeId,
      })],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id, fromRole: claimed.role_code, fromStatus: claimed.status,
      toStatus: 'WAITING_FOR_CHILDREN', nextRole: resolved.nextRole, verdict: verdict.status,
      services: serviceCount, unresolved, durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// Применить переход роли по вердикту в отдельной транзакции.
// resolved — { nextRole, toStatus, done, blocked } из projectRoute.resolveTransition.
// cardValues — заполненные ролью исходящие поля → мердж в кумулятивную карточку.
async function finalizeRole(c, claimed, { verdict, response, exchangeId, durationMs, decision, resolved, cardValues = {}, kpi = null, setServiceId, setDescription, setTitle, setPriority }) {
  await c.query('BEGIN');
  try {
    const cur = await c.query('SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!cur.rowCount) {
      await c.query('ROLLBACK');
      return null;
    }
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации. Если предыдущая
    // попытка уже закоммитила результат (а ack COMMIT потерялся из-за обрыва соединения),
    // прогон уже не RUNNING — выходим без повторной вставки события/перехода (иначе
    // задвоили бы task_events и повторно перевели задачу).
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: cur.rows[0].status, alreadyFinalized: true };
    }
    const nextRoleId = resolved.done || !resolved.nextRole
      ? null
      : await roleIdByCode(c, resolved.nextRole);

    if (resolved.nextRole && !nextRoleId) {
      const reason = `next_role_missing:${resolved.nextRole}`;
      await c.query(
        `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL,
                data_card = data_card || $2::jsonb
          WHERE id = $1`,
        [claimed.id, JSON.stringify({ orchestration_error: reason })],
      );
      const kpiSet = runKpiSet(kpi, 3);
      await c.query(
        `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2,
                output_json = $3::jsonb${kpiSet.sql}
          WHERE id = $1`,
        [claimed.agentRunId, reason, JSON.stringify({
          status: 'BLOCKED',
          summary: reason,
          reason,
          outcome: 'BLOCK',
          via: resolved.via,
          fields: cardValues,
        }), ...kpiSet.params],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
          runner: true, ai: true, role: claimed.role_code, reason,
          missingRole: resolved.nextRole, outcome: 'BLOCK', via: resolved.via, exchangeId,
        })],
      );
      await c.query('COMMIT');
      return {
        taskId: claimed.id,
        fromRole: claimed.role_code,
        fromStatus: claimed.status,
        toStatus: 'BLOCKED',
        nextRole: null,
        verdict: 'BLOCKED',
        durationMs,
        blocked: true,
        reason,
      };
    }

    // FORK-JOIN-001: в граф-режиме переносим текущий узел; в линейном — остаётся NULL.
    // DECOMPOSER-REMOVE-001: опционально проставляем service_id (Архитектор) и/или
    // description (Приёмщик — structured_description) в том же UPDATE.
    // TASK-INTAKE-COMMIT-001: и/или title (Приёмщик — short_title).
    const sets = [
      'status = $2::task_status', 'current_role_id = $3', 'assigned_agent_id = NULL',
      'data_card = data_card || $4::jsonb', 'current_stage_key = $5::uuid',
    ];
    const params = [claimed.id, resolved.toStatus, nextRoleId, JSON.stringify(cardValues || {}), resolved.nextStageKey ?? null];
    if (setServiceId) {
      params.push(setServiceId);
      sets.push(`service_id = $${params.length}::uuid`);
    }
    if (typeof setDescription === 'string' && setDescription) {
      params.push(setDescription);
      sets.push(`description = $${params.length}`);
    }
    if (typeof setTitle === 'string' && setTitle) {
      params.push(setTitle);
      sets.push(`title = $${params.length}`);
    }
    // TASK-PRIORITY-SCALE-001: серверный приоритет (Приёмщик/форс оркестратора).
    if (Number.isInteger(setPriority)) {
      params.push(setPriority);
      sets.push(`priority = $${params.length}::smallint`);
    }
    await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);
    const kpiSet = runKpiSet(kpi, 3);
    await c.query(
      `UPDATE agent_runs SET status = $2::agent_run_status, finished_at = now(), output_json = $3::jsonb${kpiSet.sql} WHERE id = $1`,
      [claimed.agentRunId, decision.agentRunStatus, JSON.stringify({
        status: verdict.status, summary: verdict.summary, findings: verdict.findings,
        reason: decision.reason, outcome: decision.outcome, via: resolved.via, fields: cardValues,
      }), ...kpiSet.params],
    );
    if (claimed.role_code === 'TASK_REVIEWER') {
      const rev = ['APPROVED', 'REJECTED', 'NEEDS_FIX'].includes(verdict.status)
        ? verdict.status
        : (verdict.ok ? 'APPROVED' : 'NEEDS_FIX');
      await c.query(
        `INSERT INTO reviews (task_id, reviewer_agent_id, status, review_text) VALUES ($1, $2, $3::review_status, $4)`,
        [claimed.id, claimed.agentId, rev, verdict.summary || String(response).slice(0, 2000)],
      );
    }
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, $2, $3::task_status, $4::task_status, $5, $6::jsonb)`,
      [
        claimed.id,
        resolved.done ? 'TASK_DONE' : 'STATUS_CHANGED',
        claimed.status,
        resolved.toStatus,
        claimed.role_id,
        JSON.stringify({
          runner: true, ai: true, role: claimed.role_code, verdictStatus: verdict.status,
          summary: verdict.summary, nextRole: resolved.nextRole, outcome: decision.outcome,
          via: resolved.via, fields: cardValues, exchangeId,
        }),
      ],
    );
    await c.query('COMMIT');
    return {
      taskId: claimed.id,
      fromRole: claimed.role_code,
      fromStatus: claimed.status,
      toStatus: resolved.toStatus,
      nextRole: resolved.nextRole,
      verdict: verdict.status,
      durationMs,
    };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// ROLE-FIELD-CONTRACT-001: входной гейт. Обязательное входящее поле роли не
// заполнено в карточке задачи → ставим задачу BLOCKED (роль не запускаем), агент-
// прогон помечаем FAILED, пишем диагностическое событие с перечнем полей.
async function blockClaimedForFields(c, claimed, missingFields) {
  return withTransaction(c, async () => {
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2 WHERE id = $1`,
      [claimed.agentRunId, `missing_required_inputs: ${missingFields.join(', ')}`],
    );
    await c.query(
      `UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'TASK_BLOCKED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, reason: 'missing_required_inputs', role: claimed.role_code, fields: missingFields,
      })],
    );
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', reason: 'missing_required_inputs', fields: missingFields };
  });
}

// Ошибка вызова ИИ: освободить слот, пометить прогон FAILED. После MAX_REWORK
// провалов одной роли — пометить задачу BLOCKED, чтобы не жечь токены вечно.
async function failRoleRun(c, claimed, err) {
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return null;
    }
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2 WHERE id = $1`,
      [claimed.agentRunId, err.message],
    );
    const fails = await c.query(
      `SELECT count(*)::int AS n FROM agent_runs WHERE task_id = $1 AND role_id = $2 AND status = 'FAILED'`,
      [claimed.id, claimed.role_id],
    );
    if (fails.rows[0].n >= MAX_REWORK) {
      await c.query(`UPDATE tasks SET status = 'BLOCKED', assigned_agent_id = NULL WHERE id = $1`, [claimed.id]);
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'BLOCKED', $3, $4::jsonb)`,
        [claimed.id, claimed.status, claimed.role_id, JSON.stringify({ runner: true, error: err.message, reason: 'role_failed_max' })],
      );
      await c.query('COMMIT');
      return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'BLOCKED', error: err.message };
    }
    await c.query(`UPDATE tasks SET assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`, [claimed.id]);
    await c.query('COMMIT');
    return null;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}

// VERDICT-RETRY-001: verdict_unparsed НЕ должен сразу ронять задачу в терминальный
// FAILED. Движок claude_code (Claude Agent SDK) не умеет навязать JSON-схему вердикта
// на уровне CLI (в отличие от codex `--output-schema`), поэтому единичный сбой формата
// вердикта — обычный шум, а не тупик: сначала минимум один авто-повтор прогона роли
// (release, по образцу failRoleRun), и только после исчерпания лимита — прежний
// терминальный FAILED. Лимит настраивается env (0 = прежнее поведение без ретраев).
const MAX_VERDICT_RETRY = resolveInt('RUNNER_MAX_VERDICT_RETRY', 1, { min: 0, max: 10 }).value;

// SILENT-FAIL-GUARD-001 (B): реасонинг-роль вернула ответ, но без распознаваемого
// JSON-вердикта. Раньше такой случай молча уходил вперёд как успех (пустые поля).
// Теперь помечаем прогон «не выполнен» (FAILED) и ПОДРОБНО логируем причину:
// agent_runs.error_text + output_json (reason=verdict_unparsed), а сырой ответ модели
// уже лежит в prompt_exchanges. VERDICT-RETRY-001: пока не исчерпан лимит авто-повторов
// — освобождаем задачу под ретрай (return null, как failRoleRun); только после —
// терминальный FAILED с событием STATUS_CHANGED→FAILED.
async function failRoleUnparsed(c, claimed, result) {
  const head = String(result?.response ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const reason = 'verdict_unparsed';
  const errorText = `verdict_unparsed: роль ${claimed.role_code} не вернула распознаваемый JSON-вердикт `
    + `(ответ модели не распарсился; см. prompt_exchanges ${result?.exchangeId ?? ''})`;
  await c.query('BEGIN');
  try {
    // DB-FINALIZE-RETRY-001: идемпотентность повторной финализации на свежем соединении.
    if (await isRunAlreadyFinalized(c, claimed.agentRunId)) {
      await c.query('ROLLBACK');
      return null;
    }
    await c.query(
      `UPDATE agent_runs SET status = 'FAILED', finished_at = now(), error_text = $2, output_json = $3::jsonb WHERE id = $1`,
      [claimed.agentRunId, errorText, JSON.stringify({ reason, exchangeId: result?.exchangeId ?? null, responseHead: head })],
    );
    // Сколько раз ЭТА роль уже падала на неразобранном вердикте (вкл. только что
    // помеченный прогон — reason уже записан в output_json выше). Пока лимит не
    // превышен — освобождаем задачу (status/роль сохраняются) под авто-повтор.
    const retries = await c.query(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE task_id = $1 AND role_id = $2 AND status = 'FAILED' AND output_json->>'reason' = 'verdict_unparsed'`,
      [claimed.id, claimed.role_id],
    );
    if (retries.rows[0].n <= MAX_VERDICT_RETRY) {
      await c.query(
        `UPDATE tasks SET assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
        [claimed.id],
      );
      await c.query('COMMIT');
      return null; // освобождено под авто-ретрай (тот же движок заберёт задачу снова)
    }
    // Лимит авто-повторов исчерпан — прежнее поведение: терминальный FAILED.
    await c.query(
      `UPDATE tasks SET status = 'FAILED', assigned_agent_id = NULL WHERE id = $1 AND status NOT IN ('DONE','CANCELLED')`,
      [claimed.id],
    );
    await c.query(
      `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
       VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'FAILED', $3, $4::jsonb)`,
      [claimed.id, claimed.status, claimed.role_id, JSON.stringify({
        runner: true, ai: true, reason, role: claimed.role_code,
        exchangeId: result?.exchangeId ?? null, responseHead: head,
      })],
    );
    await c.query('COMMIT');
    return { taskId: claimed.id, fromRole: claimed.role_code, toStatus: 'FAILED', reason };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}
