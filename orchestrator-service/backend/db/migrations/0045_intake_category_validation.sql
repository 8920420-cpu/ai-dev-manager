-- =====================================================================
-- INTAKE-CATEGORY-VALIDATION-001 — согласование контракта полей канала
-- «интеграции в приложения» с ролью Приёмщика (TASK_INTAKE_OFFICER).
--
-- Продолжение INTAKE-INTEGRATIONS-001 (миграция 0043). Что дополняет промт:
--   1) Описание блока intakeReport в контексте роли (reporterService,
--      reporterForm, autocontext, screenshotUrl, category) и как его применять:
--      подсказки — для определения проекта по projectCatalog; существенное из
--      autocontext (jsErrors, упавший запрос) и screenshotUrl — переносить в
--      structured_description, чтобы дошло до Архитектора и Программиста.
--   2) Валидацию категории: category из виджета — ПОДСКАЗКА пользователя, не
--      истина. Приёмщик проверяет её по тексту и при несоответствии выбирает сам;
--      в карточке фиксируются обе — user_category и resolved_category + короткое
--      обоснование при переопределении.
--   3) Маппинг resolved_category → task_type карточки интейка.
--
-- Идемпотентная миграция (guard-marker по образцу 0043): дополняем промт один
-- раз, повторный запуск текст не дублирует.
-- =====================================================================
BEGIN;

UPDATE roles SET prompt = prompt || $intake$

<!-- INTAKE-CATEGORY-VALIDATION-001 -->

## Application integration reports: fields and category validation
For tasks from the "application integrations" channel the context also carries an `intakeReport` block with the raw report fields:
- `reportNumber`, `integration`, `reporterUser`;
- `reporterService` (source microservice) and `reporterForm` (form/screen the message was written from);
- `autocontext` — `url`, `buildVersion`, `userAgent`, `timestamp`, `jsErrors` (capped list), `lastFailedApiRequestId`;
- `screenshotUrl` — link to a screenshot in object storage;
- `category` — the category the user picked in the widget (`bug`, `idea`, `feature`, or `question`).

How to use these fields:
- Use `reporterService`, `reporterForm`, and `autocontext.url` together with `projectCatalog` to resolve the project (as described above).
- Carry the meaningful diagnostics into `structured_description` so they reach the Architect and the Programmer: the essential `autocontext` signals (relevant `jsErrors`, the failed request `lastFailedApiRequestId`) and the `screenshotUrl`. Do not dump raw noise — keep only what helps reproduce or locate the problem.

### Validate the category (do not trust the widget blindly)
The `category` from the widget is the user's HINT, not the truth. You must check whether it matches the actual message text and choose the correct category yourself when it does not. For example, a message that describes a proposal or a wish while the user picked "found a bug" is an `idea`/`feature`, not a `bug`.

Record BOTH categories in the card:
- `user_category` — the value from `intakeReport.category` (the user's choice; leave `unknown` if absent);
- `resolved_category` — your decision after reading the message, one of `bug`, `idea`, `feature`, `question`;
- when `resolved_category` differs from `user_category`, add a short justification in `resolved_category_reason`.

### Map the resolved category to the task label
Set `task_type` from `resolved_category` so the task label matches the message content:
- `bug` → `bug`;
- `idea` → `improvement`/`idea`;
- `feature` → `feature`;
- `question` → `question`.
$intake$
 WHERE code = 'TASK_INTAKE_OFFICER'
   AND prompt IS NOT NULL
   AND prompt NOT LIKE '%INTAKE-CATEGORY-VALIDATION-001%';

COMMIT;
