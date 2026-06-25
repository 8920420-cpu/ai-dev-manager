/**
 * Репозиторий подключений к базам данных — единый канонический REST оркестратора
 * (`/api/database-connections`, DATABASE-CONNECTIONS-001). См. контракт
 * orchestrator-service/backend/docs/api-database-connections.md.
 *
 * НЕТ категорий «основная»/«дополнительная»: любая доступная проекту БД — это
 * отдельное подключение, созданное пользователем. Секрет (пароль) НИКОГДА не
 * возвращается (приходит лишь флаг `hasSecret`); пароль передаётся только в теле
 * create/update. Пустой/отсутствующий `password` на update НЕ затирает секрет.
 *
 * Endpoints:
 *   GET    /api/database-connections        → { connections: DTO[] }
 *   GET    /api/database-connections/:id     → DTO (404 database_connection_not_found)
 *   POST   /api/database-connections         → 201 + DTO
 *   PUT    /api/database-connections/:id      → 200 + DTO (частичное обновление)
 *   DELETE /api/database-connections/:id      → 200 { deleted: true } | 409 in_use
 *   POST   /api/database-connections/:id/test → { connected, error }
 */
import { http, ApiError } from './http';
import { makeId } from '../lib/format';
import type {
  DbConnection,
  DbConnectionDependent,
  DbConnectionTestResult,
} from '../types/settings';

const BASE = '/api/database-connections';

/** Локальный (несохранённый) черновик имеет id с префиксом `dbc_`. */
export function isDraftConnectionId(id: string): boolean {
  return id.startsWith('dbc_');
}

/** Поля подключения для записи (create/update). Пароль — отдельный аргумент. */
export interface DbConnectionInput {
  name: string;
  dbmsType: DbConnection['dbmsType'];
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: DbConnection['sslMode'];
  /** Передаётся только если задан; пустой не отправляем (не менять секрет). */
  password?: string;
}

function toBody(input: DbConnectionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    dbmsType: input.dbmsType,
    host: input.host.trim(),
    port: input.port,
    database: input.database.trim(),
    user: input.user.trim(),
    sslMode: input.sslMode,
  };
  if (input.password && input.password.trim()) body.password = input.password;
  return body;
}

/**
 * Ошибка удаления используемого подключения (409 database_connection_in_use).
 * Несёт серверный список зависимых проектов — ссылки не обнуляются молча.
 */
export class DbConnectionInUseError extends Error {
  count: number;
  dependents: DbConnectionDependent[];
  constructor(count: number, dependents: DbConnectionDependent[]) {
    super(
      `Подключение используется проектами (${count}). Сначала отвяжите его в этих проектах.`,
    );
    this.name = 'DbConnectionInUseError';
    this.count = count;
    this.dependents = dependents;
  }
}

interface InUsePayload {
  code?: string;
  count?: number;
  dependents?: DbConnectionDependent[];
}

export const databaseConnectionsApi = {
  /** Список всех подключений (без секрета). */
  async list(signal?: AbortSignal): Promise<DbConnection[]> {
    const { connections } = await http.get<{ connections: DbConnection[] }>(BASE, { signal });
    return connections ?? [];
  },

  async get(id: string, signal?: AbortSignal): Promise<DbConnection> {
    return http.get<DbConnection>(`${BASE}/${encodeURIComponent(id)}`, { signal });
  },

  async create(input: DbConnectionInput): Promise<DbConnection> {
    return http.post<DbConnection>(BASE, toBody(input));
  },

  /** Частичное обновление; пустой пароль не затирает существующий секрет. */
  async update(id: string, input: DbConnectionInput): Promise<DbConnection> {
    return http.put<DbConnection>(`${BASE}/${encodeURIComponent(id)}`, toBody(input));
  },

  /**
   * Удаление. При 409 (используется проектами) бросает DbConnectionInUseError со
   * списком зависимых проектов — UI показывает конфликт, ссылки не обнуляются.
   */
  async remove(id: string): Promise<void> {
    try {
      await http.del(`${BASE}/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Структурированное тело 409 несёт count и список зависимых проектов.
        const payload = (err.body ?? {}) as InUsePayload;
        throw new DbConnectionInUseError(payload.count ?? 0, payload.dependents ?? []);
      }
      throw err;
    }
  },

  /** Проверка соединения по сохранённым реквизитам (ничего не пишет). */
  async test(id: string): Promise<DbConnectionTestResult> {
    return http.post<DbConnectionTestResult>(`${BASE}/${encodeURIComponent(id)}/test`);
  },

  /** UI-черновик нового подключения (локальный id до сохранения на сервере). */
  makeDraft(): DbConnection {
    return {
      id: makeId('dbc'),
      name: '',
      dbmsType: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: '',
      user: '',
      sslMode: 'disable',
      hasSecret: false,
    };
  },
};
