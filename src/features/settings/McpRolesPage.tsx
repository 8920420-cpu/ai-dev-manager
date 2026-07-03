import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Textarea,
  useToast,
} from '../../components/ui';
import { mcpRolesApi } from '../../api/mcpRolesApi';
import type { McpRole } from '../../types/settings';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

interface RoleForm {
  /** null = создание новой роли (code редактируем), иначе — редактирование. */
  code: string | null;
  codeInput: string;
  name: string;
  description: string;
  prompt: string;
  requirements: string;
}

const EMPTY_FORM: RoleForm = {
  code: null,
  codeInput: '',
  name: '',
  description: '',
  prompt: '',
  requirements: '',
};

/**
 * Раздел «MCP роли»: роли, которые можно использовать через MCP. У роли хранится
 * промт и требования. CRUD поверх /api/mcp-roles; сами роли доступны MCP-клиентам
 * через инструменты orchestrator_list_mcp_roles / orchestrator_get_mcp_role.
 */
export function McpRolesPage() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [roles, setRoles] = useState<McpRole[]>([]);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpRole | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setRoles(await mcpRolesApi.list());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setForm({ ...EMPTY_FORM });
  const openEdit = (r: McpRole) =>
    setForm({
      code: r.code,
      codeInput: r.code,
      name: r.name,
      description: r.description,
      prompt: r.prompt,
      requirements: r.requirements,
    });

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      toast.error('Укажите название роли');
      return;
    }
    setSaving(true);
    try {
      if (form.code) {
        await mcpRolesApi.update(form.code, {
          name,
          description: form.description.trim(),
          prompt: form.prompt,
          requirements: form.requirements,
        });
        toast.success('MCP-роль обновлена');
      } else {
        const code = form.codeInput.trim();
        if (!code) {
          toast.error('Укажите код роли');
          setSaving(false);
          return;
        }
        await mcpRolesApi.create({
          code,
          name,
          description: form.description.trim(),
          prompt: form.prompt,
          requirements: form.requirements,
        });
        toast.success('MCP-роль создана');
      }
      setForm(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить роль');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await mcpRolesApi.remove(deleteTarget.code);
      toast.success('MCP-роль удалена');
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить роль');
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="MCP роли"
        description="Роли, которые можно использовать через MCP. У каждой роли хранится промт и требования. MCP-клиенты получают роли через инструменты orchestrator_list_mcp_roles и orchestrator_get_mcp_role."
        actions={
          <Button variant="primary" leftIcon={<Plus size={18} aria-hidden="true" />} onClick={openCreate}>
            Добавить роль
          </Button>
        }
      />

      {state === 'loading' && <LoadingBlock label="Загрузка MCP-ролей…" />}
      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить MCP-роли">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {state === 'ready' && (
        roles.length === 0 ? (
          <EmptyState
            title="Пока нет MCP-ролей"
            description="Создайте роль, укажите её промт и требования — она станет доступна через MCP."
            action={
              <Button variant="primary" leftIcon={<Plus size={18} aria-hidden="true" />} onClick={openCreate}>
                Добавить роль
              </Button>
            }
          />
        ) : (
          <ul className={styles.toolList}>
            {roles.map((r) => (
              <li key={r.code} className={styles.toolRow}>
                <div>
                  <div>
                    <strong>{r.name}</strong>
                    <span className={styles.toolBadge}>{r.code}</span>
                  </div>
                  {r.description && <span className={styles.toolDesc}>{r.description}</span>}
                </div>
                <div className={styles.toolActions}>
                  <Button variant="secondary" size="sm" iconOnly leftIcon={<Pencil size={15} />} onClick={() => openEdit(r)} aria-label={`Изменить ${r.name}`} />
                  <Button variant="dangerGhost" size="sm" iconOnly leftIcon={<Trash2 size={15} />} onClick={() => setDeleteTarget(r)} aria-label={`Удалить ${r.name}`} />
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      <Modal
        open={form !== null}
        onClose={() => !saving && setForm(null)}
        title={form?.code ? 'Изменить MCP-роль' : 'Новая MCP-роль'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить
            </Button>
          </>
        }
      >
        {form && (
          <div className={styles.toolForm}>
            <Input
              label="Код роли"
              value={form.codeInput}
              onChange={(e) => setForm({ ...form, codeInput: e.target.value })}
              placeholder="например, MCP_REVIEWER"
              autoComplete="off"
              disabled={form.code !== null}
              helper={form.code !== null ? 'Код роли не меняется после создания.' : 'Латиница, цифры, . _ - ; начинается с буквы.'}
            />
            <Input label="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
            <Input label="Описание" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} autoComplete="off" />
            <Textarea
              label="Промт роли"
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              rows={8}
              helper="Системный промт, который применяет MCP-клиент, используя роль."
            />
            <Textarea
              label="Требования к роли"
              value={form.requirements}
              onChange={(e) => setForm({ ...form, requirements: e.target.value })}
              rows={5}
              helper="Что нужно роли для работы: доступы, данные, ограничения."
            />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить MCP-роль?"
        description={deleteTarget ? `Роль «${deleteTarget.name}» (${deleteTarget.code}) будет удалена.` : undefined}
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
