import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Input,
  Select,
  PasswordInput,
  Modal,
  useToast,
} from '../../components/ui';
import { integrationsApi } from '../../api/integrationsApi';
import { required } from '../../lib/validation';
import type { Integration, IntegrationInput } from '../../types/integration';
import styles from './IntegrationFormModal.module.css';

interface IntegrationFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Если задано — режим редактирования. */
  initial?: Integration | null;
  /** isNew === true для только что созданного коннектора. */
  onSaved: (integration: Integration, isNew: boolean) => void;
}

/**
 * Пресеты провайдеров. Endpoint вручную не задаётся — его определяет сам
 * коннектор по провайдеру (на backend, см. PROVIDER_ENDPOINTS). Здесь — только
 * подпись и дефолтная модель для подсказки.
 */
const PROVIDERS: Record<string, { label: string; model: string }> = {
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini' },
};

export function IntegrationFormModal({
  open,
  onClose,
  initial,
  onSaved,
}: IntegrationFormModalProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [token, setToken] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const isEdit = Boolean(initial);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setProvider(initial?.provider ?? 'deepseek');
    setModel(initial?.model ?? '');
    setToken('');
    setNameError(null);
    setTokenError(null);
    setSaving(false);
    setConfirmClose(false);
  }, [open, initial]);

  const isDirty =
    name !== (initial?.name ?? '') ||
    provider !== (initial?.provider ?? 'deepseek') ||
    model !== (initial?.model ?? '') ||
    token !== '';

  function requestClose() {
    if (isDirty) setConfirmClose(true);
    else onClose();
  }

  function validateAll(): boolean {
    const nErr = required(name, 'Название');
    // Токен обязателен при создании; при редактировании пустой = «не менять».
    const tErr = !isEdit && token.trim() === '' ? 'Укажите access token' : null;
    setNameError(nErr);
    setTokenError(tErr);
    return !nErr && !tErr;
  }

  async function handleSave() {
    if (!validateAll()) return;
    setSaving(true);
    try {
      const payload: IntegrationInput = {
        name: name.trim(),
        provider,
        model: model.trim(),
      };
      if (token.trim() !== '') payload.accessToken = token.trim();

      let result: Integration;
      if (initial) {
        result = await integrationsApi.update(initial.id, payload);
      } else {
        result = await integrationsApi.create(payload);
      }
      onSaved(result, !initial);
      toast.success(
        isEdit
          ? `Интеграция «${result.name}» обновлена`
          : `Интеграция «${result.name}» добавлена`,
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить интеграцию');
      setSaving(false);
    }
  }

  const modelPlaceholder = PROVIDERS[provider]?.model || 'модель провайдера';

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={isEdit ? 'Изменить интеграцию' : 'Добавить интеграцию'}
        subtitle="Коннектор AI-провайдера (DeepSeek / OpenAI-совместимый)"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <Input
            label="Название"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            error={nameError}
            placeholder="Напр. DeepSeek"
            autoComplete="off"
          />

          <Select
            label="Провайдер"
            required
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            helper="Адрес коннектора определяется провайдером автоматически"
          >
            {Object.entries(PROVIDERS).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </Select>

          <Input
            label="Модель"
            optional
            mono
            value={model}
            onChange={(e) => setModel(e.target.value)}
            helper={`Если пусто — модель по умолчанию (${modelPlaceholder})`}
            placeholder={modelPlaceholder}
            autoComplete="off"
          />

          <PasswordInput
            label="Access token"
            required={!isEdit}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (tokenError) setTokenError(null);
            }}
            error={tokenError}
            autoComplete="off"
            helper={
              isEdit
                ? initial?.hasToken
                  ? 'Токен сохранён. Оставьте пустым, чтобы не менять.'
                  : 'Токен ещё не задан.'
                : 'Bearer-токен провайдера. Хранится только на сервере.'
            }
            placeholder={isEdit && initial?.hasToken ? '••••••••' : 'sk-…'}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmClose}
        title="Закрыть без сохранения?"
        description="Введённые данные не будут сохранены."
        confirmLabel="Закрыть"
        cancelLabel="Продолжить"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  );
}
