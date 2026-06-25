import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, Callout, Input, Select, useToast } from '../../components/ui';
import { fsAccess } from '../../api/fsAccess';
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '../../types/project';
import styles from './StepBasics.module.css';

interface StepBasicsProps {
  name: string;
  path: string;
  /** Папка с документами проекта («карта»; за ней следит Scanner). */
  docsPath: string;
  status: ProjectStatus;
  /** Показывать ли выбор статуса (режим редактирования). */
  showStatus?: boolean;
  nameError?: string | null;
  pathError?: string | null;
  onNameChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onDocsPathChange: (value: string) => void;
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
  docsPath,
  status,
  showStatus = false,
  nameError,
  pathError,
  onNameChange,
  onPathChange,
  onDocsPathChange,
  onStatusChange,
}: StepBasicsProps) {
  const toast = useToast();
  const [hint, setHint] = useState<PickHint>({ kind: 'none' });

  // Открыть системный выбор папки и записать абсолютный путь через apply().
  // current — текущее значение поля (чтобы не затирать ручной ввод именем папки).
  const pickInto = async (apply: (value: string) => void, current: string) => {
    try {
      // fsAccess сам перебирает способы: host-runner мост (даёт абсолютный путь
      // даже без браузерного picker) → backend → браузерный picker.
      const picked = await fsAccess.pickFolder();
      if (!picked) return; // пользователь отменил
      if (picked.absolutePath) {
        apply(picked.absolutePath);
        setHint({ kind: 'none' });
      } else {
        // Браузерный picker отдаёт только имя — поле остаётся для ручного ввода.
        setHint({ kind: 'picked', folder: picked.name });
        if (!current.trim()) apply(picked.name);
      }
    } catch {
      setHint({ kind: 'unsupported' });
      toast.error('Не удалось открыть выбор папки — введите путь вручную');
    }
  };

  const handlePick = () => pickInto(onPathChange, path);
  const handlePickDocs = () => pickInto(onDocsPathChange, docsPath);

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

      <div className={styles.pathBlock}>
        <div className={styles.pathRow}>
          <div className={styles.pathInput}>
            <Input
              label="Папка документов проекта"
              value={docsPath}
              onChange={(e) => onDocsPathChange(e.target.value)}
              placeholder="C:\\projects\\my-app\\docs или /home/user/my-app/docs"
              mono
              helper="Папка с файлами, описывающими проект (его «карта»). За этой папкой следит Scanner — из неё принимаются новые задачи. Можно оставить пустым."
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={styles.pickBtn}>
            <Button
              variant="secondary"
              leftIcon={<FolderOpen size={18} aria-hidden="true" />}
              onClick={handlePickDocs}
            >
              Выбрать папку
            </Button>
          </div>
        </div>
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
