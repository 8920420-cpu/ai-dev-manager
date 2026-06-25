import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  Button,
  Callout,
  ConfirmDialog,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Textarea,
  useToast,
} from '../../components/ui';
import { toolsApi } from '../../api/toolsApi';
import { TOOL_CAPABILITY_LABEL, type Tool } from '../../types/settings';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

interface McpForm {
  id: string | null;
  name: string;
  description: string;
  configText: string;
}

const EMPTY_FORM: McpForm = {
  id: null,
  name: '',
  description: '',
  configText: '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}',
};

/**
 * Раздел «Настройки → Инструменты»: реестр инструментов. builtin (чтение/правка/
 * запись проекта) — read-only справочник; MCP-серверы для Claude Code — создаются
 * и редактируются здесь, затем назначаются ролям в карточке роли.
 */
export function ToolsPage() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [tools, setTools] = useState<Tool[]>([]);
  const [form, setForm] = useState<McpForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tool | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setTools(await toolsApi.list());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const builtins = tools.filter((t) => t.kind === 'builtin');
  const mcps = tools.filter((t) => t.kind === 'mcp');

  const openCreate = () => setForm({ ...EMPTY_FORM });
  const openEdit = (t: Tool) =>
    setForm({
      id: t.id,
      name: t.name,
      description: t.description,
      configText: JSON.stringify(t.config ?? {}, null, 2),
    });

  const handleSave = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      toast.error('Укажите имя инструмента');
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = form.configText.trim() ? JSON.parse(form.configText) : {};
    } catch {
      toast.error('Конфигурация должна быть валидным JSON');
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        await toolsApi.update(form.id, { name, description: form.description.trim(), config });
        toast.success('Инструмент обновлён');
      } else {
        await toolsApi.create({ name, kind: 'mcp', capability: 'execute', description: form.description.trim(), config });
        toast.success('MCP-инструмент создан');
      }
      setForm(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить инструмент');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await toolsApi.remove(deleteTarget.id);
      toast.success('Инструмент удалён');
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить инструмент');
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Инструменты"
        description="Реестр инструментов ролей. Встроенные (builtin) дают ролям чтение/правку/запись реального проекта по уровню доступа. MCP-серверы подключаются к Claude Code. Назначаются ролям в карточке роли."
        actions={
          <Button variant="primary" leftIcon={<Plus size={18} aria-hidden="true" />} onClick={openCreate}>
            Добавить MCP
          </Button>
        }
      />

      {state === 'loading' && <LoadingBlock label="Загрузка инструментов…" />}
      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить инструменты">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {state === 'ready' && (
        <>
          <section>
            <h3>Встроенные (чтение/правка/запись проекта)</h3>
            <ul className={styles.toolList}>
              {builtins.map((t) => (
                <li key={t.id} className={styles.toolRow}>
                  <div>
                    <strong>{t.name}</strong>
                    <span className={styles.toolBadge}>{TOOL_CAPABILITY_LABEL[t.capability]}</span>
                  </div>
                  <span className={styles.toolDesc}>{t.description}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>MCP-серверы (для Claude Code)</h3>
            {mcps.length === 0 ? (
              <p className={styles.toolDesc}>Пока нет MCP-инструментов. Нажмите «Добавить MCP».</p>
            ) : (
              <ul className={styles.toolList}>
                {mcps.map((t) => (
                  <li key={t.id} className={styles.toolRow}>
                    <div>
                      <strong>{t.name}</strong>
                      <span className={styles.toolDesc}>{t.description}</span>
                    </div>
                    <div className={styles.toolActions}>
                      <Button variant="secondary" size="sm" iconOnly leftIcon={<Pencil size={15} />} onClick={() => openEdit(t)} aria-label={`Изменить ${t.name}`} />
                      <Button variant="dangerGhost" size="sm" iconOnly leftIcon={<Trash2 size={15} />} onClick={() => setDeleteTarget(t)} aria-label={`Удалить ${t.name}`} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <Modal
        open={form !== null}
        onClose={() => !saving && setForm(null)}
        title={form?.id ? 'Изменить MCP-инструмент' : 'Новый MCP-инструмент'}
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
            <Input label="Имя" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="например, filesystem" autoComplete="off" />
            <Input label="Описание" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} autoComplete="off" />
            <Textarea
              label="Конфигурация MCP (JSON)"
              value={form.configText}
              onChange={(e) => setForm({ ...form, configText: e.target.value })}
              rows={8}
              helper="stdio: { command, args[], env{} } либо http: { url, transport, headers{} }"
            />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить инструмент?"
        description={deleteTarget ? `Инструмент «${deleteTarget.name}» будет удалён и снят со всех ролей.` : undefined}
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
