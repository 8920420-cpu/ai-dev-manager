import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, FileText, Plus, Trash2, Upload } from 'lucide-react';
import {
  Button,
  Callout,
  ConfirmDialog,
  LoadingBlock,
  Modal,
  Select,
  Textarea,
  useToast,
} from '../../components/ui';
import { rolesApi } from '../../api/rolesApi';
import { toolsApi } from '../../api/toolsApi';
import {
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_LABEL,
  type RoleCard,
  type RoleCardPatch,
  type RoleGroup,
  type SkillFile,
  type Tool,
  type ToolCapability,
} from '../../types/settings';
import { RoleFieldsModal } from './RoleFieldsModal';
import styles from './RoleCardModal.module.css';

interface RoleCardModalProps {
  open: boolean;
  onClose: () => void;
  /** Карточка роли для редактирования (null/закрыто — модалка не работает). */
  role: RoleCard | null;
  /** Доступные смысловые группы (для выбора группы роли). */
  groups: RoleGroup[];
  /** Сохранённая карточка приходит обратно — родитель обновляет список. */
  onSaved: (role: RoleCard) => void;
}

/**
 * Модальное окно карточки роли: краткое описание, смысловая группа, рабочий
 * промт и список подключённых skill-файлов.
 *
 * Закрывается ТОЛЬКО явной видимой кнопкой (крестик / «Отмена» / «Сохранить») —
 * overlay и Escape намеренно не закрывают (общее правило TASKS.md, см. Modal).
 */
export function RoleCardModal({ open, onClose, role, groups, onSaved }: RoleCardModalProps) {
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [groupId, setGroupId] = useState<string>('');
  const [skills, setSkills] = useState<string[]>([]);
  // Уровни доступа роли (чекбоксы) и назначенные MCP-инструменты.
  const [capabilities, setCapabilities] = useState<ToolCapability[]>([]);
  const [mcpToolIds, setMcpToolIds] = useState<string[]>([]);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const loadedCaps = useRef<string>('[]');
  const loadedMcp = useRef<string>('[]');

  const [available, setAvailable] = useState<SkillFile[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  /** Выбор skill в выпадающем списке «Добавить». */
  const [pendingSkill, setPendingSkill] = useState('');

  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Открыто окно контракта данных роли (входящие/исходящие поля). */
  const [fieldsOpen, setFieldsOpen] = useState(false);
  /** Загрузка skill-файла с ПК пользователя. */
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Сброс формы и загрузка доступных skills при каждом открытии.
  useEffect(() => {
    if (!open || !role) return;
    setDescription(role.description ?? '');
    setPrompt(role.prompt ?? '');
    setGroupId(role.groupId ?? '');
    setSkills([...(role.skills ?? [])]);
    setPendingSkill('');
    setSaving(false);
    setConfirmClose(false);
    setFieldsOpen(false);

    const ctrl = new AbortController();
    setLoadingSkills(true);
    setSkillsError(false);
    rolesApi
      .listSkills(ctrl.signal)
      .then((list) => setAvailable(list))
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setSkillsError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoadingSkills(false);
      });

    // Инструменты: реестр + уровни доступа роли + назначенные MCP.
    Promise.all([
      toolsApi.list(ctrl.signal),
      toolsApi.getCapabilities(role.code, ctrl.signal),
      toolsApi.getRoleTools(role.code, ctrl.signal),
    ])
      .then(([tools, caps, mcpIds]) => {
        if (ctrl.signal.aborted) return;
        setAllTools(tools);
        setCapabilities(caps);
        setMcpToolIds(mcpIds);
        loadedCaps.current = JSON.stringify([...caps].sort());
        loadedMcp.current = JSON.stringify([...mcpIds].sort());
      })
      .catch(() => {
        /* инструменты недоступны — карточка остаётся рабочей без них */
      });

    return () => ctrl.abort();
  }, [open, role]);

  const isDirty = useMemo(() => {
    if (!role) return false;
    return (
      description !== (role.description ?? '') ||
      prompt !== (role.prompt ?? '') ||
      groupId !== (role.groupId ?? '') ||
      JSON.stringify(skills) !== JSON.stringify(role.skills ?? []) ||
      JSON.stringify([...capabilities].sort()) !== loadedCaps.current ||
      JSON.stringify([...mcpToolIds].sort()) !== loadedMcp.current
    );
  }, [role, description, prompt, groupId, skills, capabilities, mcpToolIds]);

  function toggleCapability(cap: ToolCapability) {
    setCapabilities((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));
  }

  function toggleMcp(id: string) {
    setMcpToolIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const mcpTools = useMemo(() => allTools.filter((t) => t.kind === 'mcp'), [allTools]);

  /** Skills, которые ещё не подключены к роли (можно добавить). */
  const addableSkills = useMemo(
    () => available.filter((s) => !skills.includes(s.id)),
    [available, skills],
  );

  /** Отображаемое имя skill по id (или сам id, если файла больше нет в каталоге). */
  function skillName(id: string): string {
    return available.find((s) => s.id === id)?.name ?? id;
  }

  function requestClose() {
    if (saving) return;
    if (isDirty) setConfirmClose(true);
    else onClose();
  }

  function addSkill() {
    const id = pendingSkill.trim();
    if (!id) return;
    // Дубли запрещены контрактом — защищаемся и на клиенте.
    if (skills.includes(id)) {
      toast.info('Этот skill уже подключён');
      return;
    }
    setSkills((prev) => [...prev, id]);
    setPendingSkill('');
  }

  function removeSkill(id: string) {
    setSkills((prev) => prev.filter((s) => s !== id));
  }

  /**
   * Загрузить skill-файл с ПК: читаем содержимое, отправляем на сервер (он кладёт
   * файл в каталог skills) и сразу подключаем полученный id к роли.
   */
  async function uploadFromPc(file: File) {
    setUploading(true);
    try {
      const content = await file.text();
      const created = await rolesApi.uploadSkill(file.name, content);
      setAvailable((prev) =>
        prev.some((s) => s.id === created.id) ? prev : [...prev, created],
      );
      setSkills((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      toast.success(`Skill «${created.name}» загружен и подключён`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить skill-файл');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!role) return;
    setSaving(true);
    try {
      const patch: RoleCardPatch = {
        description: description.trim(),
        // Промт хранится в БД (roles.prompt) и используется как есть.
        prompt: prompt.trim(),
        // '' = открепить от группы («Прочее»).
        groupId: groupId || null,
        skills,
      };
      const saved = await rolesApi.update(role.code, patch);
      // Уровни доступа и назначенные MCP-инструменты сохраняем отдельными вызовами.
      await toolsApi.saveCapabilities(role.code, capabilities);
      await toolsApi.saveRoleTools(role.code, mcpToolIds);
      onSaved(saved);
      toast.success(`Роль «${saved.name}» сохранена`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить роль');
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        open={open && role !== null}
        onClose={requestClose}
        title={role ? `Роль: ${role.name}` : 'Роль'}
        subtitle={role ? `Канонический код: ${role.code}` : undefined}
        size="lg"
        footerStart={
          <Button
            variant="secondary"
            leftIcon={<Database size={16} aria-hidden="true" />}
            onClick={() => setFieldsOpen(true)}
            disabled={saving || !role}
          >
            Данные
          </Button>
        }
        footer={
          <>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить
            </Button>
          </>
        }
      >
        {role && (
          <div className={styles.form}>
            <Textarea
              label="Краткое описание"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Чем занимается роль в пайплайне"
              rows={2}
              maxLength={2000}
            />

            <Select
              label="Смысловая группа"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              helper="Только организация экрана ролей — на рантайм пайплайна не влияет."
            >
              <option value="">Прочее (без группы)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>

            <Textarea
              label="Рабочий промт"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="System-промт роли (хранится в БД). Для рассуждающих ролей не должен быть пустым."
              helper="Промт хранится в БД и отправляется модели как system. Для ИИ-ролей пустой промт = ошибка конфигурации."
              rows={8}
              maxLength={100000}
            />

            <section className={styles.skills} aria-labelledby="role-caps-title">
              <div className={styles.skillsHead}>
                <h3 className={styles.skillsTitle} id="role-caps-title">
                  Уровни доступа (инструменты)
                </h3>
              </div>
              <p className={styles.empty}>
                Что роль может делать с реальным проектом. Аналитик — обычно только «Читать»;
                программист — «Читать», «Изменять», «Создавать».
              </p>
              <div className={styles.capRow}>
                {TOOL_CAPABILITIES.map((cap) => (
                  <label key={cap} className={styles.capItem}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(cap)}
                      onChange={() => toggleCapability(cap)}
                    />
                    <span>{TOOL_CAPABILITY_LABEL[cap]}</span>
                  </label>
                ))}
              </div>

              {mcpTools.length > 0 && (
                <>
                  <div className={styles.skillsHead}>
                    <h3 className={styles.skillsTitle}>MCP-инструменты</h3>
                  </div>
                  <div className={styles.capRow}>
                    {mcpTools.map((t) => (
                      <label key={t.id} className={styles.capItem} title={t.description}>
                        <input
                          type="checkbox"
                          checked={mcpToolIds.includes(t.id)}
                          onChange={() => toggleMcp(t.id)}
                        />
                        <span>{t.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className={styles.skills} aria-labelledby="role-skills-title">
              <div className={styles.skillsHead}>
                <h3 className={styles.skillsTitle} id="role-skills-title">
                  Подключённые skills
                </h3>
              </div>

              {skills.length === 0 ? (
                <p className={styles.empty}>Пока не подключено ни одного skill-файла.</p>
              ) : (
                <ul className={styles.skillList}>
                  {skills.map((id) => (
                    <li key={id} className={styles.skillRow}>
                      <span className={styles.skillName} title={id}>
                        <FileText size={15} aria-hidden="true" />
                        {skillName(id)}
                      </span>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        iconOnly
                        leftIcon={<Trash2 size={15} aria-hidden="true" />}
                        onClick={() => removeSkill(id)}
                        aria-label={`Отключить skill «${skillName(id)}» от роли`}
                        title="Отключить от роли (файл не удаляется)"
                      />
                    </li>
                  ))}
                </ul>
              )}

              {loadingSkills ? (
                <LoadingBlock label="Загрузка доступных skills…" />
              ) : skillsError ? (
                <Callout tone="error" title="Не удалось загрузить список skills" live>
                  Проверьте доступность backend (<code>/api/skills</code>).
                </Callout>
              ) : addableSkills.length === 0 ? (
                <p className={styles.empty}>
                  {available.length === 0
                    ? 'На сервере нет доступных skill-файлов.'
                    : 'Все доступные skills уже подключены.'}
                </p>
              ) : (
                <div className={styles.addRow}>
                  <div className={styles.addSelect}>
                    <Select
                      label="Доступные skills"
                      value={pendingSkill}
                      onChange={(e) => setPendingSkill(e.target.value)}
                    >
                      <option value="">— выберите файл —</option>
                      {addableSkills.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.id})
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className={styles.addBtn}>
                    <Button
                      variant="secondary"
                      leftIcon={<Plus size={16} aria-hidden="true" />}
                      onClick={addSkill}
                      disabled={pendingSkill.trim() === ''}
                    >
                      Добавить
                    </Button>
                  </div>
                </div>
              )}

              {/* Загрузка skill с ПК — доступна всегда, даже если серверный
                  каталог пуст или все файлы уже подключены. */}
              <div className={styles.uploadRow}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt,text/markdown,text/plain"
                  className={styles.fileInput}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void uploadFromPc(file);
                  }}
                />
                <Button
                  variant="secondary"
                  leftIcon={<Upload size={16} aria-hidden="true" />}
                  onClick={() => fileInputRef.current?.click()}
                  loading={uploading}
                >
                  Добавить с ПК
                </Button>
                <span className={styles.uploadHint}>
                  Файл <code>.md</code> или <code>.txt</code> с рабочего ПК — будет
                  использоваться вместе с ролью.
                </span>
              </div>
            </section>
          </div>
        )}
      </Modal>

      <RoleFieldsModal
        open={fieldsOpen}
        onClose={() => setFieldsOpen(false)}
        roleCode={role?.code ?? null}
        roleName={role?.name}
      />

      <ConfirmDialog
        open={confirmClose}
        title="Закрыть без сохранения?"
        description="Изменения карточки роли не будут сохранены."
        confirmLabel="Закрыть"
        cancelLabel="Продолжить редактирование"
        tone="danger"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  );
}
