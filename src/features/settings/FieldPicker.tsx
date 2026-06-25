import { useEffect, useMemo, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import {
  Button,
  Callout,
  Input,
  LoadingBlock,
  Modal,
  Select,
  useToast,
} from '../../components/ui';
import { fieldsApi } from '../../api/fieldsApi';
import type { Field, FieldValueType } from '../../types/fields';
import { FIELD_VALUE_TYPES, fieldValueTypeLabel } from '../../types/fields';
import styles from './FieldPicker.module.css';

interface FieldPickerProps {
  open: boolean;
  /** Ключи полей, уже добавленных в текущую колонку (помечаются «добавлено»). */
  usedKeys: Set<string>;
  onClose: () => void;
  /** Выбранное (или только что созданное) поле передаётся родителю. */
  onPick: (field: Field) => void;
}

/** Допустимый формат ключа поля (зеркало backend ^[A-Za-z][A-Za-z0-9_.-]{0,63}$). */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Пикер поля из справочника: список с поиском + форма создания нового поля.
 * Поле, уже добавленное в колонку (usedKeys), помечено и недоступно для выбора.
 *
 * Закрывается ТОЛЬКО явной кнопкой (общее правило проекта, см. Modal).
 */
export function FieldPicker({ open, usedKeys, onClose, onPick }: FieldPickerProps) {
  const toast = useToast();
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');

  // Форма создания нового поля.
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldValueType>('text');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCreating(false);
    setNewKey('');
    setNewName('');
    setNewType('text');
    setKeyError(null);
    setNameError(null);
    setLoadError(false);

    const ctrl = new AbortController();
    setLoading(true);
    fieldsApi
      .listFields(ctrl.signal)
      .then((list) => setFields(list))
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
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q),
    );
  }, [fields, query]);

  async function handleCreate() {
    const key = newKey.trim();
    const name = newName.trim();
    let ok = true;
    if (!KEY_RE.test(key)) {
      setKeyError('Ключ: латиница/цифры/._- , начинается с буквы, до 64 символов.');
      ok = false;
    } else {
      setKeyError(null);
    }
    if (!name) {
      setNameError('Укажите имя поля.');
      ok = false;
    } else {
      setNameError(null);
    }
    if (!ok) return;

    setCreating(true);
    try {
      const created = await fieldsApi.createField({ key, name, valueType: newType });
      setFields((prev) => [...prev, created]);
      toast.success(`Поле «${created.name}» создано`);
      // Сразу добавляем созданное поле в колонку.
      onPick(created);
    } catch (e) {
      // Сообщения вида field_key_exists/field_key_invalid придут как message.
      const msg = e instanceof Error ? e.message : 'Не удалось создать поле';
      if (/key_exists/i.test(msg)) setKeyError('Поле с таким ключом уже существует.');
      else if (/key_invalid/i.test(msg)) setKeyError('Недопустимый формат ключа.');
      else if (/name_required/i.test(msg)) setNameError('Укажите имя поля.');
      else toast.error(msg);
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Выбор поля из справочника"
      subtitle="Выберите существующее поле или создайте новое."
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose} disabled={creating}>
          Отмена
        </Button>
      }
    >
      <div className={styles.body}>
        <div className={styles.searchRow}>
          <Search size={16} aria-hidden="true" className={styles.searchIcon} />
          <input
            className={styles.search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по имени или ключу…"
            aria-label="Поиск поля"
            autoComplete="off"
          />
        </div>

        {loading ? (
          <LoadingBlock label="Загрузка справочника полей…" />
        ) : loadError ? (
          <Callout tone="error" title="Не удалось загрузить справочник полей" live>
            Проверьте доступность backend (<code>/api/fields</code>).
          </Callout>
        ) : filtered.length === 0 ? (
          <p className={styles.empty}>
            {fields.length === 0
              ? 'Справочник полей пуст — создайте первое поле ниже.'
              : 'Под запрос ничего не найдено.'}
          </p>
        ) : (
          <ul className={styles.list}>
            {filtered.map((f) => {
              const used = usedKeys.has(f.key);
              return (
                <li key={f.id} className={styles.row}>
                  <button
                    type="button"
                    className={styles.pick}
                    onClick={() => onPick(f)}
                    disabled={used}
                    aria-label={`Добавить поле «${f.name}»`}
                  >
                    <span className={styles.name}>{f.name}</span>
                    <span className={styles.meta}>
                      <code className={styles.key}>{f.key}</code>
                      <span className={styles.type}>{fieldValueTypeLabel(f.valueType)}</span>
                    </span>
                  </button>
                  {used && (
                    <span className={styles.usedBadge}>
                      <Check size={14} aria-hidden="true" />
                      добавлено
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className={styles.createBlock}>
          <h4 className={styles.createTitle}>Создать новое поле</h4>
          <div className={styles.createGrid}>
            <Input
              label="Ключ"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="task_id"
              error={keyError}
              mono
              autoComplete="off"
              spellCheck={false}
            />
            <Input
              label="Имя"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Идентификатор задачи"
              error={nameError}
              autoComplete="off"
            />
            <Select
              label="Тип значения"
              value={newType}
              onChange={(e) => setNewType(e.target.value as FieldValueType)}
            >
              {FIELD_VALUE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {fieldValueTypeLabel(t)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            leftIcon={<Plus size={16} aria-hidden="true" />}
            onClick={() => void handleCreate()}
            loading={creating}
            disabled={newKey.trim() === '' || newName.trim() === ''}
          >
            Создать и добавить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
