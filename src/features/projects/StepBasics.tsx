import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, Callout, Input, Select, useToast } from '../../components/ui';
import { fsAccess } from '../../api/fsAccess';
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '../../types/project';
import styles from './StepBasics.module.css';

interface StepBasicsProps {
  name: string;
  path: string;
  status: ProjectStatus;
  /** Показывать ли выбор статуса (режим редактирования). */
  showStatus?: boolean;
  nameError?: string | null;
  pathError?: string | null;
  onNameChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onStatusChange: (value: ProjectStatus) => void;
}

type PickHint =
  | { kind: 'none' }
  | { kind: 'picked'; folder: string }
  | { kind: 'unsupported' };

const STATUS_VALUES: ProjectStatus[] = ['active', 'paused', 'draft', 'archived'];

/** Шаг 1: основная информация о проекте. */
export function StepBasics({
  name,
  path,
  status,
  showStatus = false,
  nameError,
  pathError,
  onNameChange,
  onPathChange,
  onStatusChange,
}: StepBasicsProps) {
  const toast = useToast();
  const supported = fsAccess.isDirectoryPickerSupported();
  const [hint, setHint] = useState<PickHint>(() =>
    supported ? { kind: 'none' } : { kind: 'unsupported' },
  );

  const handlePick = async () => {
    if (!supported) {
      setHint({ kind: 'unsupported' });
      return;
    }
    try {
      const picked = await fsAccess.pickFolder();
      if (!picked) return; // пользователь отменил
      setHint({ kind: 'picked', folder: picked.name });
      // absolutePath обычно null — подставляем имя как подсказку, поле остаётся редактируемым.
      if (picked.absolutePath) {
        onPathChange(picked.absolutePath);
      } else if (!path.trim()) {
        onPathChange(picked.name);
      }
    } catch {
      toast.error('Не удалось открыть выбор папки');
    }
  };

  return (
    <div className={styles.step}>
      <Input
        label="Название проекта"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Например, Платёжный шлюз"
        required
        error={nameError ?? undefined}
        autoComplete="off"
        autoFocus
      />

      <div className={styles.pathBlock}>
        <div className={styles.pathRow}>
          <div className={styles.pathInput}>
            <Input
              label="Папка проекта"
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              placeholder="C:\\projects\\my-app или /home/user/my-app"
              required
              mono
              error={pathError ?? undefined}
              helper="Укажите абсолютный путь к локальной папке проекта."
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={styles.pickBtn}>
            <Button
              variant="secondary"
              leftIcon={<FolderOpen size={18} aria-hidden="true" />}
              onClick={handlePick}
              disabled={!supported}
            >
              Выбрать папку
            </Button>
          </div>
        </div>

        {hint.kind === 'picked' && (
          <Callout tone="info" title="Браузер не передаёт абсолютный путь" live>
            Выбрана папка <span className={styles.folderName}>«{hint.folder}»</span>. Из
            соображений безопасности браузер скрывает полный путь — допишите абсолютный
            путь к папке в поле выше вручную.
          </Callout>
        )}

        {hint.kind === 'unsupported' && (
          <Callout tone="warning" title="Системный выбор папки недоступен">
            Этот браузер не поддерживает диалог выбора папки. Введите абсолютный путь к
            папке проекта вручную.
          </Callout>
        )}
      </div>

      {showStatus && (
        <Select
          label="Статус проекта"
          value={status}
          onChange={(e) => onStatusChange(e.target.value as ProjectStatus)}
        >
          {STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {PROJECT_STATUS_LABEL[value]}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
