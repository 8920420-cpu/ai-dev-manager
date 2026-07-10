import { useState, type DragEvent } from 'react';
import { FolderOpen, GripVertical, Trash2 } from 'lucide-react';
import { Button, Input, Select, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fsAccess } from '../../api/fsAccess';
import { isScannerRole } from '../../data/presets';
import { taskStatusLabel } from '../../data/taskStatuses';
import type { Role, Stage } from '../../types/project';
import styles from './StageRow.module.css';

interface StageRowProps {
  stage: Stage;
  index: number;
  roles: Role[];
  error?: string | null;
  /** Ошибка обязательной папки Scanner (показывается у поля папки). */
  scanError?: string | null;
  /** Ошибка статуса задач Scanner (обязателен/дубликат). */
  statusError?: string | null;
  /** Доступные статусы для дропдауна (занятые другими сканерами исключены). */
  statusOptions: string[];
  /**
   * Скрыть поле «Отслеживаемая папка» у Scanner-этапа. Используется в редакторе
   * единой «Схемы разработки»: папку Scanner задаёт не схема, а каждый проект
   * (его «папка документов» — projects.docs_path).
   */
  hideScanPath?: boolean;
  canRemove: boolean;
  /** Над этой строкой сейчас держат перетаскиваемый этап. */
  dropTarget: boolean;
  /** Эта строка сейчас перетаскивается. */
  dragging: boolean;
  onRename: (name: string) => void;
  onSetRole: (roleId: string | null) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSetScanPath: (scanPath: string) => void;
  onSetStatus: (taskStatus: string) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/** Строка редактирования одного этапа: перетаскивание + название + роль + удаление. */
export function StageRow({
  stage,
  index,
  roles,
  error,
  scanError,
  statusError,
  statusOptions,
  hideScanPath = false,
  canRemove,
  dropTarget,
  dragging,
  onRename,
  onSetRole,
  onToggleEnabled,
  onSetScanPath,
  onSetStatus,
  onRemove,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: StageRowProps) {
  const toast = useToast();
  const [dragEnabled, setDragEnabled] = useState(false);
  const stageLabel = stage.name.trim() || `этап ${index + 1}`;
  const enabled = stage.enabled === true;
  const selectedRoleId = stage.roleIds[0] ?? '';
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  // Scanner определяется ТОЛЬКО по каноническому коду роли, не по названию этапа.
  const isScanner = selectedRole ? isScannerRole(selectedRole) : false;

  const handleDrop = (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    onDrop();
  };

  const handlePickFolder = async () => {
    try {
      const picked = await fsAccess.pickFolder();
      if (!picked) return; // отменено
      // Нативный диалог backend даёт абсолютный путь; браузерный fallback — только имя.
      onSetScanPath(picked.absolutePath ?? picked.name);
      if (!picked.absolutePath) {
        toast.info('Браузер вернул только имя папки — допишите полный путь вручную');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось открыть выбор папки');
    }
  };

  return (
    <li
      className={cn(
        styles.row,
        dropTarget && styles.dropTarget,
        dragging && styles.dragging,
        !enabled && styles.disabledRow,
      )}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onDragEnd={() => {
        setDragEnabled(false);
        onDragEnd();
      }}
    >
      <button
        type="button"
        className={styles.handle}
        onMouseDown={() => setDragEnabled(true)}
        onMouseUp={() => setDragEnabled(false)}
        onBlur={() => setDragEnabled(false)}
        aria-label={`Перетащите, чтобы изменить порядок этапа «${stageLabel}»`}
        title="Перетащить для изменения порядка"
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <span className={styles.number} aria-hidden="true">
        {index + 1}
      </span>
      <div className={styles.nameField}>
        <Input
          label={`Название этапа ${index + 1}`}
          value={stage.name}
          onChange={(e) => onRename(e.target.value)}
          placeholder="Например, Разработка"
          error={error ?? undefined}
          autoComplete="off"
        />
      </div>
      <div className={styles.roleField}>
        <Select
          label="Роль"
          value={selectedRoleId}
          onChange={(e) => onSetRole(e.target.value || null)}
          disabled={roles.length === 0}
          aria-label={`Ответственная роль: ${stageLabel}`}
        >
          <option value="">— не выбрана —</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
      </div>
      <div className={styles.remove}>
        <Button
          variant="dangerGhost"
          size="sm"
          iconOnly
          leftIcon={<Trash2 size={16} aria-hidden="true" />}
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Удалить этап «${stageLabel}»`}
          title={canRemove ? 'Удалить этап' : 'Нельзя удалить единственный этап'}
        />
      </div>

      <div className={styles.toggleRow}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            aria-label={`Включить этап «${stageLabel}»`}
          />
          <span>Включён</span>
        </label>
        {!enabled && (
          // Текстовый статус (не только цвет): этап отключён, но остаётся в пайплайне.
          <span className={styles.disabledBadge}>
            Отключён — роль не вызывается (этап сохранён в пайплайне)
          </span>
        )}
      </div>

      {/* Статус задач для НЕ-Scanner этапа с ролью: по нему резолвер маршрута
          ведёт задачу. Для Scanner статус показывается внутри scanBlock ниже. */}
      {!isScanner && enabled && selectedRoleId !== '' && (
        <div className={styles.statusBlock}>
          <div className={styles.statusField}>
            <Select
              id={`stage-status-${stage.id}`}
              label="Статус задач"
              value={stage.taskStatus ?? ''}
              onChange={(e) => onSetStatus(e.target.value)}
              error={statusError ?? undefined}
              required={enabled}
              helper="Статус задачи на этом этапе (task_status). Резолвер маршрута ведёт задачу по статусам этапов."
              aria-label={`Статус задач: ${stageLabel}`}
            >
              <option value="">— выберите статус —</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {taskStatusLabel(status)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}

      {isScanner && (
        <div className={styles.scanBlock}>
          {!hideScanPath && (
            <>
              <div className={styles.scanField}>
                <Input
                  id={`stage-scan-${stage.id}`}
                  label="Отслеживаемая папка сканера"
                  value={stage.scanPath ?? ''}
                  onChange={(e) => onSetScanPath(e.target.value)}
                  placeholder="C:\\projects\\my-app\\src или /home/user/my-app/src"
                  helper="Папка, изменения в которой отслеживает сканер. «Выбрать папку» открывает системный диалог и подставляет полный путь; если backend недоступен — впишите путь вручную."
                  error={scanError ?? undefined}
                  required={enabled}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className={styles.scanBtn}>
                <Button
                  variant="secondary"
                  leftIcon={<FolderOpen size={18} aria-hidden="true" />}
                  onClick={handlePickFolder}
                  title="Открыть системный диалог выбора папки"
                >
                  Выбрать папку
                </Button>
              </div>
            </>
          )}
          <div className={styles.statusField}>
            <Select
              id={`stage-status-${stage.id}`}
              label="Статус задач сканера"
              value={stage.taskStatus ?? ''}
              onChange={(e) => onSetStatus(e.target.value)}
              error={statusError ?? undefined}
              required={enabled}
              helper="Сканер забирает только задачи с этим статусом. Статус, занятый другим этапом Scanner, недоступен — нельзя обслуживать один статус двумя сканерами."
              aria-label={`Статус задач сканера: ${stageLabel}`}
            >
              <option value="">— выберите статус —</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {taskStatusLabel(status)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
    </li>
  );
}
