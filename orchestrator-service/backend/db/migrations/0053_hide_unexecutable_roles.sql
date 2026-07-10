-- =====================================================================
-- HIDE-UNEXECUTABLE-ROLES-001 — скрыть роли без исполнителя. Обратимая
-- идемпотентная миграция.
-- =====================================================================
-- Проблема: роли STRUCTURE_KEEPER, TESTER, REVIEWER, COMMITTER, DEPLOYER
-- видимы в БД (roles.hidden=false), но НЕ входят в маршрут ROLE_FLOW
-- (rolePipeline.js), не обслуживаются host-runner (HOST_ROLES в db.js) и
-- отсутствуют среди reasoning-ролей UI (roleEngines.ts). Если такую роль
-- поставить в этап проекта, задачу никто не подхватит — скрытое зависание.
--
-- Скрываем (hidden=true), НЕ удаляя роли: claimNextClaudeTask/claimLlmRoleTask/
-- claimNextHostTask фильтруют по r.hidden=false, поэтому скрытая роль не
-- клеймится, а UI не предлагает её как обычный этап.
--
-- Если для какой-то роли планируется ввести исполнителя — вместо скрытия
-- задать исполнителя (добавить её в ROLE_FLOW/HOST_ROLES/reasoning-роли);
-- поведение по умолчанию — скрыть.
--
-- Идемпотентно: guard `AND hidden = false` делает повторный прогон no-op.
--
-- ОБРАТНЫЙ SQL (откат — снова показать роли):
--   UPDATE roles SET hidden = false
--    WHERE code IN ('STRUCTURE_KEEPER','TESTER','REVIEWER','COMMITTER','DEPLOYER');
-- =====================================================================

BEGIN;

UPDATE roles
   SET hidden = true
 WHERE code IN ('STRUCTURE_KEEPER', 'TESTER', 'REVIEWER', 'COMMITTER', 'DEPLOYER')
   AND hidden = false;

COMMIT;
