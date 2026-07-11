/**
 * Осмысленные русские подписи для машинных кодов причин отмены задач (CANCELLED).
 *
 * Отмена в оркестраторе — почти всегда СЛУЖЕБНАЯ УБОРКА (дедуп дублей, чистка
 * обломков расщепления Архитектора, замена повторным прогоном), а НЕ провал
 * работы. Поэтому в подразделе «Выполнено» показываем причину по-русски, а не
 * сырой код. Источник кодов — payload события TASK_CANCELLED (`reason`) в backend
 * (orchestrator-service/backend/src/db.js). Значение `cancelReason` с доски может
 * быть: известным кодом, готовой русской заметкой (duplicateNote) или UUID
 * оригинала-дубля — все три случая обрабатывает `cancelReasonLabel`.
 */
export const CANCEL_REASON_LABEL: Record<string, string> = {
  duplicate_closed: 'Закрыта как дубликат',
  blocked_duplicate_cleanup: 'Убрана при чистке заблокированных дублей',
  architect_split_recursion_debris: 'Убрана: обломок расщепления Архитектора',
  legacy_recursive_epic_cleanup: 'Убрана при чистке рекурсивного эпика',
  superseded_by_rerun: 'Заменена повторным прогоном',
  smoke_test_cleanup: 'Убрана после smoke-теста',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Причина отмены → человекочитаемая русская строка. Известный машинный код
 * переводим по справочнику; готовую русскую заметку пропускаем как есть; «голый»
 * UUID — это ссылка на оригинал дубля. Пусто/нет — «Причина не указана».
 */
export function cancelReasonLabel(reason: string | null | undefined): string {
  const value = (reason ?? '').trim();
  if (!value) return 'Причина не указана';
  if (CANCEL_REASON_LABEL[value]) return CANCEL_REASON_LABEL[value];
  if (UUID_RE.test(value)) return 'Закрыта как дубликат другой задачи';
  return value;
}
