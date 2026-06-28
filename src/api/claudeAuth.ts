/**
 * Подключение Claude по подписке для programmer-runner.
 *
 * Бэкенд оркестратора в Linux-контейнере не может ни открыть браузер, ни
 * запустить хостовый `claude`, поэтому токен выпускает host-runner мост на той же
 * машине, где открыт UI (как folderPicker). Браузер зовёт его напрямую по
 * localhost. Мост: POST /setup-claude-token — пустое тело запускает
 * `claude setup-token` (откроет браузер), `{ token }` принимает вставленный токен.
 */

const HOST_BRIDGE_URL =
  (import.meta.env?.VITE_HOST_PICKER_URL as string | undefined)?.replace(/\/+$/, '') ||
  'http://localhost:4187';

export interface SetupTokenResult {
  ok: boolean;
  source?: 'manual' | 'setup-token';
  savedTo?: string;
  tokenMasked?: string;
  error?: string;
  code?: string;
}

async function postSetupToken(body: Record<string, unknown>): Promise<SetupTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${HOST_BRIDGE_URL}/setup-claude-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'host-runner мост недоступен (localhost:4187). Запущен ли host-runner на этой машине?',
    );
  }
  const data = (await res.json().catch(() => ({}))) as SetupTokenResult;
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `мост вернул HTTP ${res.status}`);
  }
  return data;
}

export const claudeAuth = {
  /** Запустить `claude setup-token` на хосте (откроет браузер) и сохранить токен. */
  issueToken(): Promise<SetupTokenResult> {
    return postSetupToken({});
  },
  /** Сохранить вручную вставленный токен подписки. */
  saveToken(token: string): Promise<SetupTokenResult> {
    return postSetupToken({ token });
  },
};
