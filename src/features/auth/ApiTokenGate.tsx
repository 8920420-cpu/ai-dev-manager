import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Input, Modal } from '../../components/ui';
import {
  API_UNAUTHORIZED_EVENT,
  ensureApiToken,
  getApiToken,
  setApiToken,
} from '../../api/http';
import styles from './ApiTokenGate.module.css';

export function ApiTokenGate() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(() => getApiToken() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      setError('Токен не принят backend-ом. Проверьте ORCHESTRATOR_API_TOKEN из .env.');
      setOpen(true);
    };
    window.addEventListener(API_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(API_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  useEffect(() => {
    let alive = true;
    ensureApiToken().finally(() => {
      if (alive && !getApiToken()) setOpen(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = token.trim();
    if (!next) {
      setError('Введите API-токен.');
      return;
    }

    setChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${next}` },
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Неверный API-токен.' : `API вернул HTTP ${res.status}.`);
        return;
      }
      setApiToken(next);
      window.location.reload();
    } catch {
      setError('Не удалось связаться с backend-ом оркестратора.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Доступ к API"
      subtitle="Backend оркестратора защищён токеном."
      size="sm"
      footer={
        <Button
          type="submit"
          form="api-token-form"
          variant="primary"
          loading={checking}
          leftIcon={<KeyRound size={16} aria-hidden="true" />}
        >
          Продолжить
        </Button>
      }
    >
      <form id="api-token-form" className={styles.form} onSubmit={submit}>
        <Input
          label="ORCHESTRATOR_API_TOKEN"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            if (error) setError(null);
          }}
          type="password"
          autoComplete="off"
          autoFocus
          required
          mono
        />
        <p className={styles.hint}>
          Токен хранится только в sessionStorage текущей вкладки и нужен для запросов к /api/*.
        </p>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </Modal>
  );
}
