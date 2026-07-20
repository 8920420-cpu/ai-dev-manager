-- =====================================================================
-- TASK-NEEDS-INPUT-001 (шаг 2/2) — вопросы исполнителя к человеку.
-- =====================================================================
-- Отдельная таблица, а не колонки в tasks: у задачи за жизнь может быть
-- несколько вопросов (разные роли, разные заходы), и историю «что спросили —
-- что ответили» нужно сохранять, а не затирать последним вопросом. Ответ
-- уезжает в контекст следующего прогона исполнителя.
--
-- Значение enum 'NEEDS_INPUT' добавлено отдельной миграцией 0063: ALTER TYPE
-- ADD VALUE не виден внутри той же транзакции, где значение используется.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS task_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Кто спросил: код роли (PROGRAMMER, ARCHITECT, …) — человеку важно понимать,
  -- на каком этапе застряли.
  role_code       TEXT,
  -- Сам вопрос: одна конкретная формулировка, а не пересказ задачи.
  question        TEXT NOT NULL,
  -- Варианты ответа (массив строк в JSON). Пусто — свободный ответ текстом.
  -- Варианты не запрещают свой текст: человек может выбрать вариант И дополнить.
  options         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Что исполнитель успел выяснить сам — чтобы человек не отвечал на очевидное.
  context         TEXT,
  asked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Ответ человека: выбранный вариант и/или свободный текст.
  answer          TEXT,
  answered_at     TIMESTAMPTZ,
  -- Кто ответил (свободная строка: пользователей-сущностей в оркестраторе нет).
  answered_by     TEXT,
  CONSTRAINT task_questions_question_not_blank CHECK (btrim(question) <> ''),
  -- Отвеченный вопрос обязан иметь и время ответа, и непустой текст: иначе
  -- «отвеченный» вопрос без ответа молча вернул бы задачу в работу ни с чем.
  CONSTRAINT task_questions_answer_consistent CHECK (
    (answered_at IS NULL AND answer IS NULL)
    OR (answered_at IS NOT NULL AND answer IS NOT NULL AND btrim(answer) <> '')
  )
);

-- Горячий путь: «какой сейчас открытый вопрос у задачи» (карточка, доска).
-- Частичный индекс — открытых вопросов на порядки меньше, чем отвеченных.
CREATE INDEX IF NOT EXISTS task_questions_open_idx
  ON task_questions (task_id, asked_at DESC)
  WHERE answered_at IS NULL;

-- История вопросов задачи (карточка задачи, разбор инцидентов).
CREATE INDEX IF NOT EXISTS task_questions_task_idx
  ON task_questions (task_id, asked_at DESC);

-- У задачи не может быть двух открытых вопросов одновременно: исполнитель
-- останавливается на первом же, а два незакрытых вопроса сделали бы неоднозначным
-- ответ «вернуть задачу в работу».
CREATE UNIQUE INDEX IF NOT EXISTS task_questions_single_open_idx
  ON task_questions (task_id)
  WHERE answered_at IS NULL;

-- Статус, из которого задачу вернули в NEEDS_INPUT: чтобы после ответа продолжить
-- ровно с той стадии, а не угадывать её заново.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS needs_input_from_status task_status;

COMMIT;
