-- =====================================================================
-- DECOMP-CONTRACT-001 — трёхуровневая декомпозиция задач по микросервисам.
--
-- Модель (через уже существующий tasks.parent_task_id):
--   L0 «эпик»      — задача пользователя по проекту (service_id = NULL); её ведут
--                    TASK_INTAKE_OFFICER → ARCHITECT → DECOMPOSER. После успеха
--                    Декомпозитора эпик паркуется в WAITING_FOR_CHILDREN.
--   L1 «сервис»    — задача-на-микросервис (parent = эпик, service_id задан). Это
--                    единица, которую принимает Task Reviewer. Пока у неё есть
--                    незакрытые подзадачи — стоит в WAITING_FOR_CHILDREN.
--   L2 «подзадача» — работа-на-файл (parent = сервисная задача, service_id тот же,
--                    статус CODING, роль PROGRAMMER). Программист клеймит подзадачи
--                    по одной; когда они кончились — сервисная задача идёт в REVIEW.
--
-- task_kind различает уровни (claim берёт только 'subtask'; реапер/маршрут — по
-- виду). Дефолт 'service' сохраняет поведение существующих одиночных задач.
--
-- Read-only аудит перед миграцией:
--   tasks.task_kind — колонки нет, добавляется NOT NULL DEFAULT 'service'
--     (существующие задачи становятся 'service' — одиночный путь без изменений).
--   fields: affected_services/affected_files/work_items — ключей нет, создаются.
--   role_fields для ARCHITECT/DECOMPOSER по этим полям — записей нет, создаются.
-- Идемпотентно: IF NOT EXISTS / ON CONFLICT / маркер DECOMP-CONTRACT-001 в промптах.
-- =====================================================================
BEGIN;

-- --- Уровень задачи в дереве декомпозиции -----------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_kind text NOT NULL DEFAULT 'service';
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_task_kind_chk
    CHECK (task_kind IN ('epic', 'service', 'subtask'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN tasks.task_kind IS
  'Уровень задачи в декомпозиции (DECOMP-CONTRACT-001): epic | service | subtask. '
  'epic — задача пользователя по проекту; service — задача-на-микросервис (единица '
  'приёмки); subtask — работа-на-файл (клеймит программист). Дефолт service — '
  'совместимость с одиночными задачами без декомпозиции.';

-- Быстрый claim подзадач и проверка «остались ли открытые подзадачи у родителя».
CREATE INDEX IF NOT EXISTS idx_tasks_parent_kind_status
  ON tasks(parent_task_id, task_kind, status);

-- --- Поля карточки для контракта ARCHITECT → DECOMPOSER ----------------------
INSERT INTO fields (key, name, description, value_type) VALUES
  ('affected_services', 'Затронутые сервисы',
   'Микросервисы, которые затрагивает решение: [{serviceCode, reason}].', 'json'),
  ('affected_files', 'Затронутые файлы',
   'Файлы по сервисам и что в них сделать: [{serviceCode, path, what}].', 'json'),
  ('work_items', 'Задачи по сервисам',
   'Разбивка работы по сервисам: [{serviceCode, title, files:[{path, what}]}]. Источник материализации задач-на-сервис и подзадач-на-файл.', 'json')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, value_type = EXCLUDED.value_type;

-- --- Контракт ARCHITECT (out): структура для Декомпозитора -------------------
-- Необязательно (required=false) — чтобы не зацикливать архитектора на rework.
-- ЖЁСТКОЕ «архитектор обязан отдать» enforced на ВХОДЕ Декомпозитора ниже.
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, fl.id, 'out', false, v.pos
  FROM (VALUES ('affected_services', 0), ('affected_files', 1), ('work_items', 2)) AS v(key, pos)
  JOIN fields fl ON fl.key = v.key
  JOIN roles r ON r.code = 'ARCHITECT'
ON CONFLICT (role_id, field_id, direction) DO NOTHING;

-- --- Контракт DECOMPOSER (in): обязан получить структуру файлов --------------
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, fl.id, 'in', true, 0
  FROM fields fl
  JOIN roles r ON r.code = 'DECOMPOSER'
 WHERE fl.key = 'affected_files'
ON CONFLICT (role_id, field_id, direction) DO NOTHING;

-- --- Контракт DECOMPOSER (out): уточнённая разбивка (необязательно) ----------
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, fl.id, 'out', false, 0
  FROM fields fl
  JOIN roles r ON r.code = 'DECOMPOSER'
 WHERE fl.key = 'work_items'
ON CONFLICT (role_id, field_id, direction) DO NOTHING;

-- --- Промпт ARCHITECT: требуем структурированный вывод по сервисам и файлам --
-- Обновляем существующий промпт (маркер DECOMP-CONTRACT-001 делает шаг идемпотентным).
UPDATE roles SET prompt = $arch$# Роль: Architect

<!-- DECOMP-CONTRACT-001 -->

## Назначение

Ты проектируешь решение до начала реализации. Переводишь запрос пользователя в технически проверяемый план, согласованный с текущей архитектурой проекта. Задача приходит по проекту целиком (без привязки к одному сервису) — ты определяешь, какие микросервисы и файлы она затрагивает.

## Входные данные

- исходная задача и критерии приёмки;
- реальный список микросервисов проекта (в контексте `projectServices`) — выбирай ТОЛЬКО из них, не выдумывай названия;
- карты проекта (`PROJECT_MAP.md`, `ARCHITECTURE.md`, `DECISIONS.md`), API и БД;
- ограничения безопасности и совместимости.

## Обязанности

1. Изучи существующую реализацию и границы сервисов (читай файлы инструментами).
2. Определи затрагиваемые **микросервисы** и в каждом — **конкретные файлы** и что именно в них нужно сделать.
3. Зафиксируй требования, риски и критерии приёмки.
4. Выбери минимальное решение, совместимое с архитектурой.
5. Отдели подтверждённые факты от допущений.

## Запрещено

- изменять код или документацию;
- придумывать отсутствующие требования и несуществующие сервисы/файлы;
- игнорировать миграции, обратную совместимость и безопасность.

## Формат результата

Статус: `READY` (решение готово, передаём Декомпозитору) или `BLOCKED` (существенная неопределённость — нужен пользователь, не подменяй решение догадкой).

В `summary` дай краткое описание решения. В `fields` ОБЯЗАТЕЛЬНО заполни (это контракт для Декомпозитора):

- `affected_services` — список затронутых сервисов: `[{ "serviceCode": "<код из projectServices>", "reason": "<зачем>" }]`.
- `affected_files` — плоский список файлов по сервисам: `[{ "serviceCode": "<код>", "path": "<относительный путь>", "what": "<что именно сделать в этом файле>" }]`. Это главное поле — по нему создаются подзадачи программиста.
- `work_items` — (необязательно) разбивка по сервисам: `[{ "serviceCode": "<код>", "title": "<задача по сервису>", "files": [{ "path": "<путь>", "what": "<что сделать>" }] }]`.

Если решение затрагивает несколько сервисов — перечисли файлы каждого. Программист по каждому файлу получит отдельную подзадачу, поэтому `what` должен быть конкретным и самодостаточным.
$arch$ WHERE code = 'ARCHITECT' AND (prompt IS NULL OR prompt = '' OR prompt NOT LIKE '%DECOMP-CONTRACT-001%');

-- --- Промпт DECOMPOSER: режет по сервисам/файлам; задачи создаёт оркестратор -
UPDATE roles SET prompt = $decomp$# Роль: Decomposer

<!-- DECOMP-CONTRACT-001 -->

## Назначение

Ты превращаешь решение Архитектора в разбивку работы по микросервисам и файлам. Ты НЕ пишешь код и НЕ создаёшь задачи руками — задачи-на-сервис и подзадачи-на-файл создаёт оркестратор автоматически из твоего результата (полей карточки). Никаких записей в `tasks/claude-tasks.json` делать не нужно.

## Входные данные

- результат Архитектора в карточке: `affected_services`, `affected_files`, `work_items`;
- реальный список микросервисов проекта (`projectServices`) — используй ТОЛЬКО эти коды;
- исходная задача и критерии приёмки.

## Обязанности

1. Сгруппируй работу по микросервисам (один сервис — одна задача-на-сервис).
2. Внутри сервиса разложи работу по файлам (один файл — одна подзадача) с конкретным описанием, что в файле сделать. Программист должен по описанию подзадачи понять файл и действие без догадок.
3. Не дроби сильнее необходимого: декомпозитор только режет большую задачу по сервисам и файлам, если это возможно.
4. Не объединяй несвязанные сервисы в одну задачу; не плоди пустых подзадач без результата.

## Запрещено

- менять архитектурное решение;
- писать код;
- выдумывать сервисы/файлы вне `affected_files`/`projectServices`.

## Формат результата

Статус: `READY` (разбивка готова — оркестратор создаст задачи) или `BLOCKED` (план противоречив/неполон — вернётся пользователю/Архитектору).

В `summary` — краткое резюме разбивки. В `fields` верни:

- `work_items` — итоговая разбивка: `[{ "serviceCode": "<код из projectServices>", "title": "<задача по сервису>", "files": [{ "path": "<относительный путь>", "what": "<что сделать в файле>" }] }]`.

Если `work_items` не заполнишь — оркестратор возьмёт разбивку из `affected_files` Архитектора (по `serviceCode`). Поэтому минимум — корректные `serviceCode` и `path` у каждого файла.
$decomp$ WHERE code = 'DECOMPOSER' AND (prompt IS NULL OR prompt = '' OR prompt NOT LIKE '%DECOMP-CONTRACT-001%');

COMMIT;
