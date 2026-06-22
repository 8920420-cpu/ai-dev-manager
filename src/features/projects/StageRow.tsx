import { useState, type DragEvent } from 'react';
import { FolderOpen, GripVertical, Trash2 } from 'lucide-react';
import { Button, Input, Select, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fsAccess } from '../../api/fsAccess';
import { isScannerRole } from '../../data/presets';
import type { Role, Stage } from '../../types/project';
import styles from './StageRow.module.css';

interface StageRowProps {
  stage: Stage;
  index: number;
  roles: Role[];
  error?: string | null;
  canRemove: boolean;
  /** Над этой строкой сейчас держат перетаскиваемый этап. */
  dropTarget: boolean;
  /** Эта строка сейчас перетаскивается. */
  dragging: boolean;
  onRename: (name: string) => void;
  onSetRole: (roleId: string | null) => void;
  onSetScanPath: (scanPath: string) => void;
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
  canRemove,
  dropTarget,
  dragging,
  onRename,
  onSetRole,
  onSetScanPath,
  onRemove,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: StageRowProps) {
  const toast = useToast();
  const [dragEnabled, setDragEnabled] = useState(false);
  const stageLabel = stage.name.trim() || `этап ${index + 1}`;
  const selectedRoleId = stage.roleIds[0] ?? '';
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const isScanner = selectedRole ? isScannerRole(selectedRole.name) : false;
  const pickerSupported = fsAccess.isDirectoryPickerSupported();

  const handleDrop = (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    onDrop();
  };

  const handlePickFolder = async () => {
    if (!pickerSupported) return;
    try {
      const picked = await fsAccess.pickFolder();
      if (!picked) return; // отменено
      // Браузер обычно не отдаёт абсолютный путь — подставляем имя как подсказку.
      onSetScanPath(picked.absolutePath ?? picked.name);
    } catch {
      toast.error('Не удалось открыть выбор папки');
    }
  };

  return (
    <li
      className={cn(styles.row, dropTarget && styles.dropTarget, dragging && styles.dragging)}
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

      {isScanner && (
        <div className={styles.scanBlock}>
          <div className={styles.scanField}>
            <Input
              label="Отслеживаемая папка сканера"
              value={stage.scanPath ?? ''}
              onChange={(e) => onSetScanPath(e.target.value)}
              placeholder="C:\\projects\\my-app\\src или /home/user/my-app/src"
              helper="Папка, изменения в которой отслеживает сканер. Браузер не передаёт абсолютный путь — при необходимости укажите его вручную."
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
              disabled={!pickerSupported}
              title={
                pickerSupported
                  ? undefined
                  : 'Этот браузер не поддерживает выбор папки — введите путь вручную'
              }
            >
              Выбрать папку
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
