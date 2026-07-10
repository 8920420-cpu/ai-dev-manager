import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Callout,
  LoadingBlock,
  Modal,
  useToast,
} from '../../components/ui';
import { fieldsApi } from '../../api/fieldsApi';
import type {
  Field,
  RoleContractInput,
  RoleFieldRef,
  RoleFieldPayload,
} from '../../types/fields';
import { fieldValueTypeLabel } from '../../types/fields';
import { FieldPicker } from './FieldPicker';
import styles from './RoleFieldsModal.module.css';

interface RoleFieldsModalProps {
  open: boolean;
  onClose: () => void;
  /** Код роли, чей контракт редактируется (null/закрыто — модалка не работает). */
  roleCode: string | null;
  /** Отображаемое имя роли для заголовка. */
  roleName?: string;
}

/** Направление поля в контракте роли. */
type Direction = 'inputs' | 'outputs';

/**
 * Модальное окно «Контракт данных роли»: две колонки — входящие и исходящие
 * поля. Поле можно пометить обязательным, удалить из колонки или добавить из
 * справочника (FieldPicker позволяет также создать новое поле). Сохранение —
 * PUT /api/roles/:code/fields; если ответ ставит проекты на паузу — заметное
 * предупреждение.
 *
 * Закрывается ТОЛЬКО явной кнопкой (крестик / «Отмена» / «Закрыть») — overlay
 * и Escape намеренно не закрывают (общее правило проекта, см. Modal).
 */
export function RoleFieldsModal({ open, onClose, roleCode, roleName }: RoleFieldsModalProps) {
  const toast = useToast();
  const [inputs, setInputs] = useState<RoleFieldRef[]>([]);
  const [outputs, setOutputs] = useState<RoleFieldRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Открытый пикер полей: для какой колонки добавляем. */
  const [picker, setPicker] = useState<Direction | null>(null);
  /** Коды проектов, поставленных на паузу последним сохранением. */
  const [pausedProjects, setPausedProjects] = useState<string[]>([]);

  // Загрузка контракта роли при каждом открытии.
  useEffect(() => {
    if (!open || !roleCode) return;
    setInputs([]);
    setOutputs([]);
    setPicker(null);
    setPausedProjects([]);
    setSaving(false);
    setLoadError(false);

    const ctrl = new AbortController();
    setLoading(true);
    fieldsApi
      .getRoleFields(roleCode, ctrl.signal)
      .then((contract) => {
        setInputs(contract.inputs ?? []);
        setOutputs(contract.outputs ?? []);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setLoadError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [open, roleCode]);

  /** Поля, уже добавленные в любую из колонок — для подсветки в пикере. */
  const usedKeys = useMemo(() => {
    const list = picker === 'inputs' ? inputs : outputs;
    return new Set(list.map((f) => f.key));
  }, [picker, inputs, outputs]);

  const setColumn = (dir: Direction): typeof setInputs =>
    dir === 'inputs' ? setInputs : setOutputs;

  function addField(dir: Direction, field: Field) {
    const setter = setColumn(dir);
    setter((prev) => {
      if (prev.some((f) => f.key === field.key)) return prev;
      const ref: RoleFieldRef = {
        id: field.id,
        key: field.key,
        name: field.name,
        description: field.description,
        valueType: field.valueType,
        // Входящие поля по умолчанию обязательны (важно для согласованности
        // маршрута), исходящие — нет.
        required: dir === 'inputs',
      };
      return [...prev, ref];
    });
  }

  function removeField(dir: Direction, key: string) {
    setColumn(dir)((prev) => prev.filter((f) => f.key !== key));
  }

  function toggleRequired(dir: Direction, key: string) {
    setColumn(dir)((prev) =>
      prev.map((f) => (f.key === key ? { ...f, required: !f.required } : f)),
    );
  }

  async function handleSave() {
    if (!roleCode) return;
    setSaving(true);
    setPausedProjects([]);
    try {
      const toPayload = (list: RoleFieldRef[]): RoleFieldPayload[] =>
        list.map((f) => ({ key: f.key, required: f.required }));
      const body: RoleContractInput = {
        inputs: toPayload(inputs),
        outputs: toPayload(outputs),
      };
      const res = await fieldsApi.saveRoleFields(roleCode, body);
      setInputs(res.inputs ?? inputs);
      setOutputs(res.outputs ?? outputs);
      if (res.pausedProjects.length > 0) {
        // Не закрываем окно — пользователь должен увидеть список затронутых проектов.
        setPausedProjects(res.pausedProjects);
        toast.info('Контракт сохранён. Часть проектов поставлена на паузу.');
      } else {
        toast.success('Контракт данных роли сохранён');
        onClose();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить контракт роли');
    } finally {
      setSaving(false);
    }
  }

  function renderColumn(dir: Direction, title: string, list: RoleFieldRef[]) {
    return (
      <section className={styles.column} aria-label={title}>
        <div className={styles.columnHead}>
          <h3 className={styles.columnTitle}>{title}</h3>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Plus size={15} aria-hidden="true" />}
            onClick={() => setPicker(dir)}
          >
            Добавить
          </Button>
        </div>

        {list.length === 0 ? (
          <p className={styles.empty}>Полей пока нет.</p>
        ) : (
          <ul className={styles.fieldList}>
            {list.map((f) => (
              <li key={f.key} className={styles.fieldRow}>
                <div className={styles.fieldInfo}>
                  <span className={styles.fieldName} title={f.description || undefined}>
                    {f.name}
                  </span>
                  <span className={styles.fieldMeta}>
                    <code className={styles.fieldKey}>{f.key}</code>
                    <span className={styles.fieldType}>{fieldValueTypeLabel(f.valueType)}</span>
                  </span>
                </div>
                <label className={styles.requiredToggle}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={f.required}
                    onChange={() => toggleRequired(dir, f.key)}
                    aria-label={`Поле «${f.name}» обязательное`}
                  />
                  <span>обязательное</span>
                </label>
                <Button
                  variant="dangerGhost"
                  size="sm"
                  iconOnly
                  leftIcon={<Trash2 size={15} aria-hidden="true" />}
                  onClick={() => removeField(dir, f.key)}
                  aria-label={`Удалить поле «${f.name}» из колонки «${title}»`}
                  title="Удалить из колонки"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <>
      <Modal
        open={open && roleCode !== null}
        onClose={onClose}
        title="Контракт данных роли"
        subtitle={roleName ? `Роль: ${roleName}` : roleCode ? `Роль: ${roleCode}` : undefined}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {pausedProjects.length > 0 ? 'Закрыть' : 'Отмена'}
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить
            </Button>
          </>
        }
      >
        {loading ? (
          <LoadingBlock label="Загрузка контракта роли…" />
        ) : loadError ? (
          <Callout tone="error" title="Не удалось загрузить контракт роли" live>
            Проверьте доступность backend (<code>/api/roles/:code/fields</code>).
          </Callout>
        ) : (
          <div className={styles.body}>
            {pausedProjects.length > 0 && (
              <Callout tone="warning" title="Проекты поставлены на паузу для пересогласования" live>
                Изменение контракта затронуло маршруты проектов:{' '}
                <strong>{pausedProjects.join(', ')}</strong>. Снимите паузу в проекте после
                согласования полей.
              </Callout>
            )}
            <p className={styles.hint}>
              Входящие данные роль получает на вход, исходящие — производит. Каждое обязательное
              входящее поле должно производиться более ранней ролью маршрута.
            </p>
            <div className={styles.columns}>
              {renderColumn('inputs', 'Входящие данные', inputs)}
              {renderColumn('outputs', 'Исходящие данные', outputs)}
            </div>
          </div>
        )}
      </Modal>

      <FieldPicker
        open={picker !== null}
        usedKeys={usedKeys}
        onClose={() => setPicker(null)}
        onPick={(field) => {
          if (picker) addField(picker, field);
          setPicker(null);
        }}
      />
    </>
  );
}
