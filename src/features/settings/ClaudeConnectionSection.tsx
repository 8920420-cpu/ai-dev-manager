import { useState } from 'react';
import { Button, Callout, Input, Section, useToast } from '../../components/ui';
import { claudeAuth, type SetupTokenResult } from '../../api/claudeAuth';
import styles from './settings.module.css';

/**
 * Настройки → Выполнение → «Подключение Claude (подписка)».
 *
 * Кнопка выпускает токен подписки Claude Code для programmer-runner: host-runner
 * на этой машине запускает `claude setup-token` (откроет браузер для OAuth),
 * ловит токен и сохраняет его в файл, который programmer-runner подхватывает как
 * CLAUDE_CODE_OAUTH_TOKEN. Если автозахват не сработал (команда требует терминал) —
 * есть ручная вставка токена.
 */
export function ClaudeConnectionSection() {
  const toast = useToast();
  const [issuing, setIssuing] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [manualToken, setManualToken] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [result, setResult] = useState<SetupTokenResult | null>(null);

  const handleIssue = async () => {
    setIssuing(true);
    setResult(null);
    try {
      toast.info?.('Откроется браузер — авторизуйтесь в Claude. Это может занять минуту…');
      const r = await claudeAuth.issueToken();
      setResult(r);
      toast.success('Токен подписки выпущен и сохранён');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось выпустить токен');
      setShowManual(true); // автозахват не вышел — предложим ручную вставку
    } finally {
      setIssuing(false);
    }
  };

  const handleSaveManual = async () => {
    const token = manualToken.trim();
    if (!token) {
      toast.error('Вставьте токен (sk-ant-oat01-…)');
      return;
    }
    setSavingManual(true);
    try {
      const r = await claudeAuth.saveToken(token);
      setResult(r);
      setManualToken('');
      toast.success('Токен сохранён');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить токен');
    } finally {
      setSavingManual(false);
    }
  };

  return (
    <Section
      title="Подключение Claude (подписка)"
      description="Токен подписки Claude Code для programmer-runner (исполнитель стадии CODING). Кнопка запускает «claude setup-token» на этой машине через host-runner и сохраняет токен — отдельный API-ключ не нужен. Требуется запущенный host-runner и установленный Claude Code на хосте."
    >
      <div className={styles.executionForm}>
        <Button variant="primary" onClick={() => void handleIssue()} loading={issuing}>
          Выпустить токен (откроется браузер)
        </Button>

        {result && (
          <Callout tone="success" title="Токен сохранён">
            <div>
              Способ: {result.source === 'manual' ? 'ручная вставка' : 'claude setup-token'}
              {result.tokenMasked ? ` · ${result.tokenMasked}` : ''}
            </div>
            {result.savedTo && <div>Файл: {result.savedTo}</div>}
            <div>Перезапустите programmer-runner, чтобы он подхватил токен.</div>
          </Callout>
        )}

        <Button variant="ghost" onClick={() => setShowManual((v) => !v)}>
          {showManual ? 'Скрыть ручную вставку' : 'Вставить токен вручную'}
        </Button>

        {showManual && (
          <div className={styles.executionForm}>
            <Input
              type="text"
              label="Токен подписки"
              placeholder="sk-ant-oat01-…"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              disabled={savingManual}
              helper="Получить вручную: в терминале выполните `claude setup-token`, скопируйте токен и вставьте сюда."
            />
            <Button
              variant="primary"
              onClick={() => void handleSaveManual()}
              loading={savingManual}
              disabled={!manualToken.trim()}
            >
              Сохранить токен
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
