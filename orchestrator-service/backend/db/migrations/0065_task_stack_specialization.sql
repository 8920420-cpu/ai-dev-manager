-- =====================================================================
-- STACK-SPECIALIZATION-001 — специализация программиста ДАННЫМИ, а не ролями.
--
-- Решение 04.08.2026. Обсуждалось разделение роли PROGRAMMER на три (Go-бэкенд,
-- обмен gRPC, Next-фронтенд). Отвергнуто: параллельность в системе упирается не в
-- число ролей, а в замок микросервиса (WORK-STACK-001 «один PENDING-элемент на
-- сервис» + PROGRAMMER-WORKTREE-PER-SERVICE «один активный CODING на сервис»), так
-- что три роли дали бы узлы графа с бэкфиллом по всем проектам, три демона-раннера
-- и разрыв KPI роли на несравнимые ряды — без выигрыша в скорости. Контракт proto
-- при этом не «третий равный», а барьер: очерёдность «владелец контракта раньше
-- потребителей» уже реализована в PROGRAMMER-CONTRACT-BARRIER-001.
--
-- Вместо ролей — поле `stack` (go|proto|next) в разбивке работы. Раннер по нему
-- подаёт агенту профиль скилов (плагин agent-skills, см. AGENT-SKILLS-001 в
-- programmer-runner/src/skillProfiles.js): Go-задача получает go-service-engineer,
-- proto — protobuf-contracts/grpc-api-design/buf-workflow, фронт — nextjs-app-router
-- и React-скилы. Поле НЕ обязательное: не проставили — раннер определяет стек
-- эвристикой по путям файлов задачи, поведение деградирует к прежнему.
--
-- Идемпотентно: ON CONFLICT + маркер STACK-SPECIALIZATION-001 в промптах. Промпты
-- НЕ перезаписываются целиком — секция дописывается в конец, чтобы не потерять
-- правки, сделанные оператором из UI.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Словарь полей.
-- ---------------------------------------------------------------------
INSERT INTO fields (key, name, description, value_type) VALUES
  ('stack', 'Stack',
   'Технологический стек работы: go (бэкенд Go) | proto (контракт protobuf/gRPC) | next (фронтенд Next.js/React). Определяет профиль скилов, который раннер подаёт Программисту. Пусто → раннер определит стек эвристикой.',
   'text')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, value_type = EXCLUDED.value_type;

-- ---------------------------------------------------------------------
-- 2. Контракт ролей (out, НЕобязательное). Обязательным не делаем: пустой stack
--    безопасен (эвристика раннера), а required-поле загоняло бы задачу в rework
--    из-за подсказки для скилов.
-- ---------------------------------------------------------------------
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', false, 7
  FROM fields f
  JOIN roles r ON r.code IN ('ARCHITECT', 'MINI_ARCHITECT')
 WHERE f.key = 'stack'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET required = false;

-- ---------------------------------------------------------------------
-- 3. Промпт Архитектора (английский) — просим стек ПО СЕРВИСУ внутри work_items.
--    Именно по сервису, а не на задачу: мультисервисная задача обычно и есть
--    «Go-бэкенд + Next-фронт», и один общий стек на всех был бы неверен.
-- ---------------------------------------------------------------------
UPDATE roles SET prompt = prompt || E'\n\n' || $stack$<!-- STACK-SPECIALIZATION-001 -->

## Stack of each work item

For every entry of `work_items` (and, when you fill it, `affected_services`) add a
`stack` field describing what the work actually is:

- `go` — Go backend: services, handlers, repositories, workers, shared Go packages.
- `proto` — the shared contract itself: `.proto` files, buf config, generated stubs.
- `next` — Next.js / React frontend: routes, components, hooks, styles.

Also set the task-level `stack` field to the dominant stack of the whole solution.

Why it matters: the runner loads stack-specific engineering skills for the
Programmer from this value (Go conventions, protobuf compatibility rules, App Router
rules). A wrong stack gives the Programmer the wrong playbook; an empty one falls
back to a guess from file paths. Use the file paths you already listed to decide —
do not invent a stack you have no evidence for, and when a service genuinely mixes
work, name the stack of the change that carries the risk (contract over consumer).
$stack$
WHERE code = 'ARCHITECT'
  AND coalesce(prompt, '') <> ''
  AND prompt NOT LIKE '%STACK-SPECIALIZATION-001%';

-- ---------------------------------------------------------------------
-- 4. Промпт Mini Architect (русский — как задан в 0062). Small-контур = один
--    сервис, поэтому стек тут ровно один.
-- ---------------------------------------------------------------------
UPDATE roles SET prompt = prompt || E'\n\n' || $stack$<!-- STACK-SPECIALIZATION-001 -->

## Стек правки

В `fields` дополнительно верни `stack` — что это за работа по сути:

- `go` — бэкенд на Go (сервисы, обработчики, репозитории, воркеры, общие пакеты);
- `proto` — сам контракт: файлы `.proto`, конфиг buf, сгенерированные стабы;
- `next` — фронтенд Next.js/React (маршруты, компоненты, хуки, стили).

По этому полю раннер подаёт Программисту профиль скилов под стек (соглашения Go,
правила совместимости protobuf, правила App Router). Определяй стек по тем файлам,
которые сам же перечислил в `candidate_files`; не уверен — оставь поле пустым, тогда
раннер определит стек сам, это безопаснее неверной подсказки.
$stack$
WHERE code = 'MINI_ARCHITECT'
  AND coalesce(prompt, '') <> ''
  AND prompt NOT LIKE '%STACK-SPECIALIZATION-001%';

COMMIT;
