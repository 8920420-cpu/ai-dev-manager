-- =====================================================================
-- PIPELINE-DYNAMIC-ROUTE-001 — статус задачи задаётся ЭТАПОМ проекта.
-- Маршрут ролей теперь определяется порядком этапов конкретного проекта
-- (project_stages → project_stage_roles), а не глобальной таблицей ROLE_FLOW.
-- Каждый этап несёт свой task_status: задача под ролью этапа находится именно
-- в этом статусе. Колонка task_status уже добавлена в 0014 (только для Scanner)
-- — здесь она обобщается на ВСЕ этапы (для не-Scanner была NULL).
--
-- Read-only аудит перед миграцией (2026-06-23):
--   project_stages: 20 строк, task_status заполнен у 1 (Scanner-этап), 19 — NULL.
--   Backfill СТРОГО аддитивен: заполняет ТОЛЬКО строки с task_status IS NULL,
--   значение берётся из канонического «владеющего» статуса первой роли этапа.
--   Уже заданные значения (в т.ч. Scanner) НЕ перезаписываются.
--
-- Rollback: значения task_status у не-Scanner этапов выставить обратно в NULL
-- (структурно колонка остаётся — её ввёл 0014).
-- Идемпотентно: повторный запуск не меняет уже заполненные строки.
-- =====================================================================
BEGIN;

-- Каноническое соответствие «код роли → владеющий статус задачи». Используется
-- только для backfill существующих этапов; дальше статус задаёт пользователь в
-- редакторе этапов. Совпадает со «старыми» статусами ROLE_FLOW.from.
WITH role_status(code, status) AS (
  VALUES
    ('STRUCTURE_KEEPER',      'READY'),
    ('ARCHITECT',             'ARCHITECTURE'),
    ('DECOMPOSER',            'DECOMPOSITION'),
    ('PROGRAMMER',            'CODING'),
    ('SCANNER',               'CODING'),
    ('TASK_REVIEWER',         'REVIEW'),
    ('REVIEWER',              'REVIEW'),
    ('PIPELINE_SERVICE',      'TESTING'),
    ('TESTER',                'TESTING'),
    ('FAILURE_ANALYST',       'FAILURE_ANALYSIS'),
    ('DOCUMENTATION_AUDITOR', 'COMMIT'),
    ('DOCUMENTATION_KEEPER',  'COMMIT'),
    ('GIT_INTEGRATOR',        'COMMIT'),
    ('COMMITTER',             'COMMIT'),
    ('DEPLOYER',              'DEPLOY')
),
-- Первая (по position) роль каждого этапа — она определяет статус этапа.
stage_primary AS (
  SELECT DISTINCT ON (psr.stage_id)
         psr.stage_id, r.code AS role_code
    FROM project_stage_roles psr
    JOIN roles r ON r.id = psr.role_id
   ORDER BY psr.stage_id, psr.position, r.code
)
UPDATE project_stages ps
   SET task_status = rs.status::task_status
  FROM stage_primary sp
  JOIN role_status rs ON rs.code = sp.role_code
 WHERE ps.id = sp.stage_id
   AND ps.task_status IS NULL;

COMMENT ON COLUMN project_stages.task_status IS
  'Статус задачи под ролями этого этапа (PIPELINE-DYNAMIC-ROUTE-001). Движок '
  'ставит задаче этот статус при входе на этап и по нему же claim-ит её под '
  'ролью этапа. Для включённого этапа обязателен; уникален среди включённых '
  'Scanner-этапов проекта.';

COMMIT;
