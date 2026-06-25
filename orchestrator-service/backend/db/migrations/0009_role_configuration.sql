-- =====================================================================
-- ROLE-CONFIGURATION-001 — расширение модели роли (см. tasks → ORCHESTRATOR-P1.5).
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Каноническая идентичность роли — её `code`. Добавляем:
--   * prompt  — редактируемый рабочий промт роли. NULL = использовать
--               файловый промт roles/<role>.md как значение по умолчанию;
--   * hidden  — глобальный признак: скрытая роль остаётся в конфигурации и
--               истории, но НЕ запускается — оркестратор переходит к следующей
--               активной роли. Это НЕ удаление роли из этапов проекта.
-- Связь роли со skill-файлами хранится в role_skills (M:N к стабильным путям).
-- Существующие роли получают совместимые значения по умолчанию
-- (prompt = NULL → файловый промт; hidden = false).
-- =====================================================================

BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN roles.prompt IS
  'Редактируемый рабочий промт роли. NULL = брать файловый промт roles/<role>.md.';
COMMENT ON COLUMN roles.hidden IS
  'true = роль пропускается исполнителем; остаётся в конфигурации/истории и этапах.';

-- Подключённые к роли skill-файлы. skill_path — стабильный относительный путь/
-- идентификатор внутри настроенного каталога skills (НЕ произвольный путь ФС).
CREATE TABLE IF NOT EXISTS role_skills (
    role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    skill_path text NOT NULL,
    position   int  NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, skill_path)
);
COMMENT ON TABLE role_skills IS
  'Привязка skill-файлов к роли (M:N). Порядок объединения промта задаёт position.';

CREATE INDEX IF NOT EXISTS idx_role_skills_role_id ON role_skills(role_id);

COMMIT;
