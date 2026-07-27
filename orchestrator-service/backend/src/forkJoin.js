// Fork/Join и очередь работ: расщепление в узлах fork, снятие join-барьера,
// промоутер очереди работ (work_stack) и роллап эпиков декомпозиции.
import { withTransaction } from './transaction.js';
import { parseDataCard } from './dataCard.js';
import { forkBranchKeys, nodeByKey } from './graphRoute.js';
import { loadProjectGraph } from './routeLoaders.js';
import { jsonArray } from './db.js';

/**
 * FORK-JOIN-001 (Phase 4) — расщепление в узле fork. Задача, доехавшая до узла
 * kind='fork' (current_stage_key), порождает по подзадаче на каждую исходящую
 * ветку и паркуется на парном join в WAITING_FOR_CHILDREN.
 * FORK-CHILD-001: расщепляется и ДОЧЕРНЯЯ задача (сервисная подзадача эпика) —
 * раньше `parent_task_id IS NULL` навсегда заклинивал детей на fork-узле (Git
 * Integrator не запускался, деливеребл не коммитился). Идемпотентно: расщепляем,
 * только если НЕЗАВЕРШЁННЫХ детей нет (терминальные дети прошлого прохода fork не
 * блокируют повторный проход после REWORK). Один txn на задачу.
 */
export async function advanceForkNodes(c) {
  const parents = await c.query(
    `SELECT t.id, t.project_id, t.title, t.description, t.service_id,
            t.status::text AS status, t.current_role_id, t.current_stage_key, t.data_card,
            ps.join_key
       FROM tasks t
       JOIN project_stages ps
         ON ps.project_id = t.project_id AND ps.stage_key = t.current_stage_key AND ps.kind = 'fork'
      WHERE t.assigned_agent_id IS NULL
        AND t.status NOT IN ('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT')
        AND NOT EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id
                          AND ch.status NOT IN ('DONE','CANCELLED','FAILED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  let forked = 0;
  for (const p of parents.rows) {
    const loaded = await loadProjectGraph(c, p.project_id);
    if (!loaded) continue;
    const branchKeys = forkBranchKeys(loaded.graph, p.current_stage_key);
    const branches = branchKeys.map((k) => nodeByKey(loaded.graph, k)).filter((n) => n && n.roleId);
    if (!branches.length) continue;
    const joinGate = await c.query(`SELECT id FROM roles WHERE code = 'JOIN_GATE'`);
    const joinGateId = joinGate.rows[0]?.id ?? null;
    const card = parseDataCard(p);
    await withTransaction(c, async () => {
      const childIds = [];
      for (const b of branches) {
        const ins = await c.query(
          `INSERT INTO tasks (project_id, service_id, parent_task_id, title, description,
                              status, current_role_id, current_stage_key, created_by, data_card)
           VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8::uuid, 'fork', $9::jsonb)
           RETURNING id`,
          [p.project_id, p.service_id, p.id, `${p.title} [${b.name || 'ветка'}]`, p.description,
           b.status, b.roleId, b.stageKey, JSON.stringify(card)],
        );
        const childId = ins.rows[0].id;
        childIds.push(childId);
        await c.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
           ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
          [p.id, childId],
        );
      }
      // Паркуем родителя на парном join (барьер снимет advanceJoinNodes).
      await c.query(
        `UPDATE tasks SET status = 'WAITING_FOR_CHILDREN', current_role_id = $2,
                current_stage_key = $3::uuid, assigned_agent_id = NULL WHERE id = $1`,
        [p.id, joinGateId, p.join_key],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, 'STATUS_CHANGED', $2::task_status, 'WAITING_FOR_CHILDREN', $3, $4::jsonb)`,
        [p.id, p.status, p.current_role_id,
         JSON.stringify({ runner: true, reason: 'fork_spawned', children: childIds, branches: branchKeys })],
      );
    });
    forked += 1;
  }
  return forked;
}

// WORK-STACK-001 — advisory-lock промоутера очереди работ. Сериализует промоушен
// между параллельными раннерами, чтобы «нет активного PROMOTED на сервис» проверялось
// по зафиксированным строкам, а не в гонке (иначе два раннера завели бы двух детей на
// один сервис). Отдельный ключ от claim'а программиста (CLAUDE_CLAIM_LOCK_KEY).
const WORK_STACK_LOCK_KEY = 911_018;

/**
 * WORK-STACK-001 — промоутер+реконсайлер очереди работ (work_stack). Тикается в
 * advanceAutomatedTasks ПЕРЕД advanceDecompositionParents. Обе фазы идемпотентны и
 * выполняются в одной транзакции под advisory-локом (сериализация раннеров):
 *
 *  (1) reconcile: PROMOTED-элемент, чья дочерняя задача стала терминальной, переводится
 *      в зеркальный терминал (DONE | FAILED | CANCELLED). Это снимает замок сервиса и
 *      разрешает промоутнуть следующий PENDING-элемент того же сервиса тем же тиком.
 *      Источник истины по успеху/провалу — статус дочерней задачи (BLOCKED/FAILED→FAILED).
 *
 *  (2) promote: для каждого сервиса, у которого есть PENDING-элемент и НЕТ активного
 *      PROMOTED-элемента (замок сервиса) и НЕТ незавершённой дочерней задачи на этот
 *      сервис, берём PENDING с наименьшим seq и заводим дочернюю CODING-задачу
 *      (task_kind='service', created_by='work-stack', БЕЗ messageFingerprint — иммунна к
 *      дедупу), линкуем зависимостью к эпику, элемент → PROMOTED. Claim программиста
 *      (PROGRAMMER-WORKTREE-PER-SERVICE) дальше держит один активный CODING на сервис.
 *
 * Возвращает { reconciled, promoted }.
 */
export async function advanceWorkStack(c) {
  return withTransaction(c, async () => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [WORK_STACK_LOCK_KEY]);

    // (1) Reconcile: промоутнутые элементы, чьи задачи терминальны. Идемпотентно —
    // guard status='PROMOTED'. BLOCKED дочерней задачи считаем провалом элемента.
    const rec = await c.query(
      `UPDATE work_stack w
          SET status = CASE t.status::text
                         WHEN 'DONE' THEN 'DONE'
                         WHEN 'CANCELLED' THEN 'CANCELLED'
                         ELSE 'FAILED' END,
              updated_at = now()
         FROM tasks t
        WHERE t.id = w.promoted_task_id
          AND w.status = 'PROMOTED'
          AND t.status IN ('DONE','CANCELLED','FAILED','BLOCKED')`,
    );
    const reconciled = rec.rowCount;

    // (2) Promote: по одному PENDING-элементу на каждый свободный сервис.
    const roleRow = await c.query(`SELECT id FROM roles WHERE code = 'PROGRAMMER'`);
    const programmerRoleId = roleRow.rows[0]?.id ?? null;
    const pending = await c.query(
      `SELECT DISTINCT ON (w.project_id, w.service_id)
              w.id, w.epic_task_id, w.project_id, w.service_id, w.title, w.description,
              w.data_card, w.target_status, w.target_role_id, w.target_stage_key
         FROM work_stack w
        WHERE w.status = 'PENDING'
          -- замок сервиса: нет активного промоутнутого элемента на этот сервис
          AND NOT EXISTS (
            SELECT 1 FROM work_stack w2
             WHERE w2.project_id = w.project_id AND w2.service_id = w.service_id
               AND w2.status = 'PROMOTED')
          -- страховка: нет незавершённой дочерней задачи эпика на этот сервис
          AND NOT EXISTS (
            SELECT 1 FROM tasks t2
             WHERE t2.project_id = w.project_id AND t2.service_id = w.service_id
               AND t2.parent_task_id = w.epic_task_id
               AND t2.status NOT IN ('DONE','CANCELLED','FAILED'))
          -- PROGRAMMER-CONTRACT-BARRIER-001: сервис-потребитель не промоутится, пока
          -- владелец общего контракта (proto) этого эпика не «устаканился» (его
          -- work_stack-элемент DONE/CANCELLED/FAILED). Владельца (его же service_id)
          -- не гейтим; терминал владельца отпускает потребителей → дедлока нет.
          AND NOT EXISTS (
            SELECT 1 FROM tasks epic
             WHERE epic.id = w.epic_task_id
               AND (epic.data_card->'contract_barrier'->>'ownerServiceId') IS NOT NULL
               AND (epic.data_card->'contract_barrier'->>'ownerServiceId') <> w.service_id::text
               AND NOT EXISTS (
                 SELECT 1 FROM work_stack ow
                  WHERE ow.epic_task_id = w.epic_task_id
                    AND ow.service_id::text = (epic.data_card->'contract_barrier'->>'ownerServiceId')
                    AND ow.status IN ('DONE','CANCELLED','FAILED')))
        ORDER BY w.project_id, w.service_id, w.seq, w.created_at`,
    );
    let promoted = 0;
    for (const item of pending.rows) {
      const roleId = item.target_role_id ?? programmerRoleId;
      const child = await c.query(
        `INSERT INTO tasks (project_id, service_id, parent_task_id, task_kind, title, description,
                            status, current_role_id, current_stage_key, created_by, data_card)
         VALUES ($1, $2, $3, 'service', $4, $5, $6::task_status, $7, $8, 'work-stack', $9::jsonb)
         RETURNING id`,
        [item.project_id, item.service_id, item.epic_task_id, item.title, item.description,
         item.target_status, roleId, item.target_stage_key,
         JSON.stringify(parseDataCard(item))],
      );
      const childId = child.rows[0].id;
      await c.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [item.epic_task_id, childId],
      );
      await c.query(
        `UPDATE work_stack SET status = 'PROMOTED', promoted_task_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [item.id, childId],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
         VALUES ($1, 'TASK_CREATED', $2::task_status, $3, $4::jsonb)`,
        [childId, item.target_status, roleId, JSON.stringify({
          runner: true, reason: 'work_stack_promote', epicTaskId: item.epic_task_id,
          workStackId: item.id, serviceId: item.service_id,
        })],
      );
      promoted += 1;
    }
    return { reconciled, promoted };
  });
}

/**
 * DECOMP-CONTRACT-001 — роллап эпиков декомпозиции. Эпик (task_kind='epic') стоит в
 * WAITING_FOR_CHILDREN, пока его дети-декомпозиции не станут терминальными. Когда все
 * терминальны: если хоть один BLOCKED/FAILED → эпик BLOCKED; иначе → DONE. Линейный
 * аналог join-барьера (без графа fork/join). Идемпотентно, по одному txn на эпик,
 * FOR UPDATE SKIP LOCKED.
 *
 * NESTED-EPIC-ROLLUP-001: дети считаются `task_kind IN ('service','epic')`, а не только
 * 'service'. Остаток старой рекурсии расщепления ([[architect-split-recursion]]) оставил
 * эпики с ДЕТЬМИ-ЭПИКАМИ (эпик→эпик→сервис). Раньше роллап видел только service-детей,
 * поэтому эпик с эпиком-ребёнком не закрывался никогда (без service-детей — вечный WFC;
 * со смесью — сервис под эпиком-ребёнком «числился непокрытым» → вечный epic_missing_services).
 * Вложенный эпик несёт свой service_id и, завершившись, покрывает сервис и считается в
 * bad-подсчёте наравне с service-ребёнком. Каскад идёт снизу вверх по тикам.
 */
export async function advanceDecompositionParents(c) {
  const parents = await c.query(
    `SELECT t.id, t.status::text AS status, t.current_role_id, t.data_card
       FROM tasks t
      WHERE t.task_kind = 'epic'
        AND t.status = 'WAITING_FOR_CHILDREN'
        AND t.assigned_agent_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id AND ch.task_kind IN ('service','epic'))
        AND NOT EXISTS (
              SELECT 1 FROM tasks ch
               WHERE ch.parent_task_id = t.id AND ch.task_kind IN ('service','epic')
                 AND ch.status NOT IN ('DONE','CANCELLED','BLOCKED','FAILED'))
        -- WORK-STACK-001: не сворачивать эпик, пока в очереди работ есть незакрытые
        -- элементы (PENDING ещё не промоутнуты, PROMOTED ещё в работе) — иначе роллап
        -- закрыл бы эпик по части сервисов, не дождавшись остальных. Легаси-эпики без
        -- строк work_stack проходят гейт свободно (NOT EXISTS тривиально истинно).
        AND NOT EXISTS (
              SELECT 1 FROM work_stack w
               WHERE w.epic_task_id = t.id AND w.status IN ('PENDING','PROMOTED'))
      FOR UPDATE OF t SKIP LOCKED`,
  );
  let advanced = 0;
  for (const p of parents.rows) {
    await withTransaction(c, async () => {
      const bad = await c.query(
        `SELECT count(*)::int AS n FROM tasks
          WHERE parent_task_id = $1 AND task_kind IN ('service','epic') AND status IN ('BLOCKED','FAILED')`,
        [p.id],
      );
      // JOIN-PLANNED-COVERAGE-001: сверяем ФАКТИЧЕСКИХ детей с целевым списком
      // сервисов Архитектора (data_card.planned_services). Когда капы/таймауты урезают
      // work_items, дети создаются не на все заявленные сервисы (B1: заявлены
      // WEBSTORE/Smeta/IAM/FastTable, дети только на WEBSTORE+IAM) — и DONE по одним лишь
      // имеющимся детям скрыл бы, что половина фронтов не сделана. Сервис считается
      // покрытым, если у него есть хотя бы один НЕ отменённый ребёнок task_kind='service'
      // (сверяем по коду сервиса, а не по числу детей). Недостача приоритетно понижает
      // DONE→BLOCKED с перечнем недостающих сервисов (возврат Архитектору).
      const dc = parseDataCard(p);
      const planned = jsonArray(dc.planned_services).map((x) => String(x).trim()).filter(Boolean);
      let missing = [];
      if (planned.length) {
        const cov = await c.query(
          `SELECT DISTINCT lower(s.service_code) AS code
             FROM tasks ch JOIN services s ON s.id = ch.service_id
            WHERE ch.parent_task_id = $1 AND ch.task_kind IN ('service','epic') AND ch.status <> 'CANCELLED'`,
          [p.id],
        );
        const covered = new Set(cov.rows.map((r) => r.code));
        missing = planned.filter((code) => !covered.has(code.toLowerCase()));
      }
      let toStatus = bad.rows[0].n > 0 ? 'BLOCKED' : 'DONE';
      if (toStatus === 'DONE' && missing.length) toStatus = 'BLOCKED';
      await c.query(
        `UPDATE tasks SET status = $2::task_status, assigned_agent_id = NULL
          WHERE id = $1 AND status = 'WAITING_FOR_CHILDREN'`,
        [p.id, toStatus],
      );
      await c.query(
        `INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
         VALUES ($1, $2, 'WAITING_FOR_CHILDREN', $3::task_status, $4, $5::jsonb)`,
        [p.id, toStatus === 'DONE' ? 'TASK_DONE' : 'TASK_BLOCKED', toStatus, p.current_role_id,
         JSON.stringify({
           runner: true,
           reason: (missing.length && bad.rows[0].n === 0) ? 'epic_missing_services' : 'epic_rollup',
           servicesFailed: bad.rows[0].n,
           missingServices: missing,
         })],
      );
      advanced += 1;
    });
  }
  return advanced;
}
