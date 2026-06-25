import { FolderOpen, Trash2 } from 'lucide-react';
import { Button, Input, Modal, Select, useToast } from '../../components/ui';
import { fsAccess } from '../../api/fsAccess';
import { isScannerRole } from '../../data/presets';
import { taskStatusLabel } from '../../data/taskStatuses';
import type { Role, Stage, StageKind } from '../../types/project';
import styles from './StageSettingsModal.module.css';

const CONTROL_LABEL: Record<Exclude<StageKind, 'stage'>, string> = {
  fork: 'Разделить (fork)',
  join: 'Объединить (join)',
  condition: 'Условие',
};

interface StageSettingsModalProps {
  open: boolean;
  onClose: () => void;
  stage: Stage;
  index: number;
  roles: Role[];
  /** Доступные статусы задач (занятые другими сканерами уже исключены). */
  statusOptions: string[];
  nameError?: string | null;
  scanError?: string | null;
  statusError?: string | null;
  /** Скрыть поле «Отслеживаемая папка» (в единой схеме папку задаёт проект). */
  hideScanPath?: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onSetRole: (roleId: string | null) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSetScanPath: (scanPath: string) => void;
  onSetStatus: (taskStatus: string) => void;
  onRemove: () => void;
}

/**
 * Полный редактор одного этапа схемы — открывается из карточки блок-схемы по
 * кнопке-шестерёнке. Здесь собраны ВСЕ данные этапа: название, роль, включённость,
 * статус задач и (для роли Scanner) отслеживаемая папка.
 */
export function StageSettingsModal({
  open,
  onClose,
  stage,
  index,
  roles,
  statusOptions,
  nameError,
  scanError,
  statusError,
  hideScanPath = false,
  canRemove,
  onRename,
  onSetRole,
  onToggleEnabled,
  onSetScanPath,
  onSetStatus,
  onRemove,
}: StageSettingsModalProps) {
  const toast = useToast();
  const kind = stage.kind ?? 'stage';
  const control = kind !== 'stage';
  const stageLabel = stage.name.trim() || `Этап ${index + 1}`;
  const selectedRoleId = stage.roleIds[0] ?? '';
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const enabled = stage.enabled !== false;
  const isScanner = !control && selectedRole ? isScannerRole(selectedRole) : false;
  const showStatus = !control && enabled && selectedRoleId !== '';

  const handlePickFolder = async () => {
    try {
      const picked = await fsAccess.pickFolder();
      if (!picked) return; // отменено
      onSetScanPath(picked.absolutePath ?? picked.name);
      if (!picked.absolutePath) {
        toast.info('Браузер вернул только имя папки — допишите полный путь вручную');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось открыть выбор папки');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${control ? 'Настройки узла' : 'Настройки этапа'} · ${stageLabel}`}
      subtitle={control ? CONTROL_LABEL[kind] : `Шаг ${index + 1} конвейера разработки`}
      size="md"
      footerStart={
        <Button
          variant="dangerGhost"
          leftIcon={<Trash2 size={16} aria-hidden="true" />}
          onClick={() => {
            onRemove();
            onClose();
          }}
          disabled={!canRemove}
          title={canRemove ? 'Удалить этап' : 'Нельзя удалить единственный этап'}
        >
          Удалить этап
        </Button>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          Готово
        </Button>
      }
    >
      <div className={styles.form}>
        <label className={styles.enabledRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
          <span className={styles.enabledText}>
            <span className={styles.enabledTitle}>Этап включён</span>
            <span className={styles.enabledHint}>
              {enabled
                ? 'Роль вызывается в конвейере.'
                : 'Этап сохранён, но роль не вызывается — задача проходит мимо.'}
            </span>
          </span>
        </label>

        <Input
          label="Название этапа"
          value={stage.name}
          onChange={(e) => onRename(e.target.value)}
          placeholder="Например, Разработка"
          error={nameError ?? undefined}
          autoComplete="off"
        />

        {!control && (
          <Select
            label="Ответственная роль"
            value={selectedRoleId}
            onChange={(e) => onSetRole(e.target.value || null)}
            disabled={roles.length === 0}
            helper="Роль, которая обрабатывает задачу на этом этапе."
          >
            <option value="">— не выбрана —</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        )}

        {showStatus && (
          <Select
            label={isScanner ? 'Статус задач сканера' : 'Статус задач'}
            value={stage.taskStatus ?? ''}
            onChange={(e) => onSetStatus(e.target.value)}
            error={statusError ?? undefined}
            required={enabled}
            helper={
              isScanner
                ? 'Сканер забирает только задачи с этим статусом. Статус, занятый другим сканером, недоступен.'
                : 'Статус задачи на этом этапе (task_status). По нему резолвер маршрута ведёт задачу.'
            }
          >
            <option value="">— выберите статус —</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {taskStatusLabel(status)}
              </option>
            ))}
          </Select>
        )}

        {isScanner && !hideScanPath && (
          <div className={styles.scanField}>
            <Input
              label="Отслеживаемая папка сканера"
              value={stage.scanPath ?? ''}
              onChange={(e) => onSetScanPath(e.target.value)}
              placeholder="C:\\projects\\my-app\\src или /home/user/my-app/src"
              helper="Папка, изменения в которой отслеживает сканер. «Выбрать папку» открывает системный диалог."
              error={scanError ?? undefined}
              required={enabled}
              mono
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              className={styles.scanBtn}
              leftIcon={<FolderOpen size={18} aria-hidden="true" />}
              onClick={handlePickFolder}
              title="Открыть системный диалог выбора папки"
            >
              Выбрать папку
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
