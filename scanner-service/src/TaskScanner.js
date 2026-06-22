import { watch } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const COMPLETED_STATUSES = new Set(['выполнено', 'done', 'completed']);

/**
 * Наблюдает за JSON-документом, находя новые завершённые задачи.
 * Успешно переданные task id сохраняются отдельно, поэтому повторная запись
 * документа или перезапуск процесса не запускают цепочку второй раз.
 */
export class TaskScanner {
  constructor({ documentPath, statePath, dispatch, debounceMs = 150, fallbackMs = 5000, clearOnDispatch = true, log = console } = {}) {
    if (!documentPath) throw new Error('documentPath is required');
    if (typeof dispatch !== 'function') throw new Error('dispatch must be a function');
    this.documentPath = resolve(documentPath);
    this.documentName = basename(this.documentPath);
    this.statePath = resolve(statePath ?? `${this.documentPath}.scanner-state.json`);
    this.dispatch = dispatch;
    // После подтверждённой доставки удалить завершённую запись из документа,
    // освобождая слот: иначе «выполнено» висит вечно и Claude не берёт новое.
    this.clearOnDispatch = clearOnDispatch !== false;
    this.debounceMs = Number(debounceMs) > 0 ? Number(debounceMs) : 150;
    // Резервный опрос: страховка на случай, если события fs.watch не доходят
    // (bind-mount в Docker на Windows/Mac не пробрасывает inotify). 0 — выключить.
    this.fallbackMs = Number(fallbackMs) >= 0 ? Number(fallbackMs) : 5000;
    this.log = log;
    this.watcher = null;
    this.debounceTimer = null;
    this.fallbackTimer = null;
    this.scanning = false;
  }

  async scanOnce() {
    if (this.scanning) return { skipped: true, reason: 'scan_in_progress' };
    this.scanning = true;
    try {
      const document = parseDocument(await readFile(this.documentPath, 'utf8'));
      const state = await this.#readState();
      const completed = document.tasks.filter(isCompletedTask);
      const dispatched = [];

      for (const task of completed) {
        if (state.dispatched[task.id]) continue;
        const payload = normalizeTask(task, this.documentPath);
        // Сначала подтверждённая запись в БД (dispatch), и только потом —
        // удаление из файла. Падение между ними безопасно: БД идемпотентна
        // (scanner_dispatches), повторный проход вернёт duplicate и доудалит.
        await this.dispatch(payload);
        state.dispatched[task.id] = {
          dispatchedAt: new Date().toISOString(),
          service: payload.service,
          nextRole: payload.nextRole,
        };
        await this.#writeState(state);
        dispatched.push(task.id);
      }

      const cleared = this.clearOnDispatch ? await this.#clearDispatched(dispatched) : [];
      return { scanned: document.tasks.length, completed: completed.length, dispatched, cleared };
    } finally {
      this.scanning = false;
    }
  }

  start() {
    if (this.watcher) return;
    // Сканируем сразу: документ мог уже содержать завершённые задачи до старта.
    void this.#run();
    // Следим за каталогом, а не за файлом: атомарная запись (temp + rename)
    // подменяет inode, и watcher по самому файлу после этого перестаёт срабатывать.
    this.watcher = watch(dirname(this.documentPath), (_eventType, filename) => {
      // Реагируем только на сам документ; собственные записи state-файла игнорируем.
      if (filename && basename(String(filename)) !== this.documentName) return;
      this.#schedule();
    });
    this.watcher.on('error', (error) => this.log.error?.('Scanner watch failed', { error: error.message }));
    // Редкий резервный проход — scanOnce идемпотентен, лишних отправок не будет.
    if (this.fallbackMs > 0) {
      this.fallbackTimer = setInterval(() => this.#schedule(), this.fallbackMs);
      this.fallbackTimer.unref?.();
    }
  }

  stop() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  // Дебаунс: одно сохранение файла на разных платформах рождает несколько
  // событий, поэтому схлопываем их в один проход после паузы тишины.
  #schedule() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.#run();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  async #run() {
    try {
      const result = await this.scanOnce();
      if (result.dispatched?.length) this.log.info?.('Scanner dispatched tasks', result);
    } catch (error) {
      // Документа может ещё не быть — это не ошибка, просто ждём первой записи.
      if (error.code !== 'ENOENT') this.log.error?.('Scanner scan failed', { error: error.message });
    }
  }

  // Освободить слот: атомарно read-modify-write документа, убрав из него
  // только что доставленные записи. Re-read перед записью обязателен — между
  // dispatch и сюда Claude мог переписать файл; чужие правки не затираем.
  async #clearDispatched(ids) {
    if (!ids.length) return [];
    const remove = new Set(ids);
    let document;
    try {
      document = parseDocument(await readFile(this.documentPath, 'utf8'));
    } catch (error) {
      // Файл исчез/побит между сканом и очисткой — нечего удалять, не падаем.
      this.log.warn?.('Scanner clear skipped', { error: error.message });
      return [];
    }
    // Удаляем запись, только если она на диске всё ещё завершена: если Claude
    // успел сбросить статус или подменить задачу, оставляем как есть.
    const kept = document.tasks.filter((task) => !(remove.has(task.id) && isCompletedTask(task)));
    const cleared = document.tasks.length - kept.length;
    if (!cleared) return [];
    await writeFileAtomic(this.documentPath, `${JSON.stringify({ ...document, tasks: kept }, null, 2)}\n`);
    return ids.filter((id) => document.tasks.some((t) => t.id === id && isCompletedTask(t)));
  }

  async #readState() {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8'));
      return { version: 1, dispatched: value?.dispatched ?? {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, dispatched: {} };
      throw new Error(`Invalid scanner state ${this.statePath}: ${error.message}`);
    }
  }

  async #writeState(state) {
    await writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

// Атомарная запись: пишем во временный файл рядом и rename поверх цели.
// rename атомарен в пределах ФС, поэтому читатель (watcher/Claude) видит либо
// старое, либо новое содержимое целиком — без полузаписанного JSON.
export async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

export function parseDocument(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Task document is not valid JSON: ${error.message}`);
  }
  if (value?.version !== 1) throw new Error('Task document version must be 1');
  if (!Array.isArray(value.tasks)) throw new Error('Task document must contain tasks[]');
  const ids = new Set();
  for (const task of value.tasks) {
    if (!task || typeof task !== 'object') throw new Error('Each task must be an object');
    const id = String(task.id ?? '').trim();
    if (!id) throw new Error('Each task must have id');
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
  }
  return value;
}

function isCompletedTask(task) {
  return COMPLETED_STATUSES.has(String(task.status ?? '').trim().toLocaleLowerCase('ru-RU'));
}

function normalizeTask(task, sourceDocument) {
  const required = (key) => {
    const value = String(task[key] ?? '').trim();
    if (!value) throw new Error(`Completed task ${task.id} must have ${key}`);
    return value;
  };
  return {
    completionKey: required('id'),
    taskId: required('id'),
    project: required('project'),
    service: required('service'),
    title: required('title'),
    status: 'completed',
    result: String(task.result ?? '').trim(),
    changedFiles: Array.isArray(task.changedFiles) ? task.changedFiles.map(String) : [],
    completedAt: task.completedAt ?? new Date().toISOString(),
    sourceDocument,
    nextRole: 'TASK_REVIEWER',
  };
}
