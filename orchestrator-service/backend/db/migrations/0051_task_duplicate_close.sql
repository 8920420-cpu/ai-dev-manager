-- =====================================================================
-- TASK-DUPLICATE-CLOSE-001 — индексы под дедуп повторной подачи задач.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Инцидент 08.07: один и тот же репорт об ошибке каталога psweb пришёл из
-- виджета «Сообщить о проблеме» дважды (reportNumber=2 и 3, РАЗНЫЕ external_id)
-- плюс независимо от сканера — три параллельных конвейера сделали одну работу,
-- а их сдачи передрались в git (cherry-pick конфликт → BLOCKED).
--
-- Теперь при создании задачи считается отпечаток текста
-- (data_card->>'messageFingerprint' — sha256 нормализованного сообщения) и при
-- живом (нетерминальном) оригинале с тем же отпечатком новая задача создаётся
-- СРАЗУ закрытой (CANCELLED, duplicateOf в карточке). Индексы покрывают поиск
-- оригинала в двух скоупах: канал intake-интеграции и проект.
-- =====================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_tasks_intake_msg_fingerprint
  ON tasks (intake_integration_id, (data_card->>'messageFingerprint'))
  WHERE intake_integration_id IS NOT NULL AND data_card ? 'messageFingerprint';

CREATE INDEX IF NOT EXISTS idx_tasks_project_msg_fingerprint
  ON tasks (project_id, (data_card->>'messageFingerprint'))
  WHERE data_card ? 'messageFingerprint';

COMMIT;
