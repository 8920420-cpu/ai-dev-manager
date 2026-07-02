import { useCallback, useEffect, useState } from 'react';
import { Download, Play, Radar, RefreshCw, Square } from 'lucide-react';
import { Badge, Button, Callout, LoadingBlock, PageHeader, useToast } from '../../components/ui';
import { serversApi } from '../../api/serversApi';
import type { ManagedServer, ManagedServerAction, ServersResponse } from '../../types/server';
import type { BadgeTone } from '../../components/ui/Badge';
import styles from './ServersPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

const STATE_LABEL: Record<string, string> = {
  running: 'Запущен',
  exited: 'Остановлен',
  created: 'Создан',
  restarting: 'Перезапуск',
  paused: 'Пауза',
  missing: 'Не создан',
  reachable: 'Доступен',
  unreachable: 'Недоступен',
};

const STATE_TONE: Record<string, BadgeTone> = {
  running: 'success',
  exited: 'neutral',
  created: 'info',
  restarting: 'warning',
  paused: 'warning',
  missing: 'neutral',
  reachable: 'success',
  unreachable: 'warning',
};

const ACTION_LABEL: Record<ManagedServerAction, string> = {
  start: 'Запустить',
  stop: 'Остановить',
  restart: 'Перезапустить',
  pull: 'Скачать образ',
  probe: 'Проверить',
};

const ACTION_ICON: Record<ManagedServerAction, JSX.Element> = {
  start: <Play size={16} aria-hidden="true" />,
  stop: <Square size={16} aria-hidden="true" />,
  restart: <RefreshCw size={16} aria-hidden="true" />,
  pull: <Download size={16} aria-hidden="true" />,
  probe: <Radar size={16} aria-hidden="true" />,
};

function stateLabel(state: string) {
  return STATE_LABEL[state] || state;
}

function actionDisabled(server: ManagedServer, action: ManagedServerAction) {
  if (action === 'probe') return false;
  if (action === 'start') return server.state === 'running';
  if (action === 'stop') return server.state !== 'running';
  if (action === 'restart') return server.state !== 'running';
  return false;
}

function metaLabels(server: ManagedServer) {
  if (server.type === 'k3s') {
    return {
      service: 'Namespace',
      container: 'Host',
      image: 'Registry',
      ports: 'Проверяемые порты',
    };
  }
  return {
    service: 'Compose service',
    container: 'Контейнер',
    image: 'Образ',
    ports: 'Порты',
  };
}

interface ServerCardProps {
  server: ManagedServer;
  dockerAvailable: boolean;
  busy: string | null;
  onAction: (server: ManagedServer, action: ManagedServerAction) => void;
}

function ServerCard({ server, dockerAvailable, busy, onAction }: ServerCardProps) {
  const labels = metaLabels(server);
  return (
    <article className={styles.serverCard}>
      <div className={styles.serverTop}>
        <div className={styles.titleBlock}>
          <h3>{server.name}</h3>
          <p className={styles.description}>{server.description}</p>
        </div>
        <Badge tone={STATE_TONE[server.state] || 'neutral'}>{stateLabel(server.state)}</Badge>
      </div>

      <dl className={styles.meta}>
        <dt>{labels.service}</dt>
        <dd>{server.service}</dd>
        <dt>{labels.container}</dt>
        <dd>{server.type === 'k3s' ? server.host : server.containerName}</dd>
        <dt>{labels.image}</dt>
        <dd>{server.image}</dd>
        <dt>Runtime</dt>
        <dd>{server.status || 'Нет данных'}</dd>
        <dt>{labels.ports}</dt>
        <dd>{server.ports || 'Не опубликованы'}</dd>
      </dl>

      <div className={styles.actions}>
        {server.actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'stop' ? 'dangerGhost' : 'secondary'}
            leftIcon={ACTION_ICON[action]}
            disabled={((server.requiresDocker ?? true) && !dockerAvailable) || actionDisabled(server, action)}
            loading={busy === `${server.id}:${action}`}
            onClick={() => onAction(server, action)}
          >
            {ACTION_LABEL[action]}
          </Button>
        ))}
      </div>
    </article>
  );
}

export function ServersPage() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<ServersResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading');
    try {
      setData(await serversApi.get(signal));
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const runAction = async (server: ManagedServer, action: ManagedServerAction) => {
    setBusy(`${server.id}:${action}`);
    try {
      setData(await serversApi.action(server.id, action));
      toast.success(action === 'pull' ? 'Команда скачивания образа выполнена' : 'Команда выполнена');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось выполнить команду');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Серверы"
        description="Отдельная подсистема управления серверами проекта: локальная Albia, prod k3s-хосты, статусы и базовые действия."
        actions={
          <Button variant="secondary" leftIcon={<RefreshCw size={18} aria-hidden="true" />} onClick={() => void load()}>
            Обновить
          </Button>
        }
      />

      {state === 'loading' && <LoadingBlock label="Загрузка серверов…" />}
      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить серверы">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {state === 'ready' && data && (
        <>
          {!data.dockerAvailable && (
            <Callout tone="warning" title="Docker CLI недоступен для backend">
              Статусы и команды будут работать, когда backend запущен на хосте с Docker CLI или в контейнер
              проброшен доступ к Docker.
            </Callout>
          )}

          <div className={styles.grid}>
            {data.servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                dockerAvailable={data.dockerAvailable}
                busy={busy}
                onAction={(target, action) => void runAction(target, action)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
