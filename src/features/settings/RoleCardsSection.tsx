import { useEffect, useMemo, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  Button,
  Callout,
  ConfirmDialog,
  LoadingBlock,
  Section,
  useToast,
} from '../../components/ui';
import { rolesApi } from '../../api/rolesApi';
import { roleGroupsApi } from '../../api/roleGroupsApi';
import type { RoleCard, RoleGroup } from '../../types/settings';
import { RoleCardModal } from './RoleCardModal';
import styles from './RoleCardsSection.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/** Псевдо-id корзины «Прочее» (роли без группы). */
const UNGROUPED = '__ungrouped__';

/**
 * Секция «Карточки ролей»: роли пайплайна, разложенные по управляемым смысловым
 * группам (раскрытое дерево). Группу можно создать, переименовать и удалить;
 * роль переносится в другую группу из её карточки. Клик по строке роли
 * открывает модальное окно с описанием, группой, промтом и skills.
 * Источник истины — сервер (rolesApi → /api/roles, roleGroupsApi → /api/role-groups).
 */
export function RoleCardsSection() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>('loading');
  const [roles, setRoles] = useState<RoleCard[]>([]);
  const [groups, setGroups] = useState<RoleGroup[]>([]);
  const [editing, setEditing] = useState<RoleCard | null>(null);

  // --- Состояние управления группами ---
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RoleGroup | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setState('loading');
    Promise.all([rolesApi.list(ctrl.signal), roleGroupsApi.list(ctrl.signal)])
      .then(([roleList, groupList]) => {
        if (!active) return;
        setRoles(roleList);
        setGroups(groupList);
        setState('ready');
      })
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        if (active) setState('error');
      });
    return () => {
      active = false;
      ctrl.abort();
    };
  }, []);

  function handleSaved(saved: RoleCard) {
    setRoles((prev) => prev.map((r) => (r.code === saved.code ? saved : r)));
  }

  /** Дерево: каждая группа (по порядку) + корзина «Прочее» в конце, если непуста. */
  const tree = useMemo(() => {
    const knownIds = new Set(groups.map((g) => g.id));
    const byGroup = new Map<string, RoleCard[]>();
    for (const role of roles) {
      const key = role.groupId && knownIds.has(role.groupId) ? role.groupId : UNGROUPED;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(role);
    }
    const sections = groups.map((g) => ({ group: g, roles: byGroup.get(g.id) ?? [] }));
    const ungrouped = byGroup.get(UNGROUPED) ?? [];
    return { sections, ungrouped };
  }, [roles, groups]);

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      const created = await roleGroupsApi.create(name);
      setGroups((prev) => [...prev, created].sort(byOrder));
      setNewGroupName('');
      toast.success(`Группа «${created.name}» создана`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось создать группу');
    } finally {
      setCreatingGroup(false);
    }
  }

  function startRename(group: RoleGroup) {
    setRenamingId(group.id);
    setRenameValue(group.name);
  }

  async function saveRename(group: RoleGroup) {
    const name = renameValue.trim();
    if (!name || name === group.name) {
      setRenamingId(null);
      return;
    }
    setSavingRename(true);
    try {
      const updated = await roleGroupsApi.update(group.id, { name });
      setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)).sort(byOrder));
      setRenamingId(null);
      toast.success('Группа переименована');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось переименовать группу');
    } finally {
      setSavingRename(false);
    }
  }

  async function deleteGroup(group: RoleGroup) {
    try {
      const res = await roleGroupsApi.remove(group.id);
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
      // Роли удалённой группы локально переносим в «Прочее» (как на сервере).
      setRoles((prev) =>
        prev.map((r) => (r.groupId === group.id ? { ...r, groupId: null } : r)),
      );
      toast.success(
        res.detachedRoles > 0
          ? `Группа «${group.name}» удалена, ролей перенесено в «Прочее»: ${res.detachedRoles}`
          : `Группа «${group.name}» удалена`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить группу');
    } finally {
      setConfirmDelete(null);
    }
  }

  function renderRoleRow(role: RoleCard) {
    return (
      <li key={role.code} className={styles.row}>
        <button
          type="button"
          className={styles.open}
          onClick={() => setEditing(role)}
          aria-label={`Открыть карточку роли «${role.name}»`}
        >
          <span className={styles.name}>{role.name}</span>
          <span className={styles.desc}>
            {role.description?.trim() || 'Описание не задано'}
          </span>
          <span className={styles.meta}>
            {role.skills.length > 0 ? `Skills: ${role.skills.length}` : 'Без skills'}
          </span>
        </button>
      </li>
    );
  }

  return (
    <Section
      title="Карточки ролей"
      description="Роли пайплайна, разложенные по смысловым группам. Группы можно создавать, переименовывать и удалять; роль переносится в другую группу из её карточки. Раскладка по группам не влияет на рантайм — пропуск роли настраивается отдельно для каждого проекта в «Этапы пайплайна»."
      id="role-cards"
    >
      {state === 'loading' && <LoadingBlock label="Загрузка ролей…" />}

      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить роли">
          Backend оркестратора недоступен. Проверьте, что сервис запущен и доступен по
          адресу <code>/api/roles</code>.
        </Callout>
      )}

      {state === 'ready' && roles.length === 0 && (
        <Callout tone="info" title="Ролей пока нет">
          Backend не вернул ни одной роли пайплайна.
        </Callout>
      )}

      {state === 'ready' && roles.length > 0 && (
        <div className={styles.tree}>
          {tree.sections.map(({ group, roles: groupRoles }) => (
            <div key={group.id} className={styles.group}>
              <div className={styles.groupHead}>
                {renamingId === group.id ? (
                  <div className={styles.renameRow}>
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input
                      className={styles.textInput}
                      aria-label={`Название группы «${group.name}»`}
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoComplete="off"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(group);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      iconOnly
                      leftIcon={<Check size={16} aria-hidden="true" />}
                      onClick={() => void saveRename(group)}
                      loading={savingRename}
                      aria-label="Сохранить название группы"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      leftIcon={<X size={16} aria-hidden="true" />}
                      onClick={() => setRenamingId(null)}
                      aria-label="Отменить переименование"
                    />
                  </div>
                ) : (
                  <>
                    <h3 className={styles.groupTitle}>
                      {group.name}
                      <span className={styles.groupCount}>{groupRoles.length}</span>
                    </h3>
                    <div className={styles.groupActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        leftIcon={<Pencil size={15} aria-hidden="true" />}
                        onClick={() => startRename(group)}
                        aria-label={`Переименовать группу «${group.name}»`}
                        title="Переименовать группу"
                      />
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        iconOnly
                        leftIcon={<Trash2 size={15} aria-hidden="true" />}
                        onClick={() => setConfirmDelete(group)}
                        aria-label={`Удалить группу «${group.name}»`}
                        title="Удалить группу (роли уйдут в «Прочее»)"
                      />
                    </div>
                  </>
                )}
              </div>

              {groupRoles.length > 0 ? (
                <ul className={styles.list}>{groupRoles.map(renderRoleRow)}</ul>
              ) : (
                <p className={styles.emptyGroup}>В этой группе пока нет ролей.</p>
              )}
            </div>
          ))}

          {tree.ungrouped.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <h3 className={styles.groupTitle}>
                  Прочее
                  <span className={styles.groupCount}>{tree.ungrouped.length}</span>
                </h3>
              </div>
              <ul className={styles.list}>{tree.ungrouped.map(renderRoleRow)}</ul>
            </div>
          )}

          <div className={styles.addGroupRow}>
            <input
              className={styles.textInput}
              aria-label="Название новой группы"
              placeholder="Название новой группы"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateGroup();
              }}
            />
            <Button
              variant="secondary"
              leftIcon={<Plus size={16} aria-hidden="true" />}
              onClick={() => void handleCreateGroup()}
              loading={creatingGroup}
              disabled={newGroupName.trim() === ''}
            >
              Добавить группу
            </Button>
          </div>
        </div>
      )}

      <RoleCardModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        role={editing}
        groups={groups}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete ? `Удалить группу «${confirmDelete.name}»?` : 'Удалить группу?'}
        description="Роли этой группы не удаляются — они вернутся в «Прочее». Группу можно создать заново."
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        onConfirm={() => confirmDelete && void deleteGroup(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </Section>
  );
}

/** Сортировка групп по sort_order, затем по имени. */
function byOrder(a: RoleGroup, b: RoleGroup): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}
