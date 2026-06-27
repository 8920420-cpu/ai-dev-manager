-- =====================================================================
-- APP-SETTINGS-001 — рантайм-настройки приложения (key-value).
-- =====================================================================
-- Глобальные параметры выполнения, редактируемые в UI без перезапуска
-- сервиса. Первый параметр — max_concurrency_per_role: сколько задач одной
-- роли фоновый runner обрабатывает параллельно (по умолчанию 3).
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Значение по умолчанию: 3 параллельных «горутины» на каждую роль.
INSERT INTO app_settings (key, value)
VALUES ('max_concurrency_per_role', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
