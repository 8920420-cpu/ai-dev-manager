import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ConnectionBadge,
  Input,
  LoadingBlock,
  Section,
  Select,
  useToast,
} from '../../components/ui';
import { roleConnectionsApi } from '../../api/roleConnectionsApi';
import { integrationsApi } from '../../api/integrationsApi';
import { PRESET_ROLES } from '../../data/presets';
import { required } from '../../lib/validation';
import type { RoleConnection } from '../../types/settings';
import type { Integration } from '../../types/integration';
import styles from './settings.module.css';

/** Нормализация кода роли для сравнения дубликатов. */
function normalizeRole(role: string): string {
  return role.trim().toLocaleLowerCase('ru-RU');
}

/** Отображаемое имя роли по каноническому коду (или сам код, если кастомная). */
const ROLE_NAME_BY_CODE = new Map<string, string>(
  PRESET_ROLES.map((r) => [r.code, r.name]),
);
function roleLabel(code: string): string {
  return ROLE_NAME_BY_CODE.get(code) ?? code;
}

/**
 * Показать сразу ВСЕ доступные роли пайплайна (пресеты по коду), подставив
 * сохранённые назначения. Поле `role` хранит канонический roleCode.
 * Пользовательские роли вне пресетов (по коду) сохраняются ниже.
 */
function withAllRoles(saved: RoleConnection[]): RoleConnection[] {
  const used = new Set<string>();
  const rows: RoleConnection[] = PRESET_ROLES.map((preset) => {
    const match = saved.find(
      (r) => !used.has(r.id) && normalizeRole(r.role) === normalizeRole(preset.code),
    );
    if (match) {
      used.add(match.id);
      return { ...match, role: preset.code };
    }
    return roleConnectionsApi.make(preset.code);
  });
  // Дополнительные (пользовательские) роли, которых нет среди пресетов.
  for (const r of saved) {
    if (!used.has(r.id)) rows.push(r);
  }
  return rows;
}

/**
 * Секция «Роли и подключения»: назначение коннектора каждой роли.
 * Источник истины — сервер (roleConnectionsApi → /api/role-connectors).
 */
export function RoleConnectionsSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<RoleConnection[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  /** Показывать ошибки только после попытки сохранить. */
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([roleConnectionsApi.list(), integrationsApi.list()])
      .then(([list, intgs]) => {
        if (!active) return;
        setRows(withAllRoles(list));
        setIntegrations(intgs);
      })
      .catch(() => {
        if (active) toast.error('Не удалось загрузить роли и интеграции');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Множество нормализованных имён, встречающихся более одного раза. */
  const duplicateRoles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeRole(row.role);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [key, count] of counts) {
      if (count > 1) dups.add(key);
    }
    return dups;
  }, [rows]);

  function errorFor(row: RoleConnection): string | null {
    if (!submitted) return null;
    const requiredError = required(row.role, 'Название роли');
    if (requiredError) return requiredError;
    if (duplicateRoles.has(normalizeRole(row.role))) {
      return 'Такая роль уже добавлена — названия должны быть уникальны';
    }
    return null;
  }

  const hasErrors = rows.some((row) => {
    if (required(row.role, 'Название роли')) return true;
    return duplicateRoles.has(normalizeRole(row.role));
  });

  function updateRow(id: string, patch: Partial<RoleConnection>) {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    setRows((prev) => [...prev, roleConnectionsApi.make()]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  async function handleSave() {
    setSubmitted(true);
    if (hasErrors) {
      toast.error('Исправьте ошибки в названиях ролей перед сохранением');
      return;
    }
    setSaving(true);
    try {
      const trimmed = rows.map((row) => ({ ...row, role: row.role.trim() }));
      const saved = await roleConnectionsApi.saveAll(trimmed);
      setRows(saved);
      toast.success('Назначения ролей сохранены');
    } catch {
      toast.error('Не удалось сохранить назначения ролей');
    } finally {
      setSaving(false);
    }
  }

  function integrationStatus(integrationId: string): Integration | undefined {
    return integrations.find((i) => i.id === integrationId);
  }

  return (
    <Section
      title="Роли и подключения"
      description="Назначьте каждой роли коннектор (интеграцию), через который она будет обращаться к AI-провайдеру."
      id="role-connections"
    >
      {loading ? (
        <LoadingBlock label="Загрузка ролей…" />
      ) : (
        <div className={styles.rolesWrap}>
          <Callout tone="info" title="Пример назначения">
            Разработчик → Claude Connector, Reviewer → OpenAI Connector,
            Аналитик → Local Connector.
          </Callout>

          {integrations.length === 0 && (
            <Callout tone="warning" title="Нет доступных интеграций">
              Сначала добавьте коннекторы в разделе «Интеграции» — тогда их
              можно будет выбрать для роли.
            </Callout>
          )}

          {rows.length > 0 && (
            <ul className={styles.rolesList}>
              {rows.map((row) => {
                const selected = integrationStatus(row.integrationId);
                const isPreset = ROLE_NAME_BY_CODE.has(row.role);
                const display = isPreset ? roleLabel(row.role) : row.role;
                return (
                  <li key={row.id} className={styles.roleRow}>
                    <div className={styles.roleName}>
                      <Input
                        label="Название роли"
                        value={display}
                        onChange={(e) => updateRow(row.id, { role: e.target.value })}
                        placeholder="Например, CUSTOM_ROLE"
                        required
                        error={errorFor(row)}
                        autoComplete="off"
                        readOnly={isPreset}
                        title={isPreset ? `Канонический код роли: ${row.role}` : undefined}
                      />
                    </div>

                    <div className={styles.roleIntegration}>
                      <Select
                        label="Интеграция"
                        value={row.integrationId}
                        onChange={(e) =>
                          updateRow(row.id, { integrationId: e.target.value })
                        }
                        disabled={integrations.length === 0}
                      >
                        <option value="">— не выбрано —</option>
                        {integrations.map((intg) => (
                          <option key={intg.id} value={intg.id}>
                            {intg.name}
                          </option>
                        ))}
                      </Select>
                    </div>

                    <div className={styles.roleStatus}>
                      {selected ? (
                        <ConnectionBadge state={selected.status ?? 'unknown'} />
                      ) : (
                        <Badge tone="neutral">Не выбрано</Badge>
                      )}
                    </div>

                    <div className={styles.roleRemove}>
                      <Button
                        variant="dangerGhost"
                        iconOnly
                        leftIcon={<Trash2 size={16} aria-hidden="true" />}
                        onClick={() => removeRow(row.id)}
                        aria-label={`Удалить роль «${display}»`}
                        title="Удалить роль"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.rolesActions}>
            <Button
              variant="secondary"
              leftIcon={<Plus size={16} aria-hidden="true" />}
              onClick={addRow}
            >
              Добавить роль
            </Button>

            <div className={styles.rolesActionsRight}>
              <Button
                variant="primary"
                leftIcon={<Save size={16} aria-hidden="true" />}
                loading={saving}
                disabled={saving}
                onClick={handleSave}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
