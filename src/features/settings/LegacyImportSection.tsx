import { useMemo, useState } from 'react';
import { Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button, Callout, Section, useToast } from '../../components/ui';
import {
  legacyImportApi,
  type ImportResult,
} from '../../api/legacyImportApi';
import styles from './settings.module.css';

/**
 * Секция «Перенос локальных данных»: одноразовый импорт legacy-данных из
 * localStorage (проекты, доп. БД, назначения «роль→коннектор») в каноническое
 * серверное хранилище. Запускается ТОЛЬКО явным действием пользователя.
 * Секреты (пароли) не переносятся.
 */
export function LegacyImportSection() {
  const toast = useToast();
  // Наличие legacy-данных и факт завершения определяем один раз при монтировании.
  const hasData = useMemo(() => legacyImportApi.hasLegacyData(), []);
  const [done, setDone] = useState(() => legacyImportApi.isImportDone());
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Если данных нет и импорт не выполнялся — секцию не показываем вовсе.
  if (!hasData && !done && !preview) return null;

  async function runPreview() {
    setBusy(true);
    try {
      const res = await legacyImportApi.preview();
      setPreview(res);
    } catch {
      toast.error('Не удалось получить предпросмотр переноса');
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    setBusy(true);
    try {
      const res = await legacyImportApi.commit();
      setPreview(res);
      setDone(true);
      const total = Object.values(res.created ?? {}).reduce((a, b) => a + b, 0);
      toast.success(`Перенос выполнен: создано записей — ${total}`);
    } catch {
      toast.error('Не удалось выполнить перенос');
    } finally {
      setBusy(false);
    }
  }

  const createdTotal = preview
    ? Object.values(preview.created ?? {}).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <Section
      title="Перенос локальных данных"
      description="Одноразовый перенос данных, ранее хранившихся в браузере (проекты, дополнительные базы данных, назначения ролей), в серверное хранилище. Пароли не переносятся."
      id="legacy-import"
    >
      <div className={styles.rolesWrap}>
        {done && (
          <Callout tone="success" title="Перенос уже выполнен">
            Локальные данные перенесены в серверное хранилище. Повторный запуск
            идемпотентен — существующие записи не дублируются и не перезаписываются.
          </Callout>
        )}

        {!done && hasData && (
          <Callout tone="info" title="Найдены локальные данные">
            В браузере остались данные из прежней версии. Сначала посмотрите
            предпросмотр плана переноса, затем подтвердите. Пароли баз данных не
            переносятся — их нужно будет задать на сервере отдельно.
          </Callout>
        )}

        {preview && (
          <Callout
            tone={preview.conflicts.length > 0 ? 'warning' : 'info'}
            title={preview.dryRun ? 'Предпросмотр плана переноса' : 'Результат переноса'}
          >
            <ul className={styles.importPlan}>
              <li>
                <CheckCircle2 size={14} aria-hidden="true" /> К созданию:{' '}
                <strong>{createdTotal}</strong>
              </li>
              <li>
                <AlertTriangle size={14} aria-hidden="true" /> Конфликты (пропущены):{' '}
                <strong>{preview.conflicts.length}</strong>
              </li>
              <li>
                Пропущено (уже перенесено): <strong>{preview.skipped.length}</strong>
              </li>
            </ul>
          </Callout>
        )}

        <div className={styles.rolesActions}>
          <Button
            variant="secondary"
            leftIcon={<Upload size={16} aria-hidden="true" />}
            onClick={runPreview}
            loading={busy && !preview}
            disabled={busy || (!hasData && !preview)}
          >
            Предпросмотр
          </Button>

          <div className={styles.rolesActionsRight}>
            <Button
              variant="primary"
              leftIcon={<Upload size={16} aria-hidden="true" />}
              onClick={runCommit}
              loading={busy}
              disabled={busy || !preview || !preview.dryRun}
            >
              Выполнить перенос
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}
