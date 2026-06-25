/**
 * Репозиторий карточек ролей пайплайна — канонический REST оркестратора.
 * Контракт: orchestrator-service/backend/docs/api-roles.md (ORCHESTRATOR-P1.5).
 *
 * Каноническая идентичность роли — её `code`; `name`/`code` через этот API не
 * меняются. `groupId` — смысловая группа роли (`role_groups`) или null = «Прочее»;
 * раскладка по группам не влияет на рантайм. `prompt: ''` → файловый fallback
 * (roles/<role>.md). `skills` — упорядоченный replace-set относительных id.
 *
 * Endpoints:
 *   GET  /api/roles          → список карточек всех ролей
 *   GET  /api/roles/:code    → одна карточка (404 role_not_found)
 *   PUT  /api/roles/:code    → частичное обновление, ответ — актуальная карточка
 *   GET  /api/skills         → доступные skill-файлы каталога skills
 */
import { http } from './http';
import type { RoleCard, RoleCardPatch, SkillFile } from '../types/settings';

export const rolesApi = {
  /** Список карточек всех ролей. */
  async list(signal?: AbortSignal): Promise<RoleCard[]> {
    const { roles } = await http.get<{ roles: RoleCard[] }>('/api/roles', { signal });
    return roles ?? [];
  },

  /** Одна карточка роли по коду. */
  async get(code: string, signal?: AbortSignal): Promise<RoleCard> {
    return http.get<RoleCard>(`/api/roles/${encodeURIComponent(code)}`, { signal });
  },

  /**
   * Частичное обновление карточки: меняются только переданные поля.
   * `prompt: ''`/пробелы сохраняются как файловый fallback; `skills` заменяется
   * целиком (replace-set, порядок сохраняется, дубли запрещены). Ответ —
   * актуальная карточка роли.
   */
  async update(code: string, patch: RoleCardPatch): Promise<RoleCard> {
    return http.put<RoleCard>(`/api/roles/${encodeURIComponent(code)}`, patch);
  },

  /** Список доступных skill-файлов из настроенного каталога skills сервера. */
  async listSkills(signal?: AbortSignal): Promise<SkillFile[]> {
    const { skills } = await http.get<{ skills: SkillFile[] }>('/api/skills', { signal });
    return skills ?? [];
  },

  /**
   * Загрузить skill-файл с ПК пользователя в каталог skills сервера.
   * Возвращает стабильный id/name загруженного файла (как в listSkills).
   * Файл с тем же именем перезаписывается (обновление содержимого).
   */
  async uploadSkill(name: string, content: string): Promise<SkillFile> {
    return http.post<SkillFile>('/api/skills', { name, content });
  },
};
